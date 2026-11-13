import assert from 'node:assert';
import { test } from 'node:test';

import { affectedDependencies } from '../dist/package-managers/graph.js';
import { npmFormat, pnpmFormat, yarnClassicFormat, yarnBerryFormat } from '../dist/package-managers/formats/index.js';

// Every fixture encodes the same scenario:
//   - app-a (direct) depends on shared@^1.0.0
//   - app-b (direct) depends on shared@^2.0.0
//   - the head lockfile bumps shared's 1.0.0 line to 1.0.1
// so the correct, version-aware answer is: only app-a is affected.
const MANIFEST = JSON.stringify({
  dependencies: { 'app-a': '^1.0.0', 'app-b': '^1.0.0' },
});

function check(format, base, head, importerPath = '.') {
  const baseGraph = format.parse({ lockfile: base, manifest: MANIFEST, importerPath });
  const headGraph = format.parse({ lockfile: head, manifest: MANIFEST, importerPath });
  return affectedDependencies(baseGraph, headGraph);
}

test('npm package-lock v3', () => {
  const base = JSON.stringify({
    name: 'root',
    lockfileVersion: 3,
    packages: {
      '': { name: 'root', dependencies: { 'app-a': '^1.0.0', 'app-b': '^1.0.0' } },
      'node_modules/app-a': { version: '1.0.0', dependencies: { shared: '^1.0.0' } },
      'node_modules/app-b': { version: '1.0.0', dependencies: { shared: '^2.0.0' } },
      'node_modules/app-a/node_modules/shared': { version: '1.0.0' },
      'node_modules/shared': { version: '2.0.0' },
    },
  });
  const head = JSON.stringify({
    name: 'root',
    lockfileVersion: 3,
    packages: {
      '': { name: 'root', dependencies: { 'app-a': '^1.0.0', 'app-b': '^1.0.0' } },
      'node_modules/app-a': { version: '1.0.0', dependencies: { shared: '^1.0.0' } },
      'node_modules/app-b': { version: '1.0.0', dependencies: { shared: '^2.0.0' } },
      'node_modules/app-a/node_modules/shared': { version: '1.0.1' },
      'node_modules/shared': { version: '2.0.0' },
    },
  });
  assert.deepEqual(check(npmFormat, base, head), ['app-a']);
});

test('pnpm-lock v9', () => {
  const base = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      app-a:
        specifier: ^1.0.0
        version: 1.0.0
      app-b:
        specifier: ^1.0.0
        version: 1.0.0
snapshots:
  app-a@1.0.0:
    dependencies:
      shared: 1.0.0
  app-b@1.0.0:
    dependencies:
      shared: 2.0.0
  shared@1.0.0: {}
  shared@2.0.0: {}
`;
  const head = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      app-a:
        specifier: ^1.0.0
        version: 1.0.0
      app-b:
        specifier: ^1.0.0
        version: 1.0.0
snapshots:
  app-a@1.0.0:
    dependencies:
      shared: 1.0.1
  app-b@1.0.0:
    dependencies:
      shared: 2.0.0
  shared@1.0.1: {}
  shared@2.0.0: {}
`;
  assert.deepEqual(check(pnpmFormat, base, head), ['app-a']);
});

test('yarn classic v1', () => {
  const base = `# yarn lockfile v1
"app-a@^1.0.0":
  version "1.0.0"
  dependencies:
    shared "^1.0.0"

"app-b@^1.0.0":
  version "1.0.0"
  dependencies:
    shared "^2.0.0"

"shared@^1.0.0":
  version "1.0.0"

"shared@^2.0.0":
  version "2.0.0"
`;
  const head = base.replace('"shared@^1.0.0":\n  version "1.0.0"', '"shared@^1.0.0":\n  version "1.0.1"');
  assert.deepEqual(check(yarnClassicFormat, base, head), ['app-a']);
});

test('yarn berry v2+', () => {
  const base = `__metadata:
  version: 6
"app-a@npm:^1.0.0":
  version: 1.0.0
  resolution: "app-a@npm:1.0.0"
  dependencies:
    shared: "npm:^1.0.0"
"app-b@npm:^1.0.0":
  version: 1.0.0
  resolution: "app-b@npm:1.0.0"
  dependencies:
    shared: "npm:^2.0.0"
"shared@npm:^1.0.0":
  version: 1.0.0
  resolution: "shared@npm:1.0.0"
"shared@npm:^2.0.0":
  version: 2.0.0
  resolution: "shared@npm:2.0.0"
`;
  const head = base.replace(
    '"shared@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "shared@npm:1.0.0"',
    '"shared@npm:^1.0.0":\n  version: 1.0.1\n  resolution: "shared@npm:1.0.1"',
  );
  assert.deepEqual(check(yarnBerryFormat, base, head), ['app-a']);
});

test('yarn berry npm aliases retain their resolved package identity', () => {
  const manifest = JSON.stringify({
    dependencies: { alias: 'npm:real@^1.0.0' },
  });
  const lock = (sharedVersion) => `__metadata:
  version: 6
"alias@npm:real@^1.0.0":
  version: 1.0.0
  resolution: "real@npm:1.0.0"
  dependencies:
    shared: "npm:^1.0.0"
"shared@npm:^1.0.0":
  version: ${sharedVersion}
  resolution: "shared@npm:${sharedVersion}"
`;
  const base = yarnBerryFormat.parse({
    lockfile: lock('1.0.0'),
    manifest,
    importerPath: '.',
  });
  const head = yarnBerryFormat.parse({
    lockfile: lock('1.0.1'),
    manifest,
    importerPath: '.',
  });

  assert.deepEqual([...base.roots], [['alias', 'real@1.0.0']]);
  assert.deepEqual(affectedDependencies(base, head), ['alias']);
});
