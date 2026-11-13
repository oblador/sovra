import assert from 'node:assert';
import { test } from 'node:test';

import { affectedDependencies } from '../dist/package-managers/graph.js';

// Build a DependencyGraph from a compact literal:
//   roots:    { name: 'key' }
//   packages: { key: { name, version, deps: { depName: 'targetKey' } } }
function graph(roots, packages) {
  const packageMap = new Map();
  for (const [key, p] of Object.entries(packages)) {
    packageMap.set(key, {
      key,
      name: p.name,
      version: p.version,
      dependencies: new Map(Object.entries(p.deps ?? {})),
    });
  }
  return { packages: packageMap, roots: new Map(Object.entries(roots)) };
}

test('version-aware: bumping a shared dep only affects the dependent on that version', () => {
  const base = graph(
    { x: 'x@1.0.0', z: 'z@1.0.0' },
    {
      'x@1.0.0': { name: 'x', version: '1.0.0', deps: { y: 'y@1.0.0' } },
      'z@1.0.0': { name: 'z', version: '1.0.0', deps: { y: 'y@2.0.0' } },
      'y@1.0.0': { name: 'y', version: '1.0.0' },
      'y@2.0.0': { name: 'y', version: '2.0.0' },
    },
  );
  // y@1.0.0 bumped to y@1.1.0; x now points at it, z still points at y@2.0.0.
  const head = graph(
    { x: 'x@1.0.0', z: 'z@1.0.0' },
    {
      'x@1.0.0': { name: 'x', version: '1.0.0', deps: { y: 'y@1.1.0' } },
      'z@1.0.0': { name: 'z', version: '1.0.0', deps: { y: 'y@2.0.0' } },
      'y@1.1.0': { name: 'y', version: '1.1.0' },
      'y@2.0.0': { name: 'y', version: '2.0.0' },
    },
  );
  assert.deepEqual(affectedDependencies(base, head), ['x']);
});

test('transitive: a deep bump propagates up to the direct dependency', () => {
  const base = graph(
    { a: 'a@1.0.0' },
    {
      'a@1.0.0': { name: 'a', version: '1.0.0', deps: { b: 'b@1.0.0' } },
      'b@1.0.0': { name: 'b', version: '1.0.0', deps: { c: 'c@1.0.0' } },
      'c@1.0.0': { name: 'c', version: '1.0.0' },
    },
  );
  const head = graph(
    { a: 'a@1.0.0' },
    {
      'a@1.0.0': { name: 'a', version: '1.0.0', deps: { b: 'b@1.0.0' } },
      'b@1.0.0': { name: 'b', version: '1.0.0', deps: { c: 'c@2.0.0' } },
      'c@2.0.0': { name: 'c', version: '2.0.0' },
    },
  );
  assert.deepEqual(affectedDependencies(base, head), ['a']);
});

test('a direct dependency version bump is reported', () => {
  const base = graph({ x: 'x@1.0.0' }, { 'x@1.0.0': { name: 'x', version: '1.0.0' } });
  const head = graph({ x: 'x@2.0.0' }, { 'x@2.0.0': { name: 'x', version: '2.0.0' } });
  assert.deepEqual(affectedDependencies(base, head), ['x']);
});

test('added and removed direct dependencies are reported', () => {
  const base = graph({ x: 'x@1.0.0' }, { 'x@1.0.0': { name: 'x', version: '1.0.0' } });
  const head = graph({ y: 'y@1.0.0' }, { 'y@1.0.0': { name: 'y', version: '1.0.0' } });
  assert.deepEqual(affectedDependencies(base, head).sort(), ['x', 'y']);
});

test('no change yields no affected dependencies', () => {
  const g = graph(
    { x: 'x@1.0.0' },
    {
      'x@1.0.0': { name: 'x', version: '1.0.0', deps: { y: 'y@1.0.0' } },
      'y@1.0.0': { name: 'y', version: '1.0.0' },
    },
  );
  assert.deepEqual(affectedDependencies(g, g), []);
});

test('all and public-hoist surfaces preserve aliases and remaps to existing instances', () => {
  const packages = {
    'x@1.0.0': { name: 'x', version: '1.0.0' },
    'x@2.0.0': { name: 'x', version: '2.0.0' },
  };
  const base = graph({ alias: 'x@1.0.0', removed: 'x@1.0.0' }, packages);
  const head = graph({ alias: 'x@2.0.0', added: 'x@1.0.0' }, packages);
  for (const options of [{ surface: 'all' }, { includeTransitive: (name) => name === 'x' }]) {
    assert.deepEqual(affectedDependencies(base, head, options).sort(), ['added', 'alias', 'removed']);
  }
});

test('cycles are handled without infinite loops', () => {
  const base = graph(
    { a: 'a@1.0.0' },
    {
      'a@1.0.0': { name: 'a', version: '1.0.0', deps: { b: 'b@1.0.0' } },
      'b@1.0.0': { name: 'b', version: '1.0.0', deps: { a: 'a@1.0.0', c: 'c@1.0.0' } },
      'c@1.0.0': { name: 'c', version: '1.0.0' },
    },
  );
  const head = graph(
    { a: 'a@1.0.0' },
    {
      'a@1.0.0': { name: 'a', version: '1.0.0', deps: { b: 'b@1.0.0' } },
      'b@1.0.0': { name: 'b', version: '1.0.0', deps: { a: 'a@1.0.0', c: 'c@2.0.0' } },
      'c@2.0.0': { name: 'c', version: '2.0.0' },
    },
  );
  assert.deepEqual(affectedDependencies(base, head), ['a']);
});
