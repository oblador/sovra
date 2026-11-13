import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { decideAffected, runAffected } from '../dist/index.js';

function fixture(t, extra = {}) {
  // Deliberately not a Git repository: explicit change data needs no Git.
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sovra-decide-')));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries({
    'src/math.js': 'export const add = (a, b) => a + b;',
    'src/util.js': "import shared from 'shared'; export const value = shared;",
    'src/setup-helper.js': 'export const setup = true;',
    'math.test.js': "import { add } from './src/math.js';",
    'util.test.js': "import { value } from './src/util.js';",
    'setup.js': "import './src/setup-helper.js';",
    'node_modules/shared/package.json': '{"main":"index.js"}',
    'node_modules/shared/index.js': 'export default 1;',
    ...extra,
  })) {
    const file = path.join(rootDir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return {
    rootDir,
    projects: [{
      rootDir,
      testFiles: ['math.test.js', 'util.test.js'].map((file) => path.join(rootDir, file)),
      sentinelFiles: [path.join(rootDir, 'setup.js')],
      resolveOptions: { roots: [rootDir], extensions: ['.js'] },
      ignoreTypeImports: true,
    }],
  };
}

test('empty changes select nothing without consulting Git', (t) => {
  assert.deepEqual(decideAffected({ config: fixture(t), changedFiles: [] }), { kind: 'none' });
});

test('source change follows real imports and selects only its dependent test', (t) => {
  const config = fixture(t);
  assert.deepEqual(decideAffected({ config, changedFiles: ['src/math.js'] }), {
    kind: 'run-selected', testFiles: [config.projects[0].testFiles[0]],
  });
});

test('directly changed test is selected', (t) => {
  const config = fixture(t);
  assert.deepEqual(decideAffected({ config, changedFiles: [config.projects[0].testFiles[0]] }), {
    kind: 'run-selected', testFiles: [config.projects[0].testFiles[0]],
  });
});

for (const file of ['setup.js', 'src/setup-helper.js']) {
  test(`${file} forces the full suite through the real sentinel graph`, (t) => {
    assert.equal(decideAffected({ config: fixture(t), changedFiles: [file] }).kind, 'run-all');
  });
}

test('unrelated change selects no tests', (t) => {
  assert.deepEqual(decideAffected({ config: fixture(t), changedFiles: ['README.md'] }), {
    kind: 'none',
  });
});

test('runAllOn mixes files, globs and npm: packages in one array', (t) => {
  const config = fixture(t, { 'tool.config.js': "import './src/setup-helper.js';" });
  const runAllOn = ['tool.config.js', 'config/**/*.json', 'npm:typescript'];
  for (const changedFiles of [['tool.config.js'], ['config/deleted.json']]) {
    assert.equal(decideAffected({ config, changedFiles, runAllOn }).kind, 'run-all');
  }
  assert.equal(decideAffected({ config, changedFiles: [], changedDependencies: ['typescript'], runAllOn }).kind, 'run-all');
  assert.deepEqual(decideAffected({ config, changedFiles: ['README.md'], runAllOn }), { kind: 'none' });
});

test('runAllOn only matches changed paths, without analyzing matching files or their imports', (t) => {
  const config = fixture(t, {
    'config/tool.js': "import './helper.js';",
    'config/helper.js': "import './missing.js';",
  });
  const runAllOn = ['config/tool.{js,ts}'];
  assert.deepEqual(decideAffected({ config, changedFiles: ['config/helper.js'], runAllOn }), {
    kind: 'none',
  });
  assert.equal(decideAffected({ config, changedFiles: ['config/tool.ts'], runAllOn }).kind, 'run-all');
  assert.deepEqual(decideAffected({ config, changedFiles: ['src/math.js'], runAllOn }), {
    kind: 'run-selected', testFiles: [config.projects[0].testFiles[0]],
  });
});

test('runAllOn file: prefixes, absolute paths and dotfiles work without requiring the file to exist', (t) => {
  const config = fixture(t);
  for (const runAllOn of [
    ['file:removed.js'], [path.join(config.rootDir, 'removed.js')], ['**/*.js'],
  ]) {
    assert.equal(decideAffected({ config, changedFiles: ['removed.js'], runAllOn }).kind, 'run-all');
  }
  assert.equal(decideAffected({ config, changedFiles: ['.config/removed.js'], runAllOn: ['**/*.js'] }).kind, 'run-all');
});

for (const [entry, dependency, expected] of [
  ['npm:react', 'react', true],
  ['npm:react', 'react-dom', false],
  ['npm:@scope', '@scope/tool', true],
  ['npm:@scope', '@scoped/tool', false],
  ['npm:@scope/tool', '@scope/other', false],
  ['npm:lodash/fp', 'lodash', true],
  ['npm:lodash/fp', 'lodash/fp/map', true],
  ['npm:lodash/fp', 'lodash/map', false],
]) {
  test(`runAllOn ${entry} matches ${dependency}: ${expected}`, (t) => {
    const result = decideAffected({ config: fixture(t), changedFiles: [], changedDependencies: [dependency], runAllOn: [entry] });
    assert.equal(result.kind, expected ? 'run-all' : 'none');
  });
}

test('runAllOn uses cwd for file rules even when the runner root differs', (t) => {
  const config = fixture(t, { 'config/tool.js': "import '../src/setup-helper.js';" });
  const cwd = config.rootDir;
  config.rootDir = path.join(cwd, 'src');
  assert.equal(decideAffected({ config, cwd, changedFiles: ['config/tool.js'], runAllOn: ['config/*.js'] }).kind, 'run-all');
});

test('runAllOn handles glob metacharacters in the project root and literal filenames', (t) => {
  const config = fixture(t, {
    '[project]/tool.js': "import '../src/setup-helper.js';",
    '[tool].js': "import './src/setup-helper.js';",
  });
  assert.equal(decideAffected({ config, cwd: path.join(config.rootDir, '[project]'),
    changedFiles: ['tool.js'], runAllOn: ['tool.*'] }).kind, 'run-all');
  assert.equal(decideAffected({ config, changedFiles: ['[tool].js'], runAllOn: ['[tool].js'] }).kind, 'run-all');
});

test('explicit sentinel imports are resolved separately for each project', (t) => {
  const config = fixture(t, {
    'a/value.js': 'export default 1;', 'b/value.js': 'export default 2;',
    'tool.js': "import '@/value';",
  });
  config.projects = ['a', 'b'].map((name) => ({
    ...config.projects[0],
    sentinelFiles: [path.join(config.rootDir, 'tool.js')],
    resolveOptions: { extensions: ['.js'], alias: { '@': [path.join(config.rootDir, name)] } },
  }));
  assert.equal(decideAffected({ config, changedFiles: ['b/value.js'] }).kind, 'run-all');
});

test('runAllOn does not force a run for an empty changeset', (t) => {
  assert.deepEqual(decideAffected({ config: fixture(t), changedFiles: [], runAllOn: ['**/*', 'npm:shared'] }), { kind: 'none' });
});

test('invalid programmatic runAllOn entries fail explicitly', (t) => {
  assert.throws(() => decideAffected({ config: fixture(t), changedFiles: [], runAllOn: ['npm:'] }), /Invalid runAllOn entry/);
});

test('runAllOn does not traverse unreadable directories', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, (t) => {
  const config = fixture(t, { 'private/tool.js': "import '../src/setup-helper.js';" });
  const dir = path.join(config.rootDir, 'private');
  chmodSync(dir, 0);
  try {
    assert.deepEqual(decideAffected({ config, changedFiles: ['src/math.js'], runAllOn: ['**/tool.js'] }), {
      kind: 'run-selected', testFiles: [config.projects[0].testFiles[0]],
    });
    assert.equal(decideAffected({ config, changedFiles: ['private/tool.js'], runAllOn: ['**/tool.js'] }).kind, 'run-all');
  } finally {
    chmodSync(dir, 0o755);
  }
});

test('bare dependency names select tests importing the changed package', (t) => {
  const config = fixture(t);
  assert.deepEqual(decideAffected({ config, changedFiles: [], changedDependencies: ['shared'] }), {
    kind: 'run-selected', testFiles: [config.projects[0].testFiles[1]],
  });
});

test('file and dependency changes are combined and deduplicated', (t) => {
  const config = fixture(t);
  const result = decideAffected({ config, changedFiles: ['src/math.js', 'src/util.js'], changedDependencies: ['shared'] });
  assert.equal(result.kind, 'run-selected');
  assert.deepEqual(result.testFiles.sort(), config.projects[0].testFiles.sort());
});

test('project aliases resolve independently', (t) => {
  const config = fixture(t, {
    'a/value.js': 'export default 1;', 'b/value.js': 'export default 2;',
    'a/test.js': "import value from '@/value';", 'b/test.js': "import value from '@/value';",
  });
  config.projects = ['a', 'b'].map((name) => ({
    ...config.projects[0],
    testFiles: [path.join(config.rootDir, name, 'test.js')],
    resolveOptions: { extensions: ['.js'], alias: { '@': [path.join(config.rootDir, name)] } },
  }));
  assert.deepEqual(decideAffected({ config, changedFiles: ['a/value.js'] }), {
    kind: 'run-selected', testFiles: config.projects[0].testFiles,
  });
});

test('unresolved internal imports surface errors and cannot produce a successful empty selection', (t) => {
  const config = fixture(t, { 'math.test.js': "import './missing.js';" });
  const errors = [];
  const result = decideAffected({ config, changedFiles: ['unrelated.js'], onError: (error) => errors.push(error) });
  assert.equal(result.kind, 'run-all');
  assert.ok(errors.some((error) => error.includes('missing.js')));
});

for (const [name, source] of [
  ['unresolved bare import', "import 'missing-package';"],
  ['unresolved internal alias', "import '#internal/missing';"],
  ['dynamic require', "const target = './src/math.js'; require(target);"],
  ['source parse error', 'export const broken = ;'],
]) {
  test(`${name} runs all, with or without an error reporter`, (t) => {
    const config = fixture(t, { 'math.test.js': source });
    const errors = [];
    const options = { config, changedFiles: ['README.md'] };
    assert.equal(decideAffected({ ...options, onError: (error) => errors.push(error) }).kind, 'run-all');
    assert.ok(errors.length > 0);
    assert.equal(decideAffected(options).kind, 'run-all');
  });
}

test('unreadable candidate files cannot become a successful empty selection', (t) => {
  const config = fixture(t);
  rmSync(config.projects[0].testFiles[0]);
  assert.equal(decideAffected({ config, changedFiles: ['README.md'] }).kind, 'run-all');
});

test('a failed project invalidates a partial selection from another project', (t) => {
  const config = fixture(t, { 'math.test.js': "import './missing.js';" });
  const project = config.projects[0];
  config.projects = [project.testFiles[1], project.testFiles[0]].map((file) => ({ ...project, testFiles: [file] }));
  assert.equal(decideAffected({ config, changedFiles: ['src/util.js'] }).kind, 'run-all');
});

test('recognized Node builtins do not count as analysis failures', (t) => {
  const config = fixture(t, { 'math.test.js': "import path from 'node:path';" });
  config.projects[0].resolveOptions.builtinModules = true;
  const errors = [];
  assert.deepEqual(decideAffected({ config, changedFiles: ['README.md'], onError: (error) => errors.push(error) }), {
    kind: 'none',
  });
  assert.deepEqual(errors, []);
});

test('runAffected uses the runner only for discovery and execution', async (t) => {
  const config = fixture(t);
  const runs = [];
  const runner = {
    async loadConfig() { return config; },
    async run(files, args) { runs.push({ files, args }); return { success: false }; },
    async runAll(args) { runs.push({ all: true, args }); return { success: true }; },
  };
  assert.equal((await runAffected({ runner, changedFiles: [], passthrough: ['--ci'] })).success, true);
  assert.deepEqual(await runAffected({ runner, changedFiles: ['README.md'] }), { success: true, decision: { kind: 'none' } });
  assert.deepEqual(runs, []);
  assert.equal((await runAffected({ runner, changedFiles: ['src/math.js'], passthrough: ['--ci'] })).success, false);
  assert.deepEqual(runs[0], { files: [config.projects[0].testFiles[0]], args: ['--ci'] });
  await runAffected({ runner, changedFiles: ['setup.js'] });
  assert.deepEqual(runs[1], { all: true, args: [] });
});
