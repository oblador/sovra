import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { diffDependencies } from '../dist/index.js';
import { pnpmFormat } from '../dist/package-managers/formats/index.js';

const snapshot = (lock, importerPath = '.') => ({
  filename: 'pnpm-lock.yaml', contents: typeof lock === 'string' ? lock : JSON.stringify(lock),
  manifest: '{}', importerPath,
});
const diff = (before, after, options = {}) => diffDependencies({
  before: snapshot(before, options.importerPath), after: snapshot(after, options.importerPath), ...options,
}).sort();
const parse = lock => pnpmFormat.parse({ lockfile: JSON.stringify(lock), manifest: '{}', importerPath: '.' });
const basic = (version = '1.0.0') => ({
  lockfileVersion: '13.0',
  projects: { '.': { dependencies: { 'app-a': { specifier: '^1.0.0', version: '1.0.0' }, 'app-b': '1.0.0' } } },
  packages: {
    'app-a@1.0.0': { dependencies: { shared: version } },
    'app-b@1.0.0': { dependencies: { shared: '2.0.0' } },
    [`shared@${version}`]: {}, 'shared@2.0.0': {},
  },
});

test('v13 reads tab-indented JSON with trailing commas as YAML', () => {
  const lock = `{
	"lockfileVersion": "13.0",
	"projects": {
		".": {
			"dependencies": { "app": "1.0.0", },
		},
	},
	"packages": {
		"app@1.0.0": { "dependencies": { "child": "1.0.0", }, },
		"child@1.0.0": {},
	},
}`;
  assert.deepEqual(diff(lock, lock.replaceAll('child": "1.0.0', 'child": "1.0.1').replace('child@1.0.0', 'child@1.0.1')), ['app']);
});

for (const lockfileVersion of ['13.0', 13]) {
  test(`v13 detects only consumers of the changed version (${typeof lockfileVersion} header)`, () => {
    assert.deepEqual(diff({ ...basic(), lockfileVersion }, { ...basic('1.0.1'), lockfileVersion }), ['app-a']);
    assert.deepEqual(diff(basic(), basic()), []);
  });
}

test('v13 compares added and removed roots and respects public hoists', () => {
  assert.deepEqual(diffDependencies({ before: null, after: snapshot(basic()) }).sort(), ['app-a', 'app-b']);
  assert.deepEqual(diffDependencies({ before: snapshot(basic()), after: null }).sort(), ['app-a', 'app-b']);
  assert.deepEqual(diff(basic(), basic('1.0.1'), { layout: { linker: 'isolated', publicHoistPatterns: ['shared'] } }), ['app-a', 'shared']);
  const after = basic();
  delete after.projects['.'].dependencies['app-a'];
  assert.deepEqual(diff(basic(), after), ['app-a']);
});

test('v13 selects workspace projects and includes dev and optional dependencies', () => {
  const before = basic();
  before.projects['packages/app'] = {
    devDependencies: { dev: 'npm:app-a@1.0.0' }, optionalDependencies: { optional: { specifier: '*', version: 'app-a@1.0.0' } },
  };
  const after = structuredClone(before);
  after.packages['app-a@1.0.0'].dependencies.shared = '1.0.1';
  after.packages['shared@1.0.1'] = {};
  assert.deepEqual(diff(before, after, { importerPath: 'packages/app' }), ['dev', 'optional']);
  assert.deepEqual(diff(before, after, { importerPath: '' }), ['app-a']);
});

test('v13 resolves default and named catalogs, including scoped npm aliases', () => {
  const before = {
    lockfileVersion: '13.0',
    settings: { catalogs: {
      default: { app: { specifier: '^1.0.0', version: '1.0.0' } },
      tools: { alias: 'npm:@scope/tool@1.0.0', ranged: { specifier: 'npm:@scope/tool@^1', version: '1.0.0' } },
    } },
    projects: { '.': { dependencies: { app: 'catalog:', alias: 'catalog:tools', ranged: 'catalog:tools' } } },
    packages: { 'app@1.0.0': {}, '@scope/tool@1.0.0': { optionalDependencies: { child: '1.0.0' } }, 'child@1.0.0': {} },
  };
  const graph = parse(before);
  assert.equal(graph.roots.get('alias'), '@scope/tool@1.0.0');
  assert.equal(graph.roots.get('ranged'), '@scope/tool@1.0.0');
  const after = structuredClone(before);
  after.packages['@scope/tool@1.0.0'].optionalDependencies.child = '1.0.1';
  after.packages['child@1.0.1'] = {};
  assert.deepEqual(diff(before, after), ['alias', 'ranged']);
  after.settings.catalogs.default.app.version = '1.0.1';
  after.packages['app@1.0.1'] = {};
  assert.deepEqual(diff(before, after), ['alias', 'app', 'ranged']);
});

test('v13 rejects missing catalog resolutions instead of silently dropping roots', () => {
  const lock = basic();
  lock.projects['.'].dependencies['app-a'] = 'catalog:missing';
  assert.throws(() => parse(lock), /missing catalog/);
});

test('v13 preserves direct and transitive npm aliases', () => {
  const before = basic();
  before.projects['.'].dependencies.alias = 'npm:@scope/tool@1.0.0';
  before.packages['app-a@1.0.0'].dependencies = { renamed: '@scope/tool@1.0.0' };
  before.packages['@scope/tool@1.0.0'] = { dependencies: { shared: '1.0.0' } };
  const after = structuredClone(before);
  after.packages['@scope/tool@1.0.0'].dependencies.shared = '1.0.1';
  after.packages['shared@1.0.1'] = {};
  assert.deepEqual(diff(before, after), ['alias', 'app-a']);
});

const variants = () => ({
  lockfileVersion: '13.0',
  projects: { '.': { dependencies: { 'app-a': '1.0.0', 'app-b': '1.0.0' } } },
  packages: {
    'app-a@1.0.0': { dependencies: { plugin: '1.0.0', react: '17.0.0' } },
    'app-b@1.0.0': { dependencies: { plugin: '1.0.0', react: '18.0.0' } },
    'plugin@1.0.0': {
      dependencies: { common: '1.0.0' },
      peerDependencies: { react: '*', missing: { specifier: '*', optional: true } },
      snapshots: [
        { peerDependencies: { react: { version: '17.0.0' } }, optionalDependencies: { child: '1.0.0' } },
        { peerDependencies: { react: { version: '18.0.0' } }, optionalDependencies: { child: '2.0.0' } },
      ],
    },
    'react@17.0.0': {}, 'react@18.0.0': {}, 'common@1.0.0': {}, 'child@1.0.0': {}, 'child@2.0.0': {},
  },
});

test('v13 resolves snapshot variants from parent scope and merges shared dependencies', () => {
  const before = variants();
  const after = structuredClone(before);
  after.packages['plugin@1.0.0'].snapshots[0].optionalDependencies.child = '1.0.1';
  after.packages['child@1.0.1'] = {};
  assert.deepEqual(diff(before, after), ['app-a']);
  after.packages['plugin@1.0.0'].dependencies.common = '1.0.1';
  after.packages['common@1.0.1'] = {};
  assert.deepEqual(diff(before, after), ['app-a', 'app-b']);
});

test('v13 propagates a resolved peer provider\'s transitive changes', () => {
  const before = variants();
  before.packages['react@17.0.0'].dependencies = { shared: '1.0.0' };
  before.packages['shared@1.0.0'] = {};
  const after = structuredClone(before);
  after.packages['react@17.0.0'].dependencies.shared = '1.0.1';
  after.packages['shared@1.0.1'] = {};
  assert.deepEqual(diff(before, after), ['app-a']);
});

test('v13 explicit with bindings override parent scope for roots and transitive deps', () => {
  const before = variants();
  before.projects['.'].dependencies.plugin = { specifier: '1.0.0', with: { react: '18.0.0' } };
  before.packages['app-a@1.0.0'].dependencies.plugin = { version: '1.0.0', with: { react: '18.0.0' } };
  const after = structuredClone(before);
  after.packages['plugin@1.0.0'].snapshots[1].optionalDependencies.child = '2.0.1';
  after.packages['child@2.0.1'] = {};
  assert.deepEqual(diff(before, after), ['app-a', 'app-b', 'plugin']);
});

test('v13 empty with bindings select unbound optional peers', () => {
  const before = variants();
  before.packages['plugin@1.0.0'].snapshots.push({});
  before.projects['.'].dependencies.unbound = { specifier: 'npm:plugin@1.0.0', with: {} };
  const after = structuredClone(before);
  after.packages['plugin@1.0.0'].snapshots[0].peerDependencies.react.version = '17.0.1';
  after.packages['app-a@1.0.0'].dependencies.react = '17.0.1';
  after.packages['react@17.0.1'] = {};
  assert.deepEqual(diff(before, after), ['app-a']);
  assert.equal(parse(before).roots.get('unbound'), 'plugin@1.0.0');
});

test('v13 nested with bindings distinguish peer providers with their own peers', () => {
  const before = {
    lockfileVersion: '13.0',
    projects: { '.': { dependencies: {
      first: { specifier: 'npm:consumer@1.0.0', with: { provider: { version: '1.0.0', with: { core: '1.0.0' } } } },
      second: { specifier: 'npm:consumer@1.0.0', with: { provider: { version: '1.0.0', with: { core: '2.0.0' } } } },
    } } },
    packages: {
      'consumer@1.0.0': { snapshots: [
        { peerDependencies: { provider: { version: '1.0.0', with: { core: '1.0.0' } } } },
        { peerDependencies: { provider: { version: '1.0.0', with: { core: '2.0.0' } } } },
      ] },
      'provider@1.0.0': { snapshots: [
        { peerDependencies: { core: { version: '1.0.0' } } },
        { peerDependencies: { core: { version: '2.0.0' } } },
      ] },
      'core@1.0.0': {}, 'core@2.0.0': { dependencies: { child: '1.0.0' } }, 'child@1.0.0': {},
    },
  };
  const after = structuredClone(before);
  after.packages['core@2.0.0'].dependencies.child = '1.0.1';
  after.packages['child@1.0.1'] = {};
  assert.deepEqual(diff(before, after), ['second']);
});

test('v13 resolves a peer provider variant through the parent that links it', () => {
  const before = variants();
  before.projects['.'].dependencies = {
    consumer: '1.0.0', plugin: { specifier: '1.0.0', with: { react: '18.0.0' } },
  };
  before.packages['consumer@1.0.0'] = { peerDependencies: { plugin: { specifier: '*', version: '1.0.0' } } };
  const after = structuredClone(before);
  after.packages['plugin@1.0.0'].snapshots[1].optionalDependencies.child = '2.0.1';
  after.packages['child@2.0.1'] = {};
  assert.deepEqual(diff(before, after), ['consumer', 'plugin']);
});

test('v13 snapshot ordering and moving shared fields do not report changes', () => {
  const before = variants();
  const after = structuredClone(before);
  after.packages['plugin@1.0.0'].snapshots.reverse();
  for (const variant of after.packages['plugin@1.0.0'].snapshots) variant.dependencies = { common: '1.0.0' };
  delete after.packages['plugin@1.0.0'].dependencies;
  assert.deepEqual(diff(before, after), []);
});

test('v13 below peers propagate changes, while unbound peer ranges do not create edges', () => {
  const before = basic();
  before.packages['app-a@1.0.0'].peerDependencies = { react: { version: '17.0.0', below: true }, absent: '1.0.0' };
  before.packages['react@17.0.0'] = { dependencies: { child: '1.0.0' } };
  before.packages['child@1.0.0'] = {};
  const after = structuredClone(before);
  after.packages['react@17.0.0'].dependencies.child = '1.0.1';
  after.packages['child@1.0.1'] = {};
  assert.deepEqual(diff(before, after), ['app-a']);
  assert.equal(parse(before).packages.get('app-a@1.0.0(react@17.0.0)').peers.length, 1);
});

test('v13 supports cycles and packages that provide their own child\'s peer', () => {
  const before = variants();
  before.projects['.'].dependencies = { react: '17.0.0' };
  before.packages['react@17.0.0'].dependencies = { plugin: '1.0.0' };
  const after = structuredClone(before);
  after.packages['plugin@1.0.0'].snapshots[0].optionalDependencies.child = '1.0.1';
  after.packages['child@1.0.1'] = {};
  assert.deepEqual(diff(before, after), ['react']);
});

test('v13 handles linked and injected workspace deps and local package specifiers', () => {
  const before = {
    lockfileVersion: '13.0',
    projects: {
      '.': { dependencies: { linked: 'workspace:*', injected: { specifier: 'workspace:*', injected: true }, local: 'file:local' } },
      'packages/linked': { name: 'linked' },
    },
    packages: {
      'injected@file:packages/injected': { dependencies: { shared: { specifier: '^1', version: '1.0.0' }, absent: { specifier: '^2' } } },
      'local@file:local': { dependencies: { shared: '1.0.0' } }, 'shared@1.0.0': {},
    },
  };
  assert.equal(parse(before).roots.has('linked'), false);
  const after = structuredClone(before);
  after.packages['injected@file:packages/injected'].dependencies.shared.version = '1.0.1';
  after.packages['shared@1.0.1'] = {};
  assert.deepEqual(diff(before, after), ['injected']);
});

test('v13 detects changes to patch hashes recorded in settings', () => {
  const before = basic();
  before.settings = { patchedDependencies: { 'shared@1.0.0': { hash: 'old', path: 'shared.patch' } } };
  const after = structuredClone(before);
  after.settings.patchedDependencies['shared@1.0.0'].hash = 'new';
  assert.deepEqual(diff(before, after), ['app-a']);
});

test('v13 reads the project document after a v9 boot document', () => {
  const boot = "---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    packageManagerDependencies:\n      pnpm: { specifier: 12.22.0, version: 12.22.0 }\n---\n";
  assert.deepEqual(diff(boot + JSON.stringify(basic()), boot + JSON.stringify(basic('1.0.1'))), ['app-a']);
  assert.deepEqual(diff(boot + JSON.stringify(basic()), boot.replaceAll('12.22.0', '12.23.0') + JSON.stringify(basic())), []);
});

test('v9 to v13 migration without dependency changes produces no affected roots', () => {
  const before = basic();
  before.lockfileVersion = '9.0';
  before.importers = { '.': { dependencies: { 'app-a': { specifier: '^1.0.0', version: '1.0.0' }, 'app-b': { specifier: '1.0.0', version: '1.0.0' } } } };
  before.snapshots = before.packages;
  delete before.projects;
  delete before.packages;
  assert.deepEqual(diff(before, basic()), []);
  assert.deepEqual(diff(before, basic('1.0.1')), ['app-a']);
});

test('pnpm 12.22-generated v13 lockfiles keep the unaffected workspace and alias unchanged', () => {
  // Generated with `pnpm install --lockfile-only --ignore-scripts` and
  // lockfile.format: v13. Both workspaces use react-dom via catalog: 18.2.0;
  // packages/a updates React 18.2.0 -> 18.3.0, packages/b keeps React 18.3.1.
  // The root's npm:react-dom@18.2.0 alias explicitly binds React 18.3.1.
  // Only the project document is retained; boot documents are tested above.
  const before = readFileSync(new URL('../__fixtures__/pnpm-v13/before.yaml', import.meta.url), 'utf8');
  const after = readFileSync(new URL('../__fixtures__/pnpm-v13/after.yaml', import.meta.url), 'utf8');
  assert.deepEqual(diff(before, after, { importerPath: 'packages/a' }), ['react', 'react-dom']);
  assert.deepEqual(diff(before, after, { importerPath: 'packages/b' }), []);
  assert.deepEqual(diff(before, after), []);
});
