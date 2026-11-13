import yaml from 'js-yaml';

import { type DependencyGraph, type ResolvedPackage, splitNameVersion } from '../graph';
import { type LockfileFormat, type ParseInput, manifestDeps } from './types';

interface BerryEntry {
  version?: string;
  resolution?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Turn a package.json range into a Berry descriptor range, defaulting to `npm:`. */
function descriptorRange(range: string): string {
  return /^[a-z]+:/.test(range) ? range : `npm:${range}`;
}

/** Parser for Yarn Berry (v2+) `yarn.lock` (YAML with `__metadata`). */
export const yarnBerryFormat: LockfileFormat = {
  name: 'yarn-berry',
  parse({ lockfile, manifest }: ParseInput): DependencyGraph {
    const lock = (yaml.load(lockfile) ?? {}) as Record<string, BerryEntry>;

    // Map every descriptor (`name@npm:range`) to its resolved entry.
    const resolution = new Map<string, BerryEntry>();
    for (const [combinedKey, entry] of Object.entries(lock)) {
      if (combinedKey === '__metadata') continue;
      for (const descriptor of combinedKey.split(', ')) {
        resolution.set(descriptor, entry);
      }
    }

    const entryName = (combinedKey: string, entry: BerryEntry): string =>
      splitNameVersion(entry.resolution ?? combinedKey.split(', ')[0]).name;
    const resolvedKey = (fallbackName: string, entry: BerryEntry): string =>
      `${splitNameVersion(entry.resolution ?? fallbackName).name}@${entry.version ?? ''}`;

    const packages = new Map<string, ResolvedPackage>();
    const byName = new Map<string, Set<string>>();
    const peerNamesByKey = new Map<string, string[]>();
    for (const [combinedKey, entry] of Object.entries(lock)) {
      if (combinedKey === '__metadata') continue;
      const name = entryName(combinedKey, entry);
      const version = entry.version ?? '';
      const key = `${name}@${version}`;
      if (packages.has(key)) continue;
      const dependencies = new Map<string, string>();
      for (const field of ['dependencies', 'optionalDependencies'] as const) {
        const obj = entry[field];
        if (!obj) continue;
        for (const [depName, range] of Object.entries(obj)) {
          const target = resolution.get(`${depName}@${range}`);
          if (target?.version) dependencies.set(depName, resolvedKey(depName, target));
        }
      }
      packages.set(key, { key, name, version, dependencies });
      (byName.get(name) ?? byName.set(name, new Set()).get(name)!).add(key);
      if (entry.peerDependencies) {
        peerNamesByKey.set(key, Object.keys(entry.peerDependencies));
      }
    }

    // Peers don't resolve to a concrete version in a Berry lockfile (they're
    // satisfied by the consumer), so bind each peer to *every* resolved instance
    // of that name: a bump of any of them marks the peer-declaring package
    // affected — so a test importing that package (not the peer) is selected.
    for (const [key, peerNames] of peerNamesByKey) {
      const peers: string[] = [];
      for (const peerName of peerNames) {
        const instances = byName.get(peerName);
        if (!instances) continue;
        for (const instanceKey of instances) {
          if (instanceKey !== key) peers.push(instanceKey);
        }
      }
      if (peers.length > 0) packages.get(key)!.peers = peers;
    }

    const roots = new Map<string, string>();
    for (const [name, range] of manifestDeps(manifest)) {
      const target = resolution.get(`${name}@${descriptorRange(range)}`);
      if (target?.version) roots.set(name, resolvedKey(name, target));
    }

    return { packages, roots };
  },
};
