import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { JestRunner } from '../dist/index.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

function fixture(t, prefix, files = {}) {
  const rootDir = mkdtempSync(prefix);
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(rootDir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return rootDir;
}

for (const method of ['run', 'runAll']) {
  const invoke = (runner, rootDir, args) => method === 'run'
    ? runner.run([path.join(rootDir, 'selection.test.js')], args)
    : runner.runAll(args);

  for (const missing of ['yargs-parser', 'jest-cli']) {
    test(`${method} rejects when ${missing} is unavailable instead of falling back`, async (t) => {
      // Outside the repository so its dependencies cannot satisfy missing modules.
      // The second case supplies the real parser but no Jest option definitions.
      const rootDir = fixture(t, path.join(tmpdir(), 'sovra-jest-missing-'), missing === 'jest-cli' ? {
        'node_modules/yargs-parser/index.js': `module.exports = require(${JSON.stringify(require.resolve('yargs-parser'))});`,
      } : {});
      const runner = new JestRunner({ rootDir });
      await assert.rejects(invoke(runner, rootDir, ['--runInBand']), (error) => {
        assert.equal(error.code, 'MODULE_NOT_FOUND');
        assert.ok(error.message.includes(`Cannot find module '${missing}'`));
        return true;
      });
    });
  }

  test(`${method} honors Jest argument aliases and boolean flags with the real parser`, async (t) => {
    const rootDir = fixture(t, path.resolve(here, '../__fixtures__/passthrough-'), {
      'package.json': '{"type":"commonjs"}',
      'jest.config.cjs': "module.exports = { testMatch: ['<rootDir>/*.test.js'] };",
      'selection.test.js': `
        test('selected case', () => expect(1).toBe(1));
        test('excluded case', () => { throw new Error('name filter was ignored'); });
      `,
    });
    const reportPath = path.join(rootDir, 'results.json');
    const result = await invoke(new JestRunner({ rootDir }), rootDir, [
      '--runInBand', '--no-cache', '--silent', '-t', '^selected case$',
      '--json', '--outputFile', reportPath,
    ]);
    assert.deepEqual(result, { success: true });
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.numPassedTests, 1);
    assert.equal(report.numPendingTests, 1);
  });
}
