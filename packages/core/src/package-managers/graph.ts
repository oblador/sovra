/**
 * A package-manager-agnostic model of a *resolved* dependency graph, plus the
 * version-aware diff that powers transitive dependency-change detection.
 *
 * The whole point of modelling the resolved graph (rather than a flat list of
 * package names) is version specificity: `x` depending on `y@1.0` and `z`
 * depending on `y@2.0` point at two *different* instances. Bumping `y@1.0` makes
 * `x` affected but leaves `z` untouched, because they never shared a node.
 */

/** A single resolved package instance — a specific name at a specific version. */
export interface ResolvedPackage {
  /**
   * Stable identity of this instance, unique within a graph and comparable
   * across the base/head graphs. By convention `name@version` (including any
   * peer-dependency suffix the package manager encodes), so a version bump
   * yields a different key.
   */
  key: string;
  name: string;
  version: string;
  /** Resolved edges: importable dependency name -> key of the instance it resolves to. */
  dependencies: Map<string, string>;
  /**
   * Extra propagation edges for peer dependencies: keys of the instances this
   * package binds its peers to. Kept separate from {@link dependencies} because
   * peers are *not* part of this package's own importable surface — they only
   * mean "if the peer changes, this package is affected" (so a test importing
   * this package, not the peer, is still selected). See the npm/berry parsers.
   */
  peers?: string[];
}

/** A resolved dependency graph for one project/importer. */
export interface DependencyGraph {
  /** Every resolved instance, keyed by {@link ResolvedPackage.key}. */
  packages: Map<string, ResolvedPackage>;
  /**
   * The project's *direct* dependencies — the names importable under an
   * **isolated** linker (pnpm default) — mapped to the resolved instance key.
   */
  roots: Map<string, string>;
  /**
   * The **hoisted** top-level importable surface: name -> key of the single
   * instance flattened to the top-level `node_modules`. Populated only when the
   * lockfile encodes the hoisted tree precisely (npm). Absent otherwise; the
   * decider falls back to the conservative "all affected names" surface.
   */
  hoisted?: Map<string, string>;
}

/**
 * Which importable surface to translate affected instances into names against.
 * - `direct`: declared direct deps (isolated linkers — pnpm default).
 * - `hoisted`: the precise top-level hoisted set (npm).
 * - `all`: every affected instance's name (conservative — hoisted linkers whose
 *   lockfile doesn't pin which version was hoisted, e.g. yarn).
 */
export type AffectedSurface = 'direct' | 'hoisted' | 'all';

export function emptyGraph(): DependencyGraph {
  return { packages: new Map(), roots: new Map() };
}

function sameEdges(a: ResolvedPackage, b: ResolvedPackage): boolean {
  if (a.dependencies.size !== b.dependencies.size) return false;
  for (const [name, target] of a.dependencies) {
    if (b.dependencies.get(name) !== target) return false;
  }
  const ap = a.peers ?? [];
  const bp = b.peers ?? [];
  if (ap.length !== bp.length) return false;
  if (ap.length > 0) {
    const bset = new Set(bp);
    for (const key of ap) if (!bset.has(key)) return false;
  }
  return true;
}

/**
 * The set of resolved instance keys affected by the change from `base` to
 * `head`: locally-changed instances plus everything that transitively depends
 * on them.
 *
 * 1. A head instance is *locally changed* if its key is absent from base (new
 *    instance or version bump) or its resolved edges differ from base's
 *    same-key instance (a dependency was added/removed/re-resolved).
 * 2. Propagate up the dependents (reverse-edge BFS; cycle-safe).
 */
export function affectedInstanceKeys(
  base: DependencyGraph,
  head: DependencyGraph,
): Set<string> {
  const locallyChanged: string[] = [];
  const dependents = new Map<string, string[]>();
  const addEdge = (target: string, key: string) => {
    const list = dependents.get(target);
    if (list) list.push(key);
    else dependents.set(target, [key]);
  };
  for (const [key, pkg] of head.packages) {
    const basePkg = base.packages.get(key);
    if (!basePkg || !sameEdges(basePkg, pkg)) locallyChanged.push(key);
    for (const target of pkg.dependencies.values()) addEdge(target, key);
    if (pkg.peers) for (const target of pkg.peers) addEdge(target, key);
  }

  const affected = new Set<string>(locallyChanged);
  const queue = [...locallyChanged];
  while (queue.length > 0) {
    const key = queue.pop() as string;
    for (const dependent of dependents.get(key) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return affected;
}

/**
 * Compute the importable dependency *names* affected by the change from `base`
 * to `head`, version-aware and transitive. The `surface` selects which
 * importable names the affected instances are projected onto — see
 * {@link AffectedSurface}; it should reflect the package manager's linker
 * (isolated vs hoisted). Defaults to `direct` (isolated). Public hoist patterns
 * can additionally expose selected transitive names.
 */
export function affectedDependencies(
  base: DependencyGraph,
  head: DependencyGraph,
  options: { surface?: AffectedSurface; includeTransitive?: (name: string) => boolean } = {},
): string[] {
  const surface = options.surface ?? 'direct';
  const affected = affectedInstanceKeys(base, head);
  const names = new Set<string>();

  const includeTransitive = surface === 'all' ? () => true : options.includeTransitive;
  if (includeTransitive) {
    // Hoisted names can be imported even without a declared root dependency.
    for (const key of affected) {
      const pkg = head.packages.get(key);
      if (pkg && includeTransitive(pkg.name)) names.add(pkg.name);
    }
    // Removed transitive packages may have been publicly hoisted too.
    for (const [key, pkg] of base.packages) {
      if (!head.packages.has(key) && includeTransitive(pkg.name)) names.add(pkg.name);
    }
  }

  // Also preserve import aliases and root remaps when collecting all names.
  const headSurface =
    surface === 'hoisted' ? (head.hoisted ?? head.roots) : head.roots;
  const baseSurface =
    surface === 'hoisted' ? (base.hoisted ?? base.roots) : base.roots;
  for (const [name, key] of headSurface) {
    if (baseSurface.get(name) !== key || affected.has(key)) names.add(name);
  }
  for (const name of baseSurface.keys()) {
    if (!headSurface.has(name)) names.add(name); // removed
  }
  return [...names];
}

/** Split a `name@version` style key into its name and version parts. */
export function splitNameVersion(spec: string): { name: string; version: string } {
  // Scoped packages start with '@'; the separating '@' is the one after the
  // (optional) scope/name, i.e. the first '@' at index > 0.
  const at = spec.indexOf('@', 1);
  if (at === -1) return { name: spec, version: '' };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}
