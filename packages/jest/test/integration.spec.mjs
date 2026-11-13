import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import pkg from '../dist/index.js';

const { JestRunner, decideAffected } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', '__fixtures__', 'basic');
const MULTI_FIXTURE = path.join(__dirname, '..', '__fixtures__', 'multi');

const require = createRequire(import.meta.url);

// jest must be installed (it's a devDependency); skip the suite otherwise.
let jestReady = false;
try {
  require.resolve('jest-config', { paths: [FIXTURE, __dirname] });
  jestReady = true;
} catch {
  /* jest not installed */
}

// sovra's native binding must be built for the real getAffected path.
let sovraReady = false;
try {
  const sovra = require('sovra');
  sovraReady = typeof sovra.getAffected === 'function';
} catch {
  /* binding not built */
}

test('JestRunner.loadConfig discovers test files and sentinels', { skip: !jestReady }, async () => {
  const runner = new JestRunner({ rootDir: FIXTURE });
  const config = await runner.loadConfig();

  assert.equal(config.projects.length, 1);
  const project = config.projects[0];
  const testBasenames = project.testFiles.map((f) => path.basename(f)).sort();
  assert.deepEqual(testBasenames, ['math.test.js', 'util.test.js']);

  assert.ok(
    project.sentinelFiles.some((f) => f.endsWith('setup.js')),
    'setup.js should be a sentinel',
  );
  assert.ok(
    project.sentinelFiles.some((f) => f.endsWith('jest.config.js')),
    'jest config should be a sentinel',
  );
  assert.ok(project.resolveOptions.extensions.includes('.js'));
});

test('JestRunner preserves modulePaths and mapper fallback arrays', { skip: !jestReady }, async () => {
  const runner = new JestRunner({
    rootDir: FIXTURE,
    configPath: path.join(FIXTURE, 'jest.resolver.config.js'),
  });
  const config = await runner.loadConfig();
  const project = config.projects[0];

  assert.ok(project.resolveOptions.modules.includes(path.join(FIXTURE, 'src')));
  assert.deepEqual(project.resolveOptions.alias.lib, [
    path.join(FIXTURE, 'src'),
    path.join(FIXTURE, 'fallback'),
  ]);
});

test(
  'decideAffected follows modulePaths and mapper fallback imports',
  { skip: !jestReady || !sovraReady },
  async () => {
    const runner = new JestRunner({
      rootDir: FIXTURE,
      configPath: path.join(FIXTURE, 'jest.resolver.config.js'),
    });
    const decision = await decideAffected({
      config: await runner.loadConfig(),
      cwd: FIXTURE,
      changedFiles: ['src/math.js'],
    });

    assert.equal(decision.kind, 'run-selected');
    assert.deepEqual(
      decision.testFiles.map((file) => path.basename(file)).sort(),
      ['alias.test.js', 'module-path.test.js'],
    );
  },
);

test('JestRunner keeps resolver options scoped to each project', { skip: !jestReady }, async () => {
  const runner = new JestRunner({ rootDir: MULTI_FIXTURE });
  const config = await runner.loadConfig();

  assert.equal(config.projects.length, 2);
  assert.deepEqual(
    config.projects.map((project) => project.resolveOptions.alias['@']),
    [
      [path.join(MULTI_FIXTURE, 'a/src')],
      [path.join(MULTI_FIXTURE, 'b/src')],
    ],
  );
});

test(
  'decideAffected selects only the dependent test for a source change',
  { skip: !jestReady || !sovraReady },
  async () => {
    const runner = new JestRunner({ rootDir: FIXTURE });
    const decision = await decideAffected({
      config: await runner.loadConfig(),
      cwd: FIXTURE,
      changedFiles: ['src/math.js'],
    });
    assert.equal(decision.kind, 'run-selected');
    assert.deepEqual(
      decision.testFiles.map((f) => path.basename(f)),
      ['math.test.js'],
    );
  },
);

test(
  'decideAffected falls back to run-all when a setup file changes',
  { skip: !jestReady || !sovraReady },
  async () => {
    const runner = new JestRunner({ rootDir: FIXTURE });
    const decision = await decideAffected({
      config: await runner.loadConfig(),
      cwd: FIXTURE,
      changedFiles: ['setup.js'],
    });
    assert.equal(decision.kind, 'run-all');
  },
);

test(
  'decideAffected resolves imports independently for each Jest project',
  { skip: !jestReady || !sovraReady },
  async () => {
    const runner = new JestRunner({ rootDir: MULTI_FIXTURE });
    const decision = await decideAffected({
      config: await runner.loadConfig(),
      cwd: MULTI_FIXTURE,
      changedFiles: ['a/src/value.js'],
    });

    assert.equal(decision.kind, 'run-selected');
    assert.deepEqual(decision.testFiles, [
      path.join(MULTI_FIXTURE, 'a/__tests__/value.test.js'),
    ]);
  },
);
