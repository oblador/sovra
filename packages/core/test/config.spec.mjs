import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadSovraConfig } from '../dist/index.js';

function fixture(t, files = {}) {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sovra-config-')));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(rootDir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return rootDir;
}

test('missing config gives empty defaults without looking in ancestors', async (t) => {
  const rootDir = fixture(t, { 'sovra.config.cjs': "module.exports = { defaultBranch: 'parent' };", 'child/.keep': '' });
  assert.deepEqual(await loadSovraConfig({ rootDir: path.join(rootDir, 'child') }), { config: {} });
});

for (const [name, source, packageType] of [
  ['sovra.config.cjs', 'module.exports =', 'module'],
  ['sovra.config.js', 'module.exports =', 'commonjs'],
  ['sovra.config.js', 'export default', 'module'],
  ['sovra.config.mjs', 'export default', 'commonjs'],
  ['sovra.config.ts', 'module.exports =', 'commonjs'],
  ['sovra.config.ts', 'export default', 'module'],
  ['sovra.config.mts', 'export default', 'commonjs'],
  ['sovra.config.cts', 'module.exports =', 'module'],
]) {
  test(`loads ${name} in a ${packageType} project`, async (t) => {
    const config = { defaultBranch: 'master', base: 'HEAD~1', analyzeLockfile: false, runAllOn: ['tsconfig*.json', 'npm:@scope/tool'] };
    const rootDir = fixture(t, {
      'package.json': JSON.stringify({ type: packageType }),
      [name]: `${source} ${JSON.stringify(config)}${name.endsWith('ts') ? ' satisfies { defaultBranch: string; base: string; analyzeLockfile: boolean; runAllOn: string[] }' : ''};`,
    });
    assert.deepEqual(await loadSovraConfig({ rootDir }), { config, configPath: path.join(rootDir, name) });
  });
}

test('TypeScript configs use native imports, type stripping and top-level await', async (t) => {
  const rootDir = fixture(t, {
    'package.json': '{"type":"module"}',
    'defaults.ts': "export const defaults: { defaultBranch: string } = { defaultBranch: 'master' };",
    'sovra.config.ts': "import type { MissingType } from './types-only.ts'; import { defaults } from './defaults.ts'; export default await Promise.resolve({ ...defaults, runAllOn: ['npm:jest'] });",
  });
  assert.deepEqual((await loadSovraConfig({ rootDir })).config, { defaultBranch: 'master', runAllOn: ['npm:jest'] });
});

test('config loads source-analysis overrides without supplying runner-specific defaults', async (t) => {
  const config = {
    ignoreTypeImports: false,
    requireAliases: ['loadModule', 'loader.require'],
    resolveOptions: { conditionNames: ['browser'], alias: { virtual: ['/app/src'] } },
  };
  const rootDir = fixture(t, { 'sovra.config.mts': `export default ${JSON.stringify(config)};` });
  assert.deepEqual((await loadSovraConfig({ rootDir })).config, config);
});

test('different projects load their own shared defaults', async (t) => {
  const files = (branch) => ({
    'defaults.ts': `export const defaults = { defaultBranch: '${branch}' };`,
    'sovra.config.ts': "import { defaults } from './defaults.ts'; export default defaults;",
  });
  const rootDir = fixture(t, files('master'));
  const otherRoot = fixture(t, files('trunk'));
  assert.equal((await loadSovraConfig({ rootDir })).config.defaultBranch, 'master');
  assert.equal((await loadSovraConfig({ rootDir: otherRoot })).config.defaultBranch, 'trunk');
});

test('explicit config paths preserve URL-special characters', async (t) => {
  const rootDir = fixture(t, { 'config/policy #1%.mts': "export default { defaultBranch: 'trunk' };" });
  assert.equal((await loadSovraConfig({ rootDir, configPath: 'config/policy #1%.mts' })).config.defaultBranch, 'trunk');
});

test('unsupported TypeScript transformations fail explicitly', async (t) => {
  const rootDir = fixture(t, { 'sovra.config.mts': "enum Branch { Main = 'main' }; export default { defaultBranch: Branch.Main };" });
  await assert.rejects(loadSovraConfig({ rootDir }), (error) => {
    assert.match(error.message, /Cannot load Sovra config/);
    assert.equal(error.cause.code, 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
    return true;
  });
});

test('TypeScript configs follow the project module format instead of transpiling ESM to CommonJS', async (t) => {
  const rootDir = fixture(t, {
    'package.json': '{"type":"commonjs"}',
    'sovra.config.ts': 'export default {};',
  });
  await assert.rejects(loadSovraConfig({ rootDir }), /Cannot load Sovra config/);
});

test('ESM config must have a default export', async (t) => {
  const rootDir = fixture(t, { 'sovra.config.mts': "export const defaultBranch = 'master';" });
  await assert.rejects(loadSovraConfig({ rootDir }), /must export an object/);
});

test('explicit config wins over discovery and resolves relative to the selected root', async (t) => {
  const rootDir = fixture(t, {
    'sovra.config.js': 'module.exports = {};',
    'sovra.config.ts': 'export default {};',
    'config/selection.ts': "export default { defaultBranch: 'trunk' };",
  });
  await assert.rejects(loadSovraConfig({ rootDir }), /Multiple Sovra configs.*--sovra-config/);
  const loaded = await loadSovraConfig({ rootDir, configPath: 'config/selection.ts' });
  assert.equal(loaded.config.defaultBranch, 'trunk');
  assert.equal(loaded.configPath, path.join(rootDir, 'config/selection.ts'));
});

test('missing and non-file explicit configs fail instead of reverting to defaults', async (t) => {
  const rootDir = fixture(t);
  await assert.rejects(loadSovraConfig({ rootDir, configPath: 'missing.ts' }), /Sovra config not found/);
  await assert.rejects(loadSovraConfig({ rootDir, configPath: '.' }), /Expected a Sovra config file/);
});

for (const [source, message] of [
  ['null', /must export an object/],
  ['undefined', /must export an object/],
  ['[]', /must export an object/],
  ['() => ({})', /must export an object/],
  ['{ defaultBrnach: "master" }', /Unknown Sovra config option: defaultBrnach/],
  ['{ defaultBranch: "" }', /defaultBranch must be a non-empty string/],
  ['{ base: 123 }', /base must be a non-empty string/],
  ['{ analyzeLockfile: "false" }', /analyzeLockfile must be a boolean/],
  ['{ ignoreTypeImports: "false" }', /ignoreTypeImports must be a boolean/],
  ['{ requireAliases: "loadModule" }', /requireAliases must be an array of function names/],
  ['{ requireAliases: [null] }', /requireAliases must be an array of function names/],
  ['{ requireAliases: [""] }', /requireAliases must be an array of function names/],
  ['{ requireAliases: ["loader."] }', /requireAliases must be an array of function names/],
  ['{ requireAliases: ["nested.loader.require"] }', /requireAliases must be an array of function names/],
  ['{ resolveOptions: null }', /resolveOptions must be an object/],
  ['{ resolveOptions: [] }', /resolveOptions must be an object/],
  ['{ runAllOn: { files: [] } }', /runAllOn must be an array/],
  ['{ runAllOn: ["npm:"] }', /Invalid runAllOn entry/],
  ['{ runAllOn: ["file:"] }', /Invalid runAllOn entry/],
  ['{ runAllOn: ["!src/**"] }', /does not support negated patterns/],
  ['{ runAllOn: ["npm:@scope/*"] }', /package\/scope prefixes, not globs/],
]) {
  test(`rejects invalid config ${source}`, async (t) => {
    const rootDir = fixture(t, { 'sovra.config.cjs': `module.exports = ${source};` });
    await assert.rejects(loadSovraConfig({ rootDir }), (error) => {
      assert.match(error.message, /sovra\.config\.cjs/);
      assert.match(error.message, message);
      return true;
    });
  });
}

for (const [source, message] of [
  ["throw new Error('broken policy');", /broken policy/],
  ['export default {', /Cannot load Sovra config/],
  ["import './missing.mts'; export default {};", /Cannot find module/],
]) {
  test(`config load errors propagate: ${source}`, async (t) => {
    const rootDir = fixture(t, { 'sovra.config.mts': source });
    await assert.rejects(loadSovraConfig({ rootDir }), message);
  });
}
