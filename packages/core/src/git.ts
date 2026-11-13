import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

export interface GitChangesOptions {
  cwd: string;
  base?: string | null;
  defaultBranch?: string;
}

export interface GitComparison {
  /** Absolute, canonical repository root. */
  rootDir: string;
  /** Resolved commit ids, shared by path and content reads. null = working tree. */
  before: string;
  after: string | null;
}

export interface GitChanges extends GitComparison {
  /** Absolute, repository-wide paths (including workspace-level lockfiles). */
  changedFiles: string[];
  untrackedFiles: string[];
}

export async function resolveGitComparison(opts: GitChangesOptions): Promise<GitComparison> {
  const rootDir = (await git(['rev-parse', '--show-toplevel'], opts.cwd)).trim();
  const commit = async (ref: string) => (await git(
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], rootDir,
  )).trim();
  const range = opts.base?.match(/^(.*?)(\.\.\.?)(.*?)$/);
  if (range) {
    const [left, after] = await Promise.all([
      commit(range[1] || 'HEAD'),
      commit(range[3] || 'HEAD'),
    ]);
    const before = range[2] === '...'
      ? (await git(['merge-base', left, after], rootDir)).trim() : left;
    return { rootDir, before, after };
  }
  if (opts.base) return { rootDir, before: await commit(opts.base), after: null };
  const [defaultBranch, head] = await Promise.all([
    commit(`origin/${opts.defaultBranch ?? 'main'}`),
    commit('HEAD'),
  ]);
  const before = (await git(['merge-base', defaultBranch, head], rootDir)).trim();
  return { rootDir, before, after: null };
}

/** Resolve endpoints once, then collect changed paths. Ranges compare commits;
 * a single ref compares with the working tree. Untracked paths are always added.
 */
export async function readGitChanges(opts: GitChangesOptions): Promise<GitChanges> {
  const comparison = await resolveGitComparison(opts);
  const { rootDir, before, after } = comparison;
  const [tracked, untracked] = await Promise.all([
    git(['diff', '--name-only', '--no-renames', '-z', before, ...(after ? [after] : []), '--'], rootDir),
    git(['ls-files', '--others', '--exclude-standard', '-z'], rootDir),
  ]);
  const absolute = (raw: string) => raw.split('\0').filter(Boolean).map((file) => path.join(rootDir, file));
  const untrackedFiles = absolute(untracked);
  return { ...comparison, untrackedFiles, changedFiles: [...new Set([...absolute(tracked), ...untrackedFiles])] };
}

/** Read one file directly; only a confirmed absent path returns undefined. */
export async function readGitFile(ref: string, file: string, rootDir: string): Promise<string | undefined> {
  const relative = path.relative(rootDir, file).split(path.sep).join('/');
  try {
    return await git(['cat-file', 'blob', `${ref}:${relative}`], rootDir);
  } catch (error) {
    // A failed read can mean a missing path or a real Git/object error. Check
    // only that exact path on failure, without treating other errors as absence.
    const entry = await git(['--literal-pathspecs', 'ls-tree', '--name-only', '-z', ref, '--', relative], rootDir);
    if (entry === '') return undefined;
    throw error;
  }
}
