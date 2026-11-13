import type { DependencyGraph } from '../graph';

export interface ParseInput {
  /** Raw lockfile contents. */
  lockfile: string;
  /** The project (rootDir) `package.json` contents, for direct deps. May be ''. */
  manifest: string;
  /**
   * The project directory relative to the lockfile's directory. Used by
   * workspace-aware formats (pnpm) to pick the right importer. `''`/`.` means
   * the lockfile sits at the project root.
   */
  importerPath: string;
}

/** Parses one lockfile format into the agnostic {@link DependencyGraph}. */
export interface LockfileFormat {
  readonly name: string;
  parse(input: ParseInput): DependencyGraph;
}

/** Direct dependency names -> declared range, from a package.json string. */
export function manifestDeps(manifest: string): Map<string, string> {
  const deps = new Map<string, string>();
  if (!manifest) return deps;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(manifest) as Record<string, unknown>;
  } catch {
    return deps;
  }
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ]) {
    const obj = pkg[field];
    if (obj && typeof obj === 'object') {
      for (const [name, range] of Object.entries(obj as Record<string, string>)) {
        deps.set(name, String(range));
      }
    }
  }
  return deps;
}
