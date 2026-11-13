import assert from 'node:assert';
import { test } from 'node:test';

import { diffDependencies } from '../dist/index.js';
import { affectedDependencies } from '../dist/package-managers/graph.js';
import { npmFormat, yarnClassicFormat } from '../dist/package-managers/formats/index.js';

// An npm tree where `shared` is a *phantom* (transitive-only) dep hoisted to the
// top level: only `app-a` is declared in the manifest.
const NPM_MANIFEST = JSON.stringify({ dependencies: { 'app-a': '^1.0.0' } });
const npmLock = (sharedV) =>
  JSON.stringify({
    name: 'root',
    lockfileVersion: 3,
    packages: {
      '': { name: 'root', dependencies: { 'app-a': '^1.0.0' } },
      'node_modules/app-a': { version: '1.0.0', dependencies: { shared: '^1.0.0' } },
      'node_modules/shared': { version: sharedV },
    },
  });

test('isolated surface ignores phantom deps; hoisted surface includes them', () => {
  const base = npmFormat.parse({ lockfile: npmLock('1.0.0'), manifest: NPM_MANIFEST, importerPath: '.' });
  const head = npmFormat.parse({ lockfile: npmLock('1.0.1'), manifest: NPM_MANIFEST, importerPath: '.' });

  // direct (isolated): only the declared dep that transitively changed.
  assert.deepEqual(affectedDependencies(base, head, { surface: 'direct' }), ['app-a']);

  // hoisted (npm precise): the phantom `shared` is importable, so it surfaces too.
  assert.deepEqual(
    affectedDependencies(base, head, { surface: 'hoisted' }).sort(),
    ['app-a', 'shared'],
  );
});
test('all surface emits every affected instance name (conservative hoisting)', () => {
  const MANIFEST = JSON.stringify({ dependencies: { 'app-a': '^1.0.0', 'app-b': '^1.0.0' } });
  const lock = (sharedV) => `# yarn lockfile v1
"app-a@^1.0.0":
  version "1.0.0"
  dependencies:
    shared "^1.0.0"
"app-b@^1.0.0":
  version "1.0.0"
  dependencies:
    shared "^2.0.0"
"shared@^1.0.0":
  version "${sharedV}"
"shared@^2.0.0":
  version "2.0.0"
`;
  const base = yarnClassicFormat.parse({ lockfile: lock('1.0.0'), manifest: MANIFEST, importerPath: '.' });
  const head = yarnClassicFormat.parse({ lockfile: lock('1.0.1'), manifest: MANIFEST, importerPath: '.' });

  // Only app-a's shared@1.0.0 -> 1.0.1 changed; app-b (on shared@2.0.0) untouched.
  assert.deepEqual(affectedDependencies(base, head, { surface: 'all' }).sort(), ['app-a', 'shared']);
  assert.deepEqual(affectedDependencies(base, head, { surface: 'direct' }), ['app-a']);
});

test('npm snapshots include affected hoisted packages by default', () => {
  const snapshot = (version) => ({
    filename: 'package-lock.json', contents: npmLock(version), manifest: NPM_MANIFEST,
  });
  assert.deepEqual(
    diffDependencies({ before: snapshot('1.0.0'), after: snapshot('1.0.1') }).sort(),
    ['app-a', 'shared'],
  );
});
