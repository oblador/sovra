import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertAnalysisOptions } from '../../../test/helpers/analysis-options.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

for (const nodeEnv of [undefined, 'development']) {
  test(`Jest CLI uses NODE_ENV=${nodeEnv ?? 'test'} for config and execution`, async (t) => {
    const root = mkdtempSync(path.resolve(here, '../__fixtures__/environment-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const expected = nodeEnv ?? 'test';
    writeFileSync(path.join(root, 'jest.config.cjs'), `
      if (process.env.NODE_ENV !== ${JSON.stringify(expected)}) throw new Error('wrong NODE_ENV during config loading');
      module.exports = { testMatch: ['<rootDir>/*.test.js'], watchman: false };
    `);
    writeFileSync(path.join(root, 'environment.test.js'), `
      test('runtime environment', () => expect(process.env.NODE_ENV).toBe(${JSON.stringify(expected)}));
    `);
    const env = { ...process.env };
    if (nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = nodeEnv;
    const result = await exec(process.execPath, [
      path.resolve(here, '../dist/cli.js'), 'environment.test.js', '--', '--runInBand',
    ], { cwd: root, env });
    assert.match(result.stderr, /1 passed, 1 total/);
  });
}

test('Jest CLI applies source-analysis options from Sovra config', async (t) => {
  await assertAnalysisOptions(t, 'jest', new URL('../dist/cli.js', import.meta.url));
});

test('Jest CLI loads native TypeScript config in a CommonJS project and matches runAllOn rules', async (t) => {
  const root = mkdtempSync(path.resolve(here, '../__fixtures__/config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries({
    'package.json': '{"type":"commonjs"}',
    'jest.config.cjs': "module.exports = { testMatch: ['<rootDir>/*.test.js'] };",
    'sovra.config.mts': "import type { SovraConfig } from '@sovra/core'; import defaults from './defaults.mts'; export default { ...defaults, runAllOn: ['tool.cjs', 'npm:jest'] } satisfies SovraConfig;",
    'defaults.mts': "export default { defaultBranch: 'master' };",
    'tool.cjs': "require('./helper.js');",
    'helper.js': 'module.exports = true;',
    'math.js': 'module.exports = 1;',
    'math.test.js': "const value = require('./math.js'); test('math', () => expect(value).toBe(1));",
  })) writeFileSync(path.join(root, file), contents);
  const run = (args) => exec(process.execPath, [path.resolve(here, '../dist/cli.js'), '--list', ...args], { cwd: root });
  assert.equal((await run(['math.js'])).stdout.trim(), path.join(root, 'math.test.js'));
  assert.equal((await run(['helper.js'])).stdout, '');
  for (const change of ['sovra.config.mts', 'defaults.mts']) {
    assert.equal((await run([change])).stdout, '');
    assert.equal((await run([change, 'math.js'])).stdout.trim(), path.join(root, 'math.test.js'));
  }
  for (const change of ['tool.cjs', 'npm:jest']) {
    await assert.rejects(run([change]), (error) => {
      assert.equal(error.code, 254);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /runAllOn/);
      return true;
    });
  }
  rmSync(path.join(root, 'sovra.config.mts'));
  assert.equal((await run(['sovra.config.mts'])).stdout, '');
  assert.equal((await run(['sovra.config.mts', 'math.js'])).stdout.trim(), path.join(root, 'math.test.js'));
});
