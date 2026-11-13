import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function assertAnalysisOptions(t, runner, entryUrl) {
  // Inside the runner package so discovery uses its real installed dependencies.
  const root = mkdtempSync(fileURLToPath(new URL('../__fixtures__/analysis-', entryUrl)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, contents) => writeFileSync(path.join(root, file), contents);
  write('package.json', '{"type":"module"}');
  if (runner === 'jest') {
    write('jest.config.cjs', "module.exports = { testMatch: ['<rootDir>/*.test.ts'] };");
  } else {
    write('vitest.config.mjs', "export default { test: { include: ['*.test.ts'] } };");
  }
  write('types.ts', 'export interface Value { value: number }');
  write('types.test.ts', "import type { Value } from './types'; export const value: Value = { value: 1 };");
  write('value.ts', 'export const value = 1;');
  write('alias.test.ts', "const load = { module: (id: string) => id }; export const value = load.module('virtual/value');");
  const configure = (config) => write('sovra.config.mts', `export default ${JSON.stringify(config)};`);
  const list = async (file) => (await exec(process.execPath, [fileURLToPath(entryUrl), '--list', file], { cwd: root })).stdout.trim();

  assert.equal(await list('types.ts'), '');
  configure({ ignoreTypeImports: false });
  assert.equal(await list('types.ts'), path.join(root, 'types.test.ts'));
  configure({ ignoreTypeImports: true });
  assert.equal(await list('types.ts'), '');

  const resolveOptions = { alias: { virtual: [root] } };
  configure({ requireAliases: ['load.module'], resolveOptions });
  assert.equal(await list('value.ts'), path.join(root, 'alias.test.ts'));
  configure({ requireAliases: [], resolveOptions });
  assert.equal(await list('value.ts'), '');
}
