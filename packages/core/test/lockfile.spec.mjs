import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { diffDependencies, selectLockfile } from '../dist/index.js';

const manifest = JSON.stringify({ dependencies: { 'app-a': '^1.0.0', 'app-b': '^1.0.0' } });
const snapshot = (version) => ({
  filename: 'yarn.lock', manifest,
  contents: `# yarn lockfile v1
"app-a@^1.0.0":
  version "1.0.0"
  dependencies:
    shared "^1.0.0"
"app-b@^1.0.0":
  version "1.0.0"
  dependencies:
    shared "^2.0.0"
"shared@^1.0.0":
  version "${version}"
"shared@^2.0.0":
  version "2.0.0"
`,
});

test('yarn classic snapshots include affected hoisted packages by default', () => {
  assert.deepEqual(diffDependencies({ before: snapshot('1.0.0'), after: snapshot('1.0.1') }).sort(), ['app-a', 'shared']);
});

test('one explicit layout controls both snapshots', () => {
  const layout = { linker: 'isolated' };
  assert.deepEqual(diffDependencies({ before: snapshot('1.0.0'), after: snapshot('1.0.1'), layout }), ['app-a']);
});

test('identical snapshots have no changed dependencies', () => {
  assert.deepEqual(diffDependencies({ before: snapshot('1.0.0'), after: snapshot('1.0.0') }), []);
});

for (const added of [true, false]) {
  test(`${added ? 'added' : 'deleted'} lockfiles have an explicitly absent snapshot`, () => {
    assert.deepEqual(diffDependencies({
      before: added ? null : snapshot('1.0.0'), after: added ? snapshot('1.0.0') : null,
    }).sort(), ['app-a', 'app-b', 'shared']);
  });
}

test('each snapshot chooses its own parser when migrating package managers', () => {
  const before = { filename: 'package-lock.json', manifest: '{}', contents: JSON.stringify({
    lockfileVersion: 3, packages: { '': { dependencies: { old: '1.0.0' } }, 'node_modules/old': { version: '1.0.0' } },
  }) };
  assert.deepEqual(diffDependencies({ before, after: snapshot('1.0.0') }).sort(), ['app-a', 'app-b', 'old', 'shared']);
});

test('invalid snapshots throw instead of masquerading as no dependency changes', () => {
  assert.throws(() => diffDependencies({ before: null, after: { filename: 'unknown', contents: '', manifest: '' } }), /Unsupported/);
  assert.throws(() => diffDependencies({ before: null, after: { filename: 'package-lock.json', contents: '{', manifest: '' } }));
  assert.throws(() => diffDependencies({ before: null, after: { ...snapshot('1.0.0'), manifest: '{' } }));
  assert.throws(() => diffDependencies({ before: null, after: { filename: 'pnpm-lock.yaml', contents: 'lockfileVersion: 99', manifest: '{}' } }), /Unsupported pnpm/);
  assert.throws(() => diffDependencies({ before: null, after: { filename: 'pnpm-lock.yaml', contents: 'not: a lockfile', manifest: '{}' } }), /Unsupported pnpm/);
});

test('changed lockfiles are selected by nearest directory and filename priority', () => {
  const root = path.resolve('/repo');
  const project = path.join(root, 'packages/app');
  const file = (name) => path.join(root, name);
  assert.equal(selectLockfile(project, [file('packages/app/source.js'), file('package.json')]), undefined);
  assert.equal(selectLockfile(project, [file('pnpm-lock.yaml'), file('packages/app/yarn.lock')]), file('packages/app/yarn.lock'));
  assert.equal(selectLockfile(project, [file('yarn.lock'), file('pnpm-lock.yaml')]), file('pnpm-lock.yaml'));
  assert.equal(selectLockfile(project, [file('package-lock.json'), file('npm-shrinkwrap.json')]), file('npm-shrinkwrap.json'));
  assert.equal(selectLockfile(project, [file('packages/other/pnpm-lock.yaml')]), undefined);
});
