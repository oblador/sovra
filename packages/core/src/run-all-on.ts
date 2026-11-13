import path from 'node:path';
import picomatch from 'picomatch';

export function validateRunAllOn(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error('runAllOn must be an array of non-empty file/glob or npm: strings');
  }
  for (const entry of value) {
    const target = entry.replace(/^(npm:|file:)/, '');
    if (!target.trim()) throw new Error(`Invalid runAllOn entry: ${JSON.stringify(entry)}`);
    if (target.startsWith('!')) throw new Error('runAllOn does not support negated patterns');
    if (entry.startsWith('npm:') && /[*?\[\]{}()]/.test(target)) {
      throw new Error('runAllOn npm: entries use package/scope prefixes, not globs');
    }
  }
}

/** Match explicit changes against full-suite rules without reading the filesystem. */
export function matchRunAllOn(
  entries: string[],
  cwd: string,
  changedFiles: string[],
  changedDependencies: string[],
): string | undefined {
  const filePatterns: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('npm:')) {
      const target = entry.slice(4);
      // Segment boundaries mirror getAffected. A whole-package change also
      // covers a configured subpath, since lockfiles cannot diff subpaths.
      const dependency = changedDependencies.find((name) =>
        name === target || name.startsWith(`${target}/`) || target.startsWith(`${name}/`));
      if (dependency) return `npm:${dependency} changed (runAllOn: ${entry})`;
    } else {
      filePatterns.push(path.normalize(entry.replace(/^file:/, '')).split(path.sep).join('/'));
    }
  }
  const matchers = filePatterns.map((pattern) => ({
    absolute: path.resolve(cwd, pattern),
    absolutePattern: path.isAbsolute(pattern),
    matches: picomatch(pattern, { dot: true, nonegate: true }),
  }));
  const directlyChanged = changedFiles.find((file) => {
    return matchers.some(({ absolute, absolutePattern, matches }) =>
      absolute === file || matches((absolutePattern ? file : path.relative(cwd, file)).split(path.sep).join('/')));
  });
  return directlyChanged ? `${directlyChanged} changed (runAllOn)` : undefined;
}
