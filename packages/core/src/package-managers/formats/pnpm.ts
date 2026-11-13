import yaml from 'js-yaml';

import { type DependencyGraph, type ResolvedPackage, splitNameVersion } from '../graph';
import type { LockfileFormat, ParseInput } from './types';

interface PnpmEntry {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PnpmImporter {
  dependencies?: Record<string, { version?: string } | string>;
  devDependencies?: Record<string, { version?: string } | string>;
  optionalDependencies?: Record<string, { version?: string } | string>;
}

interface PnpmLock {
  lockfileVersion?: string | number;
  importers?: Record<string, PnpmImporter>;
  packages?: Record<string, PnpmEntry>;
  snapshots?: Record<string, PnpmEntry>;
  dependencies?: Record<string, { version?: string } | string>;
  devDependencies?: Record<string, { version?: string } | string>;
}

/** Strip a leading `/` (pnpm v6 package keys carry one; v9 keys do not). */
function stripSlash(key: string): string {
  return key.startsWith('/') ? key.slice(1) : key;
}

/**
 * Normalize a pnpm package key into our `name@version(peers)` convention and
 * extract the human-readable name/version. Handles v5 (`/name/version`) and
 * v6/v9 (`[/]name@version(peers)`).
 */
function parsePackageKey(
  raw: string,
  v5: boolean,
): { key: string; name: string; version: string } {
  const s = stripSlash(raw);
  if (v5) {
    const idx = s.lastIndexOf('/');
    const name = s.slice(0, idx);
    const version = s.slice(idx + 1);
    return { key: `${name}@${version}`, name, version };
  }
  const { name, version } = splitNameVersion(s);
  return { key: s, name, version: version.replace(/\(.*\)$/, '') };
}

/** Resolve a pnpm dependency reference to a package key. */
function targetKey(depName: string, ref: string): string | undefined {
  if (!ref || ref.startsWith('link:') || ref.startsWith('file:')) return undefined;
  if (ref.startsWith('/')) return stripSlash(ref); // already `name@version(peers)`
  return `${depName}@${ref}`;
}

function importerVersion(spec: { version?: string } | string | undefined): string | undefined {
  if (spec == null) return undefined;
  return typeof spec === 'string' ? spec : spec.version;
}

/** Parser for `pnpm-lock.yaml` (lockfile versions 5, 6 and 9). */
export const pnpmFormat: LockfileFormat = {
  name: 'pnpm',
  parse({ lockfile, importerPath }: ParseInput): DependencyGraph {
    const lock = yaml.load(lockfile) as PnpmLock;
    const major = parseInt(String(lock?.lockfileVersion), 10);
    if (![5, 6, 9].includes(major)) {
      throw new Error('Unsupported pnpm lockfile: expected lockfileVersion 5, 6, or 9');
    }
    const v5 = major === 5;

    // v9 keeps the resolved graph in `snapshots`; v5/v6 keep it in `packages`.
    const source = lock.snapshots ?? lock.packages ?? {};

    const packages = new Map<string, ResolvedPackage>();
    for (const [rawKey, entry] of Object.entries(source)) {
      const { key, name, version } = parsePackageKey(rawKey, v5);
      const dependencies = new Map<string, string>();
      for (const field of ['dependencies', 'optionalDependencies'] as const) {
        const obj = entry[field];
        if (!obj) continue;
        for (const [depName, ref] of Object.entries(obj)) {
          const target = targetKey(depName, String(ref));
          if (target) dependencies.set(depName, target);
        }
      }
      packages.set(key, { key, name, version, dependencies });
    }

    // Direct deps come from the matching importer (workspace-aware).
    const importers =
      lock.importers ??
      ({ '.': { dependencies: lock.dependencies, devDependencies: lock.devDependencies } } as Record<
        string,
        PnpmImporter
      >);
    const importerKey = importerPath === '' ? '.' : importerPath;
    const importer = importers[importerKey] ?? importers['.'] ?? {};

    const roots = new Map<string, string>();
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ] as const) {
      const obj = importer[field];
      if (!obj) continue;
      for (const [name, spec] of Object.entries(obj)) {
        const version = importerVersion(spec);
        if (!version) continue;
        const target = targetKey(name, version);
        if (target) roots.set(name, target);
      }
    }

    return { packages, roots };
  },
};
