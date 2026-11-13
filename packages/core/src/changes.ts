import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readGitChanges, readGitFile, resolveGitComparison } from './git';
import type { GitChangesOptions, GitComparison } from './git';
import { diffDependencies, selectLockfile, type DependencySnapshot } from './package-managers/lockfile';
import { detectFormat } from './package-managers/formats';
import { parsePnpmLayout, type DependencyLayout } from './package-managers/pnpm-layout';

interface PreparedChanges {
  changedFiles: string[];
  changedDependencies: string[];
  runAllReason?: string;
}

/** CLI preparation boundary: Git and dependency-input reads precede selection.
 * Explicit source paths require no Git repository. Only a relevant changed
 * lockfile needs historical snapshots.
 */
export async function prepareChanges(opts: GitChangesOptions & {
  changedFiles?: string[];
  /** Authoritative dependency list; when supplied, skip automatic analysis. */
  changedDependencies?: string[];
  analyzeLockfile?: boolean;
}): Promise<PreparedChanges> {
  const projectDir = realpathSync(opts.cwd);
  let comparison: GitComparison | undefined;
  let untrackedFiles: string[] = [];
  let changedFiles: string[];
  if (opts.changedFiles !== undefined) {
    changedFiles = opts.changedFiles.map((file) => path.resolve(projectDir, file));
  } else {
    const gitChanges = await readGitChanges(opts);
    comparison = gitChanges;
    changedFiles = gitChanges.changedFiles;
    untrackedFiles = gitChanges.untrackedFiles;
  }
  const result: PreparedChanges = { changedFiles, changedDependencies: opts.changedDependencies ?? [] };
  if (opts.changedDependencies !== undefined || opts.analyzeLockfile === false) return result;

  const lockfile = selectLockfile(projectDir, changedFiles);
  if (!lockfile) return result;

  try {
    comparison ??= await resolveGitComparison(opts);
    const { rootDir, after: afterRef } = comparison;
    if (comparison.after && untrackedFiles.includes(lockfile)) {
      return { ...result, runAllReason: 'An untracked lockfile is outside the requested commit range' };
    }
    const read = async (file: string, ref: string | null): Promise<string | undefined> => {
      if (ref) return readGitFile(ref, file, rootDir);
      try {
        return await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const snapshot = async (ref: string | null): Promise<DependencySnapshot | null> => {
      const contents = await read(lockfile, ref);
      if (contents === undefined) return null;
      return {
        filename: path.basename(lockfile), contents,
        manifest: await read(path.join(projectDir, 'package.json'), ref) ?? '',
        importerPath: path.relative(path.dirname(lockfile), projectDir).split(path.sep).join('/') || '.',
      };
    };
    const [before, after] = await Promise.all([
      snapshot(comparison.before),
      snapshot(afterRef),
    ]);
    const current = after ?? before;
    if (!current) return result;
    const format = detectFormat(current.filename, current.contents);
    // Both lockfiles use the layout at the comparison's newer endpoint.
    const readUp = async (name: string): Promise<string | undefined> => {
      for (let dir = projectDir; ; dir = path.dirname(dir)) {
        const contents = await read(path.join(dir, name), afterRef);
        if (contents !== undefined || dir === rootDir || path.dirname(dir) === dir) return contents;
      }
    };
    let layout: DependencyLayout | undefined;
    if (format?.name === 'pnpm') {
      const [manifest, npmrc, workspace] = await Promise.all([
        after?.manifest || readUp('package.json'),
        readUp('.npmrc'),
        readUp('pnpm-workspace.yaml'),
      ]);
      layout = parsePnpmLayout({ manifest, npmrc, workspace });
    } else if (format?.name === 'yarn-berry') {
      const yarnrc = await readUp('.yarnrc.yml');
      layout = {
        linker: /^\s*nodeLinker:\s*["']?node-modules\b/m.test(yarnrc ?? '') ? 'hoisted' : 'isolated',
      };
    }
    result.changedDependencies = diffDependencies({ before, after, layout });
    return result;
  } catch (error) {
    return { ...result, runAllReason: `Dependency analysis failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
