import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { resolveCliOptions } from '../dist/cli-options.js';

function fixture(t, config) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sovra-options-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (config) writeFileSync(path.join(root, 'sovra.config.mjs'), `export default ${config};`);
  return root;
}

test('resolved CLI options apply built-in defaults once', async (t) => {
  const root = fixture(t);
  const options = await resolveCliOptions(['--root', root]);
  assert.equal(options.help, false);
  assert.equal(options.cwd, root);
  assert.equal(options.defaultBranch, 'main');
  assert.equal(options.analyzeLockfile, true);
  assert.equal(options.base, undefined);
  assert.deepEqual(options.runAllOn, []);
  assert.equal(options.changedFiles, undefined);
  assert.equal(options.changedDependencies, undefined);
  assert.equal(options.ignoreTypeImports, undefined);
  assert.equal(options.requireAliases, undefined);
  assert.equal(options.resolveOptions, undefined);
});

test('resolved options preserve source-analysis overrides and explicit empty aliases', async (t) => {
  const root = fixture(t, "{ ignoreTypeImports: false, requireAliases: [], resolveOptions: { conditionNames: ['browser'] } }");
  const options = await resolveCliOptions(['--root', root]);
  assert.equal(options.ignoreTypeImports, false);
  assert.deepEqual(options.requireAliases, []);
  assert.deepEqual(options.resolveOptions, { conditionNames: ['browser'] });
});

test('config overrides defaults, CLI overrides config, and undefined never erases a default', async (t) => {
  const root = fixture(t, "{ defaultBranch: 'master', base: 'HEAD~2', analyzeLockfile: false, runAllOn: ['npm:typescript'] }");
  const config = await resolveCliOptions(['--root', root]);
  assert.equal(config.defaultBranch, 'master');
  assert.equal(config.base, 'HEAD~2');
  assert.equal(config.analyzeLockfile, false);
  const cli = await resolveCliOptions(['--root', root, '--default-branch=trunk', '--base=HEAD', '--analyze-lockfile']);
  assert.equal(cli.defaultBranch, 'trunk');
  assert.equal(cli.base, 'HEAD');
  assert.equal(cli.analyzeLockfile, true);
  assert.deepEqual(cli.runAllOn, ['npm:typescript']);
  const empty = fixture(t, '{ defaultBranch: undefined, analyzeLockfile: undefined, runAllOn: undefined }');
  const defaults = await resolveCliOptions(['--root', empty, '--no-analyze-lockfile']);
  assert.equal(defaults.defaultBranch, 'main');
  assert.equal(defaults.analyzeLockfile, false);
  assert.deepEqual(defaults.runAllOn, []);
});

test('one resolved object keeps explicit config paths, changeset names and runner args distinct', async (t) => {
  const root = fixture(t, "{ base: 'ignored' }");
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'config/policy.mjs'), "export default { base: 'HEAD' };");
  const passthrough = ['--config=runner.config.js', '--no-analyze-lockfile', '', '--'];
  const options = await resolveCliOptions([
    '--root', root, '--sovra-config=config/policy.mjs', '--config=test.config.mjs',
    'a.ts', 'npm:@scope/pkg', '--changeset=missing-file', '--', ...passthrough,
  ]);
  assert.equal(options.configPath, 'test.config.mjs');
  assert.equal(options.base, 'HEAD');
  assert.deepEqual(options.changedFiles, ['a.ts']);
  assert.deepEqual(options.changedDependencies, ['@scope/pkg']);
  assert.deepEqual(options.passthrough, passthrough);
});

test('help needs neither a valid project nor config nor a readable changeset', async () => {
  assert.deepEqual(await resolveCliOptions([
    '--root=/nonexistent-sovra-project', '--sovra-config=missing.mjs', '--changeset=-', '--help',
  ]), { help: true });
});

test('only npm: entries in the selected changeset supply an authoritative dependency list', async (t) => {
  const root = fixture(t);
  const changeset = path.join(root, 'changes.txt');
  writeFileSync(changeset, 'package-lock.json\nnpm:@scope/pkg\n');
  const fromFile = await resolveCliOptions(['--root', root, '--changeset', changeset]);
  assert.deepEqual(fromFile.changedFiles, ['package-lock.json']);
  assert.deepEqual(fromFile.changedDependencies, ['@scope/pkg']);
  const positional = await resolveCliOptions(['--root', root, '--changeset', changeset, 'a.ts', '--', 'npm:runner-argument']);
  assert.deepEqual(positional.changedFiles, ['a.ts']);
  assert.equal(positional.changedDependencies, undefined);
  const dependencyOnly = await resolveCliOptions(['--root', root, '--no-analyze-lockfile', 'npm:shared']);
  assert.deepEqual(dependencyOnly.changedFiles, []);
  assert.deepEqual(dependencyOnly.changedDependencies, ['shared']);
  await assert.rejects(resolveCliOptions(['--root', root, 'npm:']), /require a dependency name/);
});
