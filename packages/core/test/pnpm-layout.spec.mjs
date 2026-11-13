import assert from 'node:assert/strict';
import { test } from 'node:test';

import core from '../dist/index.js';
import layout from '../dist/package-managers/pnpm-layout.js';

const { diffDependencies, parsePnpmLayout } = core;
const { createPublicHoistMatcher } = layout;

test('pnpm public patterns support scoped names, arrays, quotes, and exclusions', () => {
  const value = parsePnpmLayout({
    npmrc: 'public-hoist-pattern[]="@scope/*"\npublic-hoist-pattern[]=*eslint*\npublic-hoist-pattern[]=!@scope/private\n',
  });
  const isPubliclyHoisted = createPublicHoistMatcher(value);
  assert.equal(isPubliclyHoisted('@scope/tool'), true);
  assert.equal(isPubliclyHoisted('eslint-plugin-example'), true);
  assert.equal(isPubliclyHoisted('@scope/private'), false);
  assert.equal(isPubliclyHoisted('unrelated'), false);
});

test('pnpm private hoistPattern does not expose phantom imports', () => {
  const value = parsePnpmLayout({ workspace: "hoistPattern: ['*']\n" });
  assert.equal(createPublicHoistMatcher(value)('shared'), false);
});

test('pnpm workspace YAML overrides npmrc settings', () => {
  const value = parsePnpmLayout({
    npmrc: 'node-linker=hoisted\npublic-hoist-pattern[]=*\n',
    workspace: "nodeLinker: isolated\npublicHoistPattern: ['shared']\n",
  });
  assert.equal(value.linker, 'isolated');
  const isPubliclyHoisted = createPublicHoistMatcher(value);
  assert.equal(isPubliclyHoisted('shared'), true);
  assert.equal(isPubliclyHoisted('hidden'), false);
});

test('pnpm patterns preserve ordered re-inclusion and negative-only matching', () => {
  const value = parsePnpmLayout({ workspace: "publicHoistPattern: ['*', '!@scope/*', '@scope/shared']\n" });
  const isPubliclyHoisted = createPublicHoistMatcher(value);
  assert.equal(isPubliclyHoisted('@scope/shared'), true);
  assert.equal(isPubliclyHoisted('@scope/hidden'), false);
  assert.equal(isPubliclyHoisted('@scope/shared'), true);
  const negative = parsePnpmLayout({ npmrc: 'public-hoist-pattern[]=!hidden\n' });
  const matchesNegative = createPublicHoistMatcher(negative);
  assert.equal(matchesNegative('shared'), true);
  assert.equal(matchesNegative('hidden'), false);
  assert.equal(matchesNegative('shared'), true);
});

test('compiled pnpm patterns treat regex metacharacters literally and are reusable', () => {
  const isPubliclyHoisted = createPublicHoistMatcher({
    linker: 'isolated', publicHoistPatterns: ['pkg.+(literal)[1]', '@scope/tool.*'],
  });
  for (let i = 0; i < 2; i++) {
    assert.equal(isPubliclyHoisted('pkg.+(literal)[1]'), true);
    assert.equal(isPubliclyHoisted('pkgXliteral1'), false);
    assert.equal(isPubliclyHoisted('@scope/tool.js'), true);
    assert.equal(isPubliclyHoisted('@scope/toolXjs'), false);
  }
});

test('pnpm pnp does not expose phantom imports even with hoist settings', () => {
  const value = parsePnpmLayout({ npmrc: 'node-linker=pnp\nshamefully-hoist=true\n' });
  assert.equal(value.linker, 'pnp');
  assert.equal(createPublicHoistMatcher(value)('shared'), false);
});

const lock = (version, removed = false) => `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      app:
        specifier: 1.0.0
        version: 1.0.0
snapshots:
  app@1.0.0:
    dependencies:
      shared: ${version}
${removed ? '' : `      hidden: ${version}`}
  shared@${version}: {}
${removed ? '' : `  hidden@${version}: {}`}
`;

function changed(files, options = {}, removed = false) {
  const layout = options.linker
    ? { linker: options.linker }
    : parsePnpmLayout({
      manifest: files['package.json'], npmrc: files['.npmrc'],
      workspace: files['pnpm-workspace.yaml'],
    });
  const snapshot = (contents) => ({ filename: 'pnpm-lock.yaml', contents, manifest: '{}' });
  return diffDependencies({ before: snapshot(lock('1.0.0')), after: snapshot(lock('1.0.1', removed)), layout }).sort();
}

for (const [name, files, expected] of [
  ['default isolated', {}, ['app']],
  ['private hoisting', { '.npmrc': 'hoist-pattern[]=*\n' }, ['app']],
  ['selective public hoisting', { 'pnpm-workspace.yaml': "publicHoistPattern: ['shared']\n" }, ['app', 'shared']],
  ['negated public patterns', { '.npmrc': 'public-hoist-pattern[]=*\npublic-hoist-pattern[]=!hidden\n' }, ['app', 'shared']],
  ['hoisted linker', { '.npmrc': 'node-linker=hoisted\n' }, ['app', 'hidden', 'shared']],
  ['shameful hoisting', { 'pnpm-workspace.yaml': 'shamefullyHoist: true\n' }, ['app', 'hidden', 'shared']],
  ['pnp linker', { 'pnpm-workspace.yaml': "nodeLinker: pnp\npublicHoistPattern: ['*']\n" }, ['app']],
  ['legacy manifest hoisting', { 'package.json': JSON.stringify({ pnpm: { 'shamefully-hoist': true } }) }, ['app', 'hidden', 'shared']],
]) {
  test(`pnpm lockfile diff respects ${name}`, () => {
    assert.deepEqual(changed(files), expected);
  });
}

test('explicit isolated override excludes pnpm public hoists', () => {
  assert.deepEqual(changed({ '.npmrc': 'shamefully-hoist=true\n' }, { linker: 'isolated' }), ['app']);
});

test('removed publicly hoisted packages remain affected', () => {
  assert.deepEqual(changed({ '.npmrc': 'public-hoist-pattern[]=hidden\n' }, {}, true), ['app', 'hidden']);
});

for (const added of [true, false]) {
  test(`the shared layout applies to ${added ? 'added' : 'deleted'} pnpm lockfiles`, () => {
    const snapshot = { filename: 'pnpm-lock.yaml', contents: lock('1.0.0'), manifest: '{}' };
    assert.deepEqual(diffDependencies({
      before: added ? null : snapshot, after: added ? snapshot : null,
      layout: { linker: 'isolated', publicHoistPatterns: ['shared'] },
    }).sort(), ['app', 'shared']);
  });
}
