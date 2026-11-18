import { type DependencyGraph, type ResolvedPackage, splitNameVersion } from '../graph';

interface Reference {
  version: string;
  with?: Record<string, ReferenceValue>;
}

type ReferenceValue = string | Reference;
type Dependency = string | { specifier?: string; version?: string; with?: Reference['with'] };
type Dependencies = Record<string, Dependency>;

interface Entry {
  dependencies?: Dependencies;
  optionalDependencies?: Dependencies;
  // A string is an unbound peer's declared range, never its resolved version.
  peerDependencies?: Record<string, Dependency>;
}

interface Project extends Entry {
  name?: string;
  devDependencies?: Dependencies;
}

export interface PnpmV13Lock {
  projects?: Record<string, Project>;
  packages?: Record<string, Entry & { snapshots?: Entry[] }>;
  settings?: {
    catalogs?: Record<string, Dependencies>;
    patchedDependencies?: Record<string, { hash: string }>;
  };
}

interface Scope {
  refs: Map<string, Reference>;
  children: Map<string, Instance>;
  parent?: Scope;
}

interface Instance extends Scope {
  base: string;
  key: string;
  name: string;
  version: string;
  bindings: Map<string, Reference>;
  dependencies: Map<string, Reference>;
}

function reference(value: ReferenceValue): Reference {
  return typeof value === 'string' ? { version: value } : value;
}

/** v13 aliases use `name@version`; plain versions use the importable name. */
function packageKey(name: string, version: string): string {
  const ref = version.replace(/^npm:/, '');
  return /^(?:@[^/]+\/)?[^/@:]+@/.test(ref) ? ref : `${name}@${ref}`;
}

function isLink(ref: Reference): boolean {
  return ref.version.startsWith('link:');
}

function boundPeers(entry: Entry): Map<string, Reference> {
  return new Map(Object.entries(entry.peerDependencies ?? {}).flatMap(([name, dep]) =>
    typeof dep !== 'string' && dep.version ? [[name, { version: dep.version, with: dep.with }]] : [],
  ));
}

/** Stable across snapshot ordering and hoisting of common fields. */
function peerSuffix(bindings: Map<string, Reference>): string {
  return [...bindings].sort(([a], [b]) => a.localeCompare(b)).map(([name, ref]) => {
    const nested = new Map(Object.entries(ref.with ?? {}).map(([peer, value]) => [peer, reference(value)]));
    const suffix = ref.with && nested.size === 0 ? '(with={})' : peerSuffix(nested);
    return `(${packageKey(name, ref.version)}${suffix})`;
  }).join('');
}

function namesBinding(wanted: Reference, actual: Reference): boolean {
  if (wanted.version !== actual.version) return false;
  if (wanted.with === undefined) return true;
  const actualBindings = actual.with ?? {};
  return Object.keys(wanted.with).length === Object.keys(actualBindings).length &&
    Object.entries(wanted.with).every(([name, ref]) => actualBindings[name] !== undefined &&
      namesBinding(reference(ref), reference(actualBindings[name])) &&
      namesBinding(reference(actualBindings[name]), reference(ref)));
}

/** Read the experimental v13 graph: https://github.com/pnpm/pnpm/tree/main/pnpm/crates/lockfile/src/next_format */
export function parsePnpmV13(lock: PnpmV13Lock, importerPath: string): DependencyGraph {
  const byPackage = new Map<string, Instance[]>();
  const projects = new Map<string, Scope>();

  function impliedVersion(name: string, specifier: string): string {
    if (specifier.startsWith('catalog:')) {
      const catalog = specifier.slice('catalog:'.length) || 'default';
      const entry = lock.settings?.catalogs?.[catalog]?.[name];
      if (!entry) throw new Error(`Invalid pnpm v13 lockfile: missing catalog ${catalog}/${name}`);
      const spec = typeof entry === 'string' ? entry : entry.specifier;
      const version = typeof entry === 'string' ? undefined : entry.version;
      if (spec?.startsWith('npm:')) {
        const target = splitNameVersion(spec.slice(4));
        return `${target.name}@${version ?? target.version}`;
      }
      const resolved = version ?? spec;
      if (resolved) return resolved;
      throw new Error(`Invalid pnpm v13 lockfile: unresolved catalog ${catalog}/${name}`);
    }
    if (specifier.startsWith('workspace:')) {
      const target = splitNameVersion(specifier.slice('workspace:'.length));
      const realName = target.version ? target.name : name;
      const injected = Object.keys(lock.packages ?? {}).filter(key => key.startsWith(`${realName}@file:`));
      if (injected.length === 1) return injected[0];
      // Linked workspace projects are source dependencies, as in v5/v6/v9.
      if (Object.values(lock.projects ?? {}).some(project => project.name === realName)) {
        return `link:${realName}`;
      }
      throw new Error(`Invalid pnpm v13 lockfile: unresolved workspace dependency ${name}`);
    }
    return specifier.replace(/^npm:/, '');
  }

  function dependencies(fields: (Dependencies | undefined)[], project = false): Map<string, Reference> {
    const result = new Map<string, Reference>();
    for (const field of fields) {
      for (const [name, dep] of Object.entries(field ?? {})) {
        const version = typeof dep === 'string' ? impliedVersion(name, dep)
          : dep.version ?? (project && dep.specifier ? impliedVersion(name, dep.specifier) : undefined);
        // Local packages can record a specifier without linking it in this snapshot.
        if (version) result.set(name, { version, with: typeof dep === 'string' ? undefined : dep.with });
        else if (project) throw new Error(`Invalid pnpm v13 lockfile: unresolved dependency ${name}`);
      }
    }
    return result;
  }

  for (const [base, entry] of Object.entries(lock.packages ?? {})) {
    const { name, version } = splitNameVersion(base);
    const commonBindings = boundPeers(entry);
    const commonDeps = dependencies([entry.dependencies, entry.optionalDependencies]);
    const variants = entry.snapshots?.length ? entry.snapshots : [{}];
    // Include range patches for this name conservatively rather than miss
    // changes to patched code. Exact versions still distinguish instances.
    const patches = Object.entries(lock.settings?.patchedDependencies ?? {})
      .filter(([selector]) => {
        const target = splitNameVersion(selector);
        return selector === name || selector === base || target.name === name &&
          !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(target.version);
      })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, patch]) => `(patch_hash=${patch.hash})`).join('');
    const instances = variants.map(variant => {
      const bindings = new Map([...boundPeers(variant), ...commonBindings]);
      const deps = new Map([...dependencies([variant.dependencies, variant.optionalDependencies]), ...commonDeps]);
      return {
        base, name, version, key: base + patches + peerSuffix(bindings), bindings, dependencies: deps,
        refs: new Map([[name, { version }], ...bindings, ...deps]), children: new Map<string, Instance>(),
      };
    });
    byPackage.set(base, instances);
  }

  for (const [id, project] of Object.entries(lock.projects ?? {})) {
    projects.set(id, {
      refs: dependencies([project.dependencies, project.devDependencies, project.optionalDependencies], true),
      children: new Map(),
    });
  }

  function explicitlyNamed(candidates: Instance[], bindings: Reference['with']): Instance | undefined {
    if (bindings === undefined) return undefined;
    return candidates.filter(candidate => Object.entries(bindings).every(([name, wanted]) => {
      const actual = candidate.bindings.get(name);
      return actual !== undefined && namesBinding(reference(wanted), actual);
    })).sort((a, b) => a.bindings.size - b.bindings.size)[0];
  }

  function choose(name: string, ref: Reference, scope: Scope, peer = false): Instance | undefined {
    if (isLink(ref)) return undefined;
    const candidates = byPackage.get(packageKey(name, ref.version));
    if (!candidates?.length) return undefined; // Optional dependencies can be omitted.
    if (candidates.length === 1) return candidates[0];
    const named = explicitlyNamed(candidates, ref.with);
    if (named) return named;
    if (peer) {
      const visited = new Set<Scope>();
      for (let parent = scope.parent; parent && !visited.has(parent); parent = parent.parent) {
        visited.add(parent);
        const linked = parent.children.get(name);
        if (linked && candidates.includes(linked)) return linked;
        if ('name' in parent && parent.name === name && candidates.includes(parent as Instance)) {
          return parent as Instance;
        }
      }
    }
    let selected = candidates[0];
    let bestAgreed = -1;
    let bestAbsent = Infinity;
    for (const candidate of candidates) {
      let agreed = 0;
      let absent = 0;
      let mismatch = false;
      for (const [name, binding] of candidate.bindings) {
        const scoped = scope.refs.get(name);
        if (!scoped) absent++;
        else if (packageKey(name, scoped.version) === packageKey(name, binding.version)) agreed++;
        else { mismatch = true; break; }
      }
      if (!mismatch && (agreed > bestAgreed || agreed === bestAgreed && absent < bestAbsent)) {
        selected = candidate;
        bestAgreed = agreed;
        bestAbsent = absent;
      }
    }
    return selected;
  }

  const instances = [...byPackage.values()].flat();
  for (const [scope, deps] of [
    ...instances.map(instance => [instance, instance.dependencies] as const),
    ...[...projects.values()].map(project => [project, project.refs] as const),
  ]) {
    for (const [name, ref] of deps) {
      const child = choose(name, ref, scope);
      if (child) scope.children.set(name, child);
    }
  }

  // Peer providers come from the first parent that reaches a snapshot. Match
  // pnpm's sorted project traversal, with cycle-safe walks through dependencies.
  const visited = new Set<Instance>();
  function walk(scope: Scope): void {
    const queue: Instance[] = [];
    function reach(parent: Scope): void {
      for (const [, child] of [...parent.children].sort(([a], [b]) => a.localeCompare(b))) {
        if (!visited.has(child)) { child.parent ??= parent; queue.push(child); }
      }
    }
    reach(scope);
    while (queue.length) {
      const instance = queue.pop() as Instance;
      if (visited.has(instance)) continue;
      visited.add(instance);
      reach(instance);
    }
  }
  for (const [, project] of [...projects].sort(([a], [b]) => a.localeCompare(b))) walk(project);
  for (const instance of [...instances].sort((a, b) => a.base.localeCompare(b.base))) {
    if (!visited.has(instance)) { visited.add(instance); walk(instance); }
  }

  const packages = new Map<string, ResolvedPackage>();
  for (const instance of instances) {
    const deps = new Map<string, string>();
    for (const [name, ref] of instance.dependencies) {
      if (!isLink(ref)) deps.set(name, instance.children.get(name)?.key ?? packageKey(name, ref.version));
    }
    const peers = [...instance.bindings].map(([name, ref]) =>
      choose(name, ref, instance, true)?.key ?? packageKey(name, ref.version),
    );
    packages.set(instance.key, { key: instance.key, name: instance.name, version: instance.version, dependencies: deps, peers });
  }

  const importer = projects.get(importerPath || '.') ?? projects.get('.');
  const roots = new Map<string, string>();
  for (const [name, ref] of importer?.refs ?? []) {
    if (!isLink(ref)) roots.set(name, importer?.children.get(name)?.key ?? packageKey(name, ref.version));
  }
  return { packages, roots };
}
