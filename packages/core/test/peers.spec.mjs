import assert from 'node:assert';
import { test } from 'node:test';

import { affectedDependencies } from '../dist/package-managers/graph.js';
import { npmFormat, yarnBerryFormat } from '../dist/package-managers/formats/index.js';

// Scenario: a component lib `comp` *peer*-depends on `react` (it has no regular
// deps). A test might import `comp` but never `react` directly. Bumping `react`
// must therefore flag `comp` too — otherwise that test would be skipped.

test('npm: a peer bump propagates to the peer-declaring package', () => {
  const manifest = JSON.stringify({ dependencies: { comp: '^1.0.0', react: '^18.0.0' } });
  const lock = (reactV) =>
    JSON.stringify({
      name: 'root',
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', dependencies: { comp: '^1.0.0', react: '^18.0.0' } },
        'node_modules/comp': { version: '1.0.0', peerDependencies: { react: '>=17' } },
        'node_modules/react': { version: reactV },
      },
    });
  const base = npmFormat.parse({ lockfile: lock('18.0.0'), manifest, importerPath: '.' });
  const head = npmFormat.parse({ lockfile: lock('18.1.0'), manifest, importerPath: '.' });

  // `comp` is flagged purely via the peer edge (it has no regular dependencies).
  assert.deepEqual(affectedDependencies(base, head, { surface: 'direct' }).sort(), ['comp', 'react']);
});

test('yarn berry: a peer bump propagates to the peer-declaring package', () => {
  const manifest = JSON.stringify({ dependencies: { comp: '^1.0.0', react: '^18.0.0' } });
  const lock = (reactV) => `__metadata:
  version: 6
"comp@npm:^1.0.0":
  version: 1.0.0
  resolution: "comp@npm:1.0.0"
  peerDependencies:
    react: "*"
"react@npm:^18.0.0":
  version: ${reactV}
  resolution: "react@npm:${reactV}"
`;
  const base = yarnBerryFormat.parse({ lockfile: lock('18.0.0'), manifest, importerPath: '.' });
  const head = yarnBerryFormat.parse({ lockfile: lock('18.1.0'), manifest, importerPath: '.' });

  assert.deepEqual(affectedDependencies(base, head, { surface: 'direct' }).sort(), ['comp', 'react']);
});

test('an unrelated package is not dragged in by a peer bump', () => {
  const manifest = JSON.stringify({ dependencies: { comp: '^1.0.0', react: '^18.0.0', other: '^1.0.0' } });
  const lock = (reactV) =>
    JSON.stringify({
      name: 'root',
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', dependencies: { comp: '^1.0.0', react: '^18.0.0', other: '^1.0.0' } },
        'node_modules/comp': { version: '1.0.0', peerDependencies: { react: '>=17' } },
        'node_modules/other': { version: '1.0.0' },
        'node_modules/react': { version: reactV },
      },
    });
  const base = npmFormat.parse({ lockfile: lock('18.0.0'), manifest, importerPath: '.' });
  const head = npmFormat.parse({ lockfile: lock('18.1.0'), manifest, importerPath: '.' });

  const affected = affectedDependencies(base, head, { surface: 'direct' });
  assert.ok(!affected.includes('other'), '`other` must not be affected by a react bump');
  assert.deepEqual(affected.sort(), ['comp', 'react']);
});
