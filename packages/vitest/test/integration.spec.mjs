import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

import pkg from '../dist/index.js';

const { VitestRunner, decideAffected } = pkg;
const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.resolve(here, '../__fixtures__/basic');
const multi = path.resolve(here, '../__fixtures__/multi');
const execution = path.resolve(here, '../__fixtures__/execution');
const types = path.resolve(here, '../__fixtures__/types');
const exec = promisify(execFile);
const flags = ['--reporter=dot', '--no-color'];

test('Vitest 4 discovers tests without executing them and tracks configuration/setup files', async () => {
  const config = await new VitestRunner({ rootDir: basic }).loadConfig();
  assert.equal(config.projects.length, 1);
  const project = config.projects[0];
  assert.deepEqual(project.testFiles.map((file) => path.basename(file)).sort(), [
    'actual.test.mjs', 'math.test.mjs', 'util.test.mjs',
  ]);
  for (const file of ['vitest.config.mjs', 'config-helper.mjs', 'setup.mjs', 'global-setup.mjs']) {
    assert.ok(project.sentinelFiles.includes(path.join(basic, file)), `${file} is a sentinel`);
  }
  assert.deepEqual(project.resolveOptions.alias['@'], [path.join(basic, 'src')]);
  assert.ok(project.resolveOptions.conditionNames.includes('node'));
  // This fixture deliberately fails if executed; discovery must remain safe.
  assert.equal((await new VitestRunner({ rootDir: execution }).loadConfig()).projects[0].testFiles.length, 2);
});

test('affected selection follows aliases and vi.importActual', async () => {
  const result = await decideAffected({
    config: await new VitestRunner({ rootDir: basic }).loadConfig(), changedFiles: ['src/math.mjs'],
  });
  assert.equal(result.kind, 'run-selected');
  assert.deepEqual(result.testFiles.map((file) => path.basename(file)).sort(), ['actual.test.mjs', 'math.test.mjs']);
});

for (const file of ['setup.mjs', 'setup-helper.mjs', 'global-setup.mjs', 'config-helper.mjs']) {
  test(`changes to ${file} run the full suite`, async () => {
    const result = await decideAffected({
      config: await new VitestRunner({ rootDir: basic }).loadConfig(), changedFiles: [file],
    });
    assert.equal(result.kind, 'run-all');
  });
}

test('project aliases remain isolated during selection', async () => {
  const runner = new VitestRunner({ rootDir: multi });
  const config = await runner.loadConfig();
  const projectsWithTests = config.projects.filter((project) => project.testFiles.length > 0);
  assert.equal(projectsWithTests.length, 2);
  assert.deepEqual(projectsWithTests.map((project) => project.resolveOptions.alias['@'][0]).sort(), [
    path.join(multi, 'a/src'), path.join(multi, 'b/src'),
  ]);
  const result = decideAffected({ config, changedFiles: ['a/src/value.mjs'] });
  assert.equal(result.kind, 'run-selected');
  assert.deepEqual(result.testFiles, [path.join(multi, 'a/tests/value.test.mjs')]);
});

test('root global setup uses root aliases when only child projects contain tests', async () => {
  const result = await decideAffected({
    config: await new VitestRunner({ rootDir: multi }).loadConfig(), changedFiles: ['global-helper.mjs'],
  });
  assert.equal(result.kind, 'run-all');
});

test('an explicit config path is used for discovery', async () => {
  const config = await new VitestRunner({ rootDir: basic, configPath: 'vitest.config.mjs' }).loadConfig();
  assert.equal(config.projects[0].testFiles.length, 3);
});

test('relative test.dir is resolved against rootDir for discovery and execution', async () => {
  const runner = new VitestRunner({ rootDir: basic, configPath: 'vitest.dir.config.mjs' });
  assert.equal((await runner.loadConfig()).projects[0].testFiles.length, 3);
  assert.deepEqual(await runner.run([path.join(basic, 'tests/math.test.mjs')], flags), { success: true });
});

test('configured type tests are discovered and follow type-only dependencies', async () => {
  const runner = new VitestRunner({ rootDir: types });
  const config = await runner.loadConfig();
  const testFile = path.join(types, 'user.test-d.ts');
  assert.deepEqual(config.projects[0].testFiles, [testFile]);
  assert.equal(config.projects[0].ignoreTypeImports, false);
  const errors = [];
  const result = await decideAffected({
    config, changedFiles: ['types/id.d.ts'], onError: (error) => errors.push(error),
  });
  assert.deepEqual(errors, []);
  assert.equal(result.kind, 'run-selected');
  assert.deepEqual(result.testFiles, [testFile]);
  assert.deepEqual(await runner.run(result.testFiles, flags), { success: true });
});

test('selected execution uses exact paths, not substring matching', async () => {
  const runner = new VitestRunner({ rootDir: execution });
  assert.deepEqual(await runner.run([path.join(execution, 'pass.test.mjs')], flags), { success: true });
  assert.deepEqual(await runner.run([], flags), { success: true });
});

test('runAll and selected execution report failures without changing the host exit code', async () => {
  const runner = new VitestRunner({ rootDir: execution });
  const previous = process.exitCode;
  assert.deepEqual(await runner.runAll(flags), { success: false });
  assert.equal(process.exitCode, previous);
  assert.deepEqual(await runner.run([path.join(execution, 'pass.test.mjs.extra.test.mjs')], flags), { success: false });
  assert.equal(process.exitCode, previous);
});

test('runAll honors Vitest passthrough name filters', async () => {
  assert.deepEqual(await new VitestRunner({ rootDir: execution }).runAll([...flags, '-t', '^passes$']), { success: true });
});

test('empty discovery follows passWithNoTests and never changes the host exit code', async () => {
  const runner = new VitestRunner({ rootDir: execution, configPath: 'empty.config.mjs' });
  const previous = process.exitCode;
  assert.deepEqual(await runner.runAll(flags), { success: false });
  assert.deepEqual(await runner.runAll([...flags, '--passWithNoTests']), { success: true });
  assert.equal(process.exitCode, previous);
});

test('passthrough cannot silently switch the configuration after discovery', async () => {
  const runner = new VitestRunner({ rootDir: execution });
  await assert.rejects(runner.runAll(['--config', 'empty.config.mjs']), /discovery uses the same settings/);
});

for (const version of ['3.2.0', '5.0.0']) {
  test(`rejects unsupported Vitest ${version}`, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sovra-vitest-version-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, 'node_modules/vitest'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules/vitest/package.json'), JSON.stringify({ version }));
    await assert.rejects(new VitestRunner({ rootDir: dir }).loadConfig(), /requires Vitest 4/);
  });
}

test('full basic and multi-project suites run successfully', async () => {
  for (const rootDir of [basic, multi]) {
    assert.deepEqual(await new VitestRunner({ rootDir }).runAll(flags), { success: true });
  }
});

test('the CLI lists affected tests using the shared core', async () => {
  const { stdout } = await exec(process.execPath, [
    path.resolve(here, '../dist/cli.js'), '--list', '--no-analyze-lockfile', 'src/math.mjs',
  ], { cwd: basic });
  assert.match(stdout, /actual\.test\.mjs/);
  assert.match(stdout, /math\.test\.mjs/);
  assert.doesNotMatch(stdout, /util\.test\.mjs/);
});

test('the CLI rejects unknown options instead of treating them as changed files', async () => {
  await assert.rejects(
    exec(process.execPath, [path.resolve(here, '../dist/cli.js'), '--unknown'], { cwd: basic }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
      assert.match(error.stderr, /--unknown/);
      return true;
    },
  );
});
