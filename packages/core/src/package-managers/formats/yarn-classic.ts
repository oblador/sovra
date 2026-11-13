import { parse as parseYarnLock } from '@yarnpkg/lockfile';

import { type DependencyGraph, type ResolvedPackage, splitNameVersion } from '../graph';
import { type LockfileFormat, type ParseInput, manifestDeps } from './types';

/**
 * Parser for Yarn Classic (v1) `yarn.lock`.
 *
 * Known limitation: peer dependencies are not modeled. Yarn v1 does not record
 * `peerDependencies` in the lockfile, so a peer bump can't be propagated to the
 * package that declares the peer. (npm, yarn berry and pnpm do capture peers —
 * see their parsers.) In practice the peer is also a real installed dependency,
 * so it still surfaces on its own; only a test importing the peer-*declaring*
 * package without importing the peer itself could be missed.
 */
export const yarnClassicFormat: LockfileFormat = {
  name: 'yarn-classic',
  parse({ lockfile, manifest }: ParseInput): DependencyGraph {
    const parsed = parseYarnLock(lockfile);
    if (parsed.type !== 'success') {
      throw new Error(`yarn.lock parse failed (${parsed.type})`);
    }
    const object = parsed.object;

    // Map every `name@range` specifier to its resolved entry. v1 resolution is
    // global (no nesting), so one flat map suffices for transitive lookups.
    const resolution = new Map<string, { version: string }>();
    for (const [combinedKey, entry] of Object.entries(object)) {
      for (const spec of combinedKey.split(', ')) resolution.set(spec, entry);
    }

    const packages = new Map<string, ResolvedPackage>();
    for (const [combinedKey, entry] of Object.entries(object)) {
      const firstSpec = combinedKey.split(', ')[0];
      const name = splitNameVersion(firstSpec).name;
      const version = entry.version;
      const key = `${name}@${version}`;
      if (packages.has(key)) continue;
      const dependencies = new Map<string, string>();
      for (const field of ['dependencies', 'optionalDependencies'] as const) {
        const obj = entry[field];
        if (!obj) continue;
        for (const [depName, range] of Object.entries(obj)) {
          const target = resolution.get(`${depName}@${range}`);
          if (target) dependencies.set(depName, `${depName}@${target.version}`);
        }
      }
      packages.set(key, { key, name, version, dependencies });
    }

    const roots = new Map<string, string>();
    for (const [name, range] of manifestDeps(manifest)) {
      const target = resolution.get(`${name}@${range}`);
      if (target) roots.set(name, `${name}@${target.version}`);
    }

    return { packages, roots };
  },
};
