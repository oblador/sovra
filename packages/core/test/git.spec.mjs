import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import pkg from '../dist/index.js';

const { readGitChanges } = pkg;
import { prepareChanges } from '../dist/changes.js';
import { readGitFile, resolveGitComparison } from '../dist/git.js';

function fixture(t) {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'sovra-git-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = (name, content = name) => {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), `${content}\n`);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'tag.gpgsign', 'false']);
  const commit = (name) => {
    write(name);
    git(['add', name]);
    git(['commit', '-q', '-m', name]);
    return git(['rev-parse', 'HEAD']);
  };
  const base = commit('base.txt');
  const save = () => {
    git(['add', '.']);
    git(['commit', '-q', '-m', 'snapshot']);
    return git(['rev-parse', 'HEAD']);
  };
  return { repo, git, write, commit, base, save };
}

test('Git snapshot reads distinguish absent paths from empty files and preserve literal names', async (t) => {
  const { repo, write, save } = fixture(t);
  const filename = 'folder/file [with spaces]\nand a newline';
  write(filename, 'contents');
  writeFileSync(path.join(repo, 'empty'), '');
  const ref = save();
  assert.equal(await readGitFile(ref, path.join(repo, filename), repo), 'contents\n');
  assert.equal(await readGitFile(ref, path.join(repo, 'empty'), repo), '');
  assert.equal(await readGitFile(ref, path.join(repo, 'missing'), repo), undefined);
  assert.equal(await readGitFile(ref, path.join(repo, 'folder/*'), repo), undefined);
});

test('Git snapshot reads reject directories and invalid refs instead of treating them as absent', async (t) => {
  const { repo, write, save } = fixture(t);
  write('folder/file');
  const ref = save();
  await assert.rejects(readGitFile(ref, path.join(repo, 'folder'), repo));
  await assert.rejects(readGitFile('invalid-ref', path.join(repo, 'missing'), repo));
});

test('--base ref includes committed, staged, unstaged, and untracked changes', async (t) => {
  const { repo, git, write, commit, base } = fixture(t);
  commit('committed.txt');
  write('base.txt', 'unstaged edit');
  write('staged.txt');
  git(['add', 'staged.txt']);
  write('untracked.txt');

  const changes = await readGitChanges({ cwd: repo, base });
  assert.deepEqual(changes.changedFiles.map((file) => path.relative(repo, file)).sort(), ['base.txt', 'committed.txt', 'staged.txt', 'untracked.txt']);
  assert.equal(changes.before, base);
  assert.equal(changes.after, null);
});

for (const separator of ['..', '...']) {
  test(`--base A${separator}B preserves the range and resolves its dependency baseline`, async (t) => {
    const { repo, git, write, commit, base } = fixture(t);
    git(['checkout', '-q', '-b', 'upstream']);
    const upstream = commit('upstream.txt');
    git(['checkout', '-q', '-b', 'feature', base]);
    const feature = commit('feature.txt');
    // Neither later commits nor tracked working-tree edits belong to the range.
    commit('later.txt');
    write('base.txt', 'unstaged edit');
    write('staged.txt');
    git(['add', 'staged.txt']);
    write('untracked.txt');

    const options = { cwd: repo, base: `${upstream}${separator}${feature}` };
    const changes = await readGitChanges(options);
    assert.deepEqual(changes.changedFiles.map((file) => path.relative(repo, file)).sort(), separator === '..'
      ? ['feature.txt', 'untracked.txt', 'upstream.txt']
      : ['feature.txt', 'untracked.txt']);
    assert.equal(changes.before, separator === '..' ? upstream : base);
    assert.equal(changes.after, feature);
  });
}

test('comparison fails when either or both parallel ref lookups fail', async (t) => {
  const { repo } = fixture(t);
  for (const base of ['missing..HEAD', 'HEAD...missing', 'missing-left..missing-right']) {
    await assert.rejects(resolveGitComparison({ cwd: repo, base }), /rev-parse/);
  }
  await assert.rejects(resolveGitComparison({ cwd: repo, defaultBranch: 'missing' }), /rev-parse/);
});

test('without --base, the default branch merge-base includes local changes', async (t) => {
  const { repo, git, write, commit, base } = fixture(t);
  git(['checkout', '-q', '-b', 'upstream']);
  const upstream = commit('upstream.txt');
  git(['update-ref', 'refs/remotes/origin/integration', upstream]);
  git(['checkout', '-q', '-b', 'feature', base]);
  commit('feature.txt');
  write('base.txt', 'unstaged edit');
  write('untracked.txt');

  const changes = await readGitChanges({ cwd: repo, defaultBranch: 'integration' });
  assert.equal(changes.before, base);
  assert.deepEqual(changes.changedFiles.map((file) => path.relative(repo, file)).sort(), ['base.txt', 'feature.txt', 'untracked.txt']);
});

const lock = (version) => JSON.stringify({ lockfileVersion: 3, packages: {
  '': { dependencies: { shared: version } }, 'node_modules/shared': { version },
} });

for (const separator of ['..', '...']) {
  test(`lockfile snapshots honor both ${separator} endpoints, ignoring later changes`, async (t) => {
    const { repo, write, save } = fixture(t);
    write('package.json', '{"dependencies":{"shared":"*"}}');
    write('package-lock.json', lock('1.0.0'));
    const before = save();
    write('package-lock.json', lock('1.0.1'));
    const after = save();
    // Invalid local contents would fail analysis if it accidentally read HEAD/worktree.
    write('package-lock.json', '{');
    save();
    write('package-lock.json', 'also invalid');
    const result = await prepareChanges({ cwd: repo, base: `${before}${separator}${after}` });
    assert.equal(result.runAllReason, undefined);
    assert.deepEqual(result.changedDependencies, ['shared']);
  });
}

test('workspace-level lockfile changes are visible from a child project', async (t) => {
  const { repo, write, save } = fixture(t);
  write('packages/app/package.json', '{"dependencies":{"shared":"*"}}');
  write('package-lock.json', lock('1.0.0'));
  const base = save();
  write('package-lock.json', lock('1.0.1'));
  const result = await prepareChanges({ cwd: path.join(repo, 'packages/app'), base });
  assert.deepEqual(result.changedFiles, [path.join(repo, 'package-lock.json')]);
  assert.deepEqual(result.changedDependencies, ['shared']);
});

test('snapshot preparation ignores configuration unrelated to the selected lockfile format', async (t) => {
  const { repo, write, save } = fixture(t);
  write('package-lock.json', lock('1.0.0'));
  // These non-file entries would fail if preparation inspected them.
  for (const name of ['.npmrc', '.yarnrc.yml', 'pnpm-workspace.yaml']) write(`${name}/unused`);
  const base = save();
  write('package-lock.json', lock('1.0.1'));
  const result = await prepareChanges({ cwd: repo, base });
  assert.equal(result.runAllReason, undefined);
  assert.deepEqual(result.changedDependencies, ['shared']);
});

test('changed ancestor lockfiles are analyzed without inspecting unchanged alternatives or siblings', async (t) => {
  const { repo, write, save } = fixture(t);
  write('packages/app/package.json', '{}');
  write('packages/app/yarn.lock', '# yarn lockfile v1\n');
  write('package-lock.json', lock('1.0.0'));
  write('packages/other/package-lock.json', lock('1.0.0'));
  const base = save();
  write('package-lock.json', lock('1.0.1'));
  write('packages/other/package-lock.json', 'invalid and irrelevant');
  const result = await prepareChanges({ cwd: path.join(repo, 'packages/app'), base });
  assert.equal(result.runAllReason, undefined);
  assert.deepEqual(result.changedDependencies, ['shared']);
  // A non-file alternative must not even be inspected on disk.
  mkdirSync(path.join(repo, 'packages/app/pnpm-lock.yaml'));
  assert.deepEqual(await prepareChanges({ cwd: path.join(repo, 'packages/app'), base }), result);
});

test('sibling lockfile changes do not request historical snapshots', async (t) => {
  const { repo, write } = fixture(t);
  write('packages/app/package.json', '{}');
  write('packages/other/pnpm-lock.yaml', 'invalid and irrelevant');
  const result = await prepareChanges({
    cwd: path.join(repo, 'packages/app'), base: 'missing',
    changedFiles: ['../other/pnpm-lock.yaml'],
  });
  assert.equal(result.runAllReason, undefined);
  assert.deepEqual(result.changedDependencies, []);
});

for (const added of [true, false]) {
  test(`${added ? 'added' : 'deleted'} governing lockfile is analyzed against absence`, async (t) => {
    const { repo, write, save } = fixture(t);
    write('package.json', '{}');
    if (!added) write('package-lock.json', lock('1.0.0'));
    const base = save();
    if (added) write('package-lock.json', lock('1.0.0'));
    else rmSync(path.join(repo, 'package-lock.json'));
    const result = await prepareChanges({ cwd: repo, base });
    assert.equal(result.runAllReason, undefined);
    assert.deepEqual(result.changedDependencies, ['shared']);
  });
}

test('invalid lockfile analysis falls back to the full suite; --no-analyze-lockfile opts out', async (t) => {
  const { repo, write, save } = fixture(t);
  write('package-lock.json', lock('1.0.0'));
  const base = save();
  write('package-lock.json', '{');
  assert.match((await prepareChanges({ cwd: repo, base })).runAllReason, /Dependency analysis failed/);
  assert.equal((await prepareChanges({ cwd: repo, base, analyzeLockfile: false })).runAllReason, undefined);
  // Read errors must not be confused with a deleted lockfile.
  rmSync(path.join(repo, 'package-lock.json'));
  mkdirSync(path.join(repo, 'package-lock.json'));
  assert.match((await prepareChanges({ cwd: repo, base })).runAllReason, /Dependency analysis failed/);
});

test('explicit dependency lists replace automatic analysis without suppressing Git file changes', async (t) => {
  const { repo, write, save } = fixture(t);
  write('package-lock.json', lock('1.0.0'));
  const base = save();
  write('package-lock.json', lock('1.0.1'));
  write('source.js', 'export const value = 2;');
  const result = await prepareChanges({ cwd: repo, base, changedDependencies: ['provided'] });
  assert.equal(result.runAllReason, undefined);
  assert.deepEqual(result.changedDependencies, ['provided']);
  assert.deepEqual(result.changedFiles.sort(), ['package-lock.json', 'source.js'].map((file) => path.join(repo, file)));

  // Invalid dependency inputs and an unavailable baseline must not be consulted
  // when both file and dependency changes are already supplied.
  write('package-lock.json', '{');
  write('pnpm-workspace.yaml', '{');
  for (const changedDependencies of [['provided'], []]) {
    const explicit = await prepareChanges({
      cwd: repo, base: 'missing', analyzeLockfile: true,
      changedFiles: ['package-lock.json', 'pnpm-workspace.yaml', 'source.js'], changedDependencies,
    });
    assert.equal(explicit.runAllReason, undefined);
    assert.deepEqual(explicit.changedDependencies, changedDependencies);
  }
});

test('an invalid baseline is a failure, not an absent lockfile', async (t) => {
  const { repo, write } = fixture(t);
  write('package-lock.json', lock('1.0.0'));
  const result = await prepareChanges({ cwd: repo, base: 'does-not-exist', changedFiles: ['package-lock.json'] });
  assert.match(result.runAllReason, /Dependency analysis failed/);
});

test('routine manifest and workspace edits stay selective alongside dependency diffs', async (t) => {
  const { repo, write, save } = fixture(t);
  write('package.json', '{"packageManager":"pnpm@10.1.0"}');
  write('packages/app/package.json', '{"dependencies":{"app":"1.0.0"}}');
  write('pnpm-lock.yaml', pnpmLock('1.0.0'));
  write('pnpm-workspace.yaml', "packages: ['packages/*']\ncatalog: { shared: '1.0.0' }");
  const base = save();
  write('package.json', '{"packageManager":"pnpm@10.1.0","version":"2.0.0"}');
  write('pnpm-lock.yaml', pnpmLock('1.0.1'));
  write('pnpm-workspace.yaml', "packages: ['packages/*', 'tools/*']\ncatalog: { shared: '1.0.1' }");
  const result = await prepareChanges({ cwd: path.join(repo, 'packages/app'), base });
  assert.equal(result.runAllReason, undefined);
  assert.deepEqual(result.changedDependencies, ['app']);
});

test('manifest-only dependency changes do not trigger automatic dependency analysis', async (t) => {
  const { repo, write, save } = fixture(t);
  write('package.json', '{"dependencies":{"shared":"1.0.0"}}');
  write('package-lock.json', lock('1.0.0'));
  const base = save();
  write('package.json', '{"dependencies":{"shared":"1.0.1","added":"1.0.0"}}');
  const result = await prepareChanges({ cwd: repo, base });
  assert.equal(result.runAllReason, undefined);
  assert.deepEqual(result.changedDependencies, []);
});

for (const file of ['package.json', '.npmrc', '.yarnrc.yml', 'pnpm-workspace.yaml']) {
  test(`${file} changes do not read config or request historical snapshots`, async (t) => {
    const { repo, write } = fixture(t);
    write(file, '{');
    write('pnpm-lock.yaml', 'also invalid');
    const result = await prepareChanges({ cwd: repo, base: 'missing', changedFiles: [file] });
    assert.equal(result.runAllReason, undefined);
    assert.deepEqual(result.changedFiles, [path.join(repo, file)]);
    assert.deepEqual(result.changedDependencies, []);
  });
}

test('explicit source paths need no Git baseline and skip unrelated dependency diffs', async (t) => {
  const { repo, write } = fixture(t);
  write('package-lock.json', 'invalid');
  const result = await prepareChanges({ cwd: repo, base: 'does-not-exist', changedFiles: ['src/file.js'] });
  assert.equal(result.runAllReason, undefined);
  assert.deepEqual(result.changedDependencies, []);
});

test('Git paths preserve spaces, newlines, and both sides of renames', async (t) => {
  const { repo, write, git, save } = fixture(t);
  write('old name\nfile.js');
  const base = save();
  git(['mv', 'old name\nfile.js', 'new name\nfile.js']);
  const result = await readGitChanges({ cwd: repo, base });
  assert.deepEqual(result.changedFiles.sort(), ['new name\nfile.js', 'old name\nfile.js'].map((file) => path.join(repo, file)));
});

const pnpmLock = (version) => `lockfileVersion: '9.0'
importers:
  packages/app:
    dependencies:
      app: { specifier: '1.0.0', version: '1.0.0' }
snapshots:
  app@1.0.0:
    dependencies: { shared: '${version}', hidden: '${version}' }
  shared@${version}: {}
  hidden@${version}: {}
`;

test('CLI preparation inherits pnpm workspace nodeLinker for member projects', async (t) => {
  const { repo, write, save } = fixture(t);
  write('packages/app/package.json', '{"dependencies":{"app":"1.0.0"}}');
  write('pnpm-workspace.yaml', "packages: ['packages/*']\nnodeLinker: hoisted");
  write('pnpm-lock.yaml', pnpmLock('1.0.0'));
  const base = save();
  write('pnpm-lock.yaml', pnpmLock('1.0.1'));
  const result = await prepareChanges({ cwd: path.join(repo, 'packages/app'), base });
  assert.equal(result.runAllReason, undefined);
  assert.deepEqual(result.changedDependencies.sort(), ['app', 'hidden', 'shared']);
});

for (const [linker, expected] of [
  [undefined, ['app']],
  ['pnp', ['app']],
  ['node-modules', ['app', 'shared']],
]) {
  test(`CLI preparation respects Yarn Berry ${linker ?? 'default'} linking`, async (t) => {
    const { repo, write, save } = fixture(t);
    const lock = (version) => `__metadata:
  version: 8
"app@npm:1.0.0":
  version: 1.0.0
  resolution: "app@npm:1.0.0"
  dependencies:
    shared: "npm:^1.0.0"
"shared@npm:^1.0.0":
  version: ${version}
  resolution: "shared@npm:${version}"
`;
    write('packages/app/package.json', '{"dependencies":{"app":"1.0.0"}}');
    if (linker) write('.yarnrc.yml', `nodeLinker: ${linker}`);
    write('yarn.lock', lock('1.0.0'));
    const base = save();
    write('yarn.lock', lock('1.0.1'));
    const result = await prepareChanges({ cwd: path.join(repo, 'packages/app'), base });
    assert.equal(result.runAllReason, undefined);
    assert.deepEqual(result.changedDependencies.sort(), expected);
  });
}

test('CLI preparation uses configured public hoists without an install, ignoring local metadata', async (t) => {
  const { repo, write, save } = fixture(t);
  write('packages/app/package.json', '{"dependencies":{"app":"1.0.0"}}');
  write('pnpm-lock.yaml', pnpmLock('1.0.0'));
  write('pnpm-workspace.yaml', "packages: ['packages/*']\npublicHoistPattern: ['shared']");
  write('.gitignore', 'node_modules/');
  const base = save();
  write('pnpm-lock.yaml', pnpmLock('1.0.1'));
  assert.equal(existsSync(path.join(repo, 'node_modules')), false);
  const result = await prepareChanges({ cwd: path.join(repo, 'packages/app'), base });
  assert.equal(result.runAllReason, undefined);
  assert.deepEqual(result.changedDependencies.toSorted(), ['app', 'shared']);
  write('node_modules/.modules.yaml', 'nodeLinker: hoisted');
  assert.deepEqual(await prepareChanges({ cwd: path.join(repo, 'packages/app'), base }), result);
  // Even an unreadable/non-file metadata entry must not be inspected.
  rmSync(path.join(repo, 'node_modules/.modules.yaml'));
  mkdirSync(path.join(repo, 'node_modules/.modules.yaml'));
  assert.deepEqual(await prepareChanges({ cwd: path.join(repo, 'packages/app'), base }), result);
});

test('commit ranges use only the end commit layout for both lockfiles, never installation metadata', async (t) => {
  const { repo, write, save } = fixture(t);
  write('packages/app/package.json', '{"dependencies":{"app":"1.0.0"}}');
  write('pnpm-lock.yaml', pnpmLock('1.0.0'));
  write('pnpm-workspace.yaml', "packages: ['packages/*']\nnodeLinker: hoisted");
  // Even accidentally committed metadata must not be read from Git.
  write('node_modules/.modules.yaml', 'invalid: [');
  const before = save();
  write('pnpm-lock.yaml', pnpmLock('1.0.1'));
  write('pnpm-workspace.yaml', "packages: ['packages/*']\npublicHoistPattern: ['shared']");
  const after = save();
  write('pnpm-workspace.yaml', 'nodeLinker: hoisted');
  write('node_modules/.modules.yaml', 'nodeLinker: hoisted');
  const result = await prepareChanges({ cwd: path.join(repo, 'packages/app'), base: `${before}..${after}` });
  assert.equal(result.runAllReason, undefined);
  assert.deepEqual(result.changedDependencies.sort(), ['app', 'shared']);
});

test('working-tree comparisons read only the current layout, not historical layout config', async (t) => {
  const { repo, write, save } = fixture(t);
  write('packages/app/package.json', '{"dependencies":{"app":"1.0.0"}}');
  write('pnpm-lock.yaml', pnpmLock('1.0.0'));
  write('pnpm-workspace.yaml', 'invalid: [');
  const base = save();
  write('pnpm-lock.yaml', pnpmLock('1.0.1'));
  write('pnpm-workspace.yaml', "publicHoistPattern: ['shared']");
  const options = { cwd: path.join(repo, 'packages/app'), base };
  const result = await prepareChanges(options);
  assert.equal(result.runAllReason, undefined);
  assert.deepEqual(result.changedDependencies.sort(), ['app', 'shared']);

  // A deleted lockfile still uses the current layout, not historical config.
  rmSync(path.join(repo, 'pnpm-lock.yaml'));
  const deleted = await prepareChanges(options);
  assert.equal(deleted.runAllReason, undefined);
  assert.deepEqual(deleted.changedDependencies.sort(), ['app', 'shared']);

  write('pnpm-workspace.yaml', 'invalid: [');
  assert.match((await prepareChanges(options)).runAllReason, /Dependency analysis failed/);
});

test('untracked lockfiles cannot be silently ignored by a commit range', async (t) => {
  const { repo, write, base } = fixture(t);
  write('package-lock.json', lock('1.0.0'));
  const result = await prepareChanges({ cwd: repo, base: `${base}..HEAD` });
  assert.match(result.runAllReason, /untracked lockfile/);
});

test('unchanged npm shrinkwrap does not override a changed package-lock', async (t) => {
  const { repo, write, save } = fixture(t);
  write('npm-shrinkwrap.json', lock('1.0.0'));
  write('package-lock.json', lock('1.0.0'));
  const base = save();
  write('package-lock.json', lock('1.0.1'));
  const result = await prepareChanges({ cwd: repo, base });
  assert.equal(result.runAllReason, undefined);
  assert.deepEqual(result.changedDependencies, ['shared']);
});
