import path from 'node:path';

import { affectedDependencies, emptyGraph } from './graph';
import { LOCKFILE_NAMES, detectFormat } from './formats';
import { createPublicHoistMatcher, type DependencyLayout } from './pnpm-layout';

export interface DependencySnapshot {
  /** Recognized lockfile basename, e.g. pnpm-lock.yaml. */
  filename: string;
  contents: string;
  /** The consuming project's package.json, not the workspace root's. */
  manifest: string;
  /** Project directory relative to the lockfile directory; defaults to '.'. */
  importerPath?: string;
}

export interface DiffDependenciesOptions {
  /** null means absent, never unreadable or invalid. */
  before: DependencySnapshot | null;
  after: DependencySnapshot | null;
  /** Shared install layout for both snapshots; defaults to the newer format's standard layout. */
  layout?: DependencyLayout;
}

/** Select a lockfile from changed paths in the project or its ancestors.
 * Nearest directory wins, then filename priority. Unchanged lockfiles are not
 * discovered or considered. No I/O.
 */
export function selectLockfile(projectDir: string, changedFiles: string[]): string | undefined {
  const available = new Set(changedFiles.map((file) => path.resolve(file)));
  for (let dir = path.resolve(projectDir); ; dir = path.dirname(dir)) {
    for (const name of LOCKFILE_NAMES) {
      const file = path.join(dir, name);
      if (available.has(file)) return file;
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Compare snapshots without reading files, invoking Git, or swallowing errors.
 * Each side is parsed independently, including package-manager changes.
 */
export function diffDependencies({ before, after, layout }: DiffDependenciesOptions): string[] {
  const parse = (snapshot: DependencySnapshot | null) => {
    if (!snapshot) return { graph: emptyGraph(), format: undefined };
    const format = detectFormat(snapshot.filename, snapshot.contents);
    if (!format) throw new Error(`Unsupported lockfile: ${snapshot.filename}`);
    if (snapshot.manifest) JSON.parse(snapshot.manifest); // invalid is not absent
    const graph = format.parse({
      lockfile: snapshot.contents,
      manifest: snapshot.manifest,
      importerPath: snapshot.importerPath ?? '.',
    });
    return { graph, format };
  };
  const base = parse(before);
  const head = parse(after);
  const format = head.format ?? base.format;
  if (!format) return [];
  const { name } = format;
  layout ??= { linker: name === 'npm' || name === 'yarn-classic' ? 'hoisted' : 'isolated' };
  // npm records the precise hoisted tree; other hoisted formats expose all names.
  const surface = layout.linker === 'hoisted'
    ? name === 'npm' ? 'hoisted' : 'all'
    : 'direct';
  const includeTransitive = name === 'pnpm' && layout.linker === 'isolated' && layout.publicHoistPatterns?.length
    ? createPublicHoistMatcher(layout)
    : undefined;
  return affectedDependencies(base.graph, head.graph, { surface, includeTransitive });
}
