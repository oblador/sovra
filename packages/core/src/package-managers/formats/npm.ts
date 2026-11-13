import type { DependencyGraph, ResolvedPackage } from '../graph';
import { type LockfileFormat, type ParseInput, manifestDeps } from './types';

interface NpmEntry {
  name?: string;
  version?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

type Packages = Record<string, NpmEntry>;

/** Name of the package installed at a `node_modules/...` lock path. */
function nameFromPath(p: string, entry?: NpmEntry): string {
  if (entry?.name) return entry.name;
  const marker = 'node_modules/';
  const idx = p.lastIndexOf(marker);
  return idx === -1 ? p : p.slice(idx + marker.length);
}

/** The enclosing module scope of a lock path (strip the trailing `/node_modules/<pkg>`). */
function parentDir(p: string): string {
  const idx = p.lastIndexOf('/node_modules/');
  return idx === -1 ? '' : p.slice(0, idx);
}

/** npm's nearest-ancestor `node_modules` resolution for `dep` requested from `fromPath`. */
function resolve(pkgs: Packages, fromPath: string, dep: string): string | undefined {
  let dir = fromPath;
  for (;;) {
    const cand = dir === '' ? `node_modules/${dep}` : `${dir}/node_modules/${dep}`;
    if (pkgs[cand]) return cand;
    if (dir === '') return undefined;
    dir = parentDir(dir);
  }
}

function keyFor(pkgs: Packages, p: string): string {
  const entry = pkgs[p];
  return `${nameFromPath(p, entry)}@${entry?.version ?? ''}`;
}

/** Parser for npm `package-lock.json` / `npm-shrinkwrap.json` v2/v3 (the `packages` map). */
export const npmFormat: LockfileFormat = {
  name: 'npm',
  parse({ lockfile, manifest, importerPath }: ParseInput): DependencyGraph {
    const lock = JSON.parse(lockfile) as { packages?: Packages };
    const pkgs = lock.packages;
    if (!pkgs) {
      throw new Error(
        'unsupported npm lockfile: expected lockfileVersion 2/3 with a "packages" map',
      );
    }

    const packages = new Map<string, ResolvedPackage>();
    for (const [p, entry] of Object.entries(pkgs)) {
      if (p === '' || entry.link) continue; // root and workspace symlinks handled via roots
      const name = nameFromPath(p, entry);
      const version = entry.version ?? '';
      const key = `${name}@${version}`;
      const dependencies = new Map<string, string>();
      for (const field of ['dependencies', 'optionalDependencies'] as const) {
        const obj = entry[field];
        if (!obj) continue;
        for (const dep of Object.keys(obj)) {
          const targetPath = resolve(pkgs, p, dep);
          if (targetPath) dependencies.set(dep, keyFor(pkgs, targetPath));
        }
      }
      // Peers resolve precisely via the same nearest-ancestor walk (they're
      // satisfied by a hoisted install). Tracked as propagation-only edges so a
      // peer bump marks this package affected without joining its import surface.
      const peers: string[] = [];
      for (const peer of Object.keys(entry.peerDependencies ?? {})) {
        const targetPath = resolve(pkgs, p, peer);
        if (targetPath) peers.push(keyFor(pkgs, targetPath));
      }
      const existing = packages.get(key);
      if (existing) {
        for (const [n, t] of dependencies) existing.dependencies.set(n, t);
        if (peers.length > 0) existing.peers = [...(existing.peers ?? []), ...peers];
      } else {
        packages.set(key, {
          key,
          name,
          version,
          dependencies,
          ...(peers.length > 0 ? { peers } : {}),
        });
      }
    }

    // Direct deps: prefer the project manifest, falling back to the root entry.
    const rootEntry = pkgs[''] ?? {};
    let names = [...manifestDeps(manifest).keys()];
    if (names.length === 0) {
      names = [
        ...Object.keys(rootEntry.dependencies ?? {}),
        ...Object.keys(rootEntry.devDependencies ?? {}),
        ...Object.keys(rootEntry.optionalDependencies ?? {}),
      ];
    }
    const roots = new Map<string, string>();
    for (const name of names) {
      const targetPath =
        resolve(pkgs, importerPath, name) ?? resolve(pkgs, '', name);
      if (targetPath) roots.set(name, keyFor(pkgs, targetPath));
    }

    // The hoisted surface is exactly the top-level `node_modules/<name>` entries
    // (npm flattens one version of each name to the root); under hoisting any of
    // these is importable as a phantom dependency.
    const hoisted = new Map<string, string>();
    for (const [p, entry] of Object.entries(pkgs)) {
      if (
        !p.startsWith('node_modules/') ||
        p.indexOf('/node_modules/') !== -1 ||
        entry.link
      ) {
        continue;
      }
      hoisted.set(nameFromPath(p, entry), keyFor(pkgs, p));
    }

    return { packages, roots, hoisted };
  },
};
