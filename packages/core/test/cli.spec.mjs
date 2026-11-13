import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { cli } from '../dist/index.js';

for (const change of ['source.js', 'setup.js']) {
  test(`CLI preserves every passthrough token when ${change} changes`, async (t) => {
    const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sovra-cli-')));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    for (const [file, content] of Object.entries({
      'source.js': 'export const value = 1;',
      'source.test.js': "import { value } from './source.js';",
      'setup.js': '',
    })) writeFileSync(path.join(rootDir, file), content);
    const testFiles = [path.join(rootDir, 'source.test.js')];
    const runs = [];
    const passthrough = ['--unknown=value', '-t', 'a b=c', '', '--no-analyze-lockfile', '--', '--list'];
    const code = await cli(['--root', rootDir, change, '--', ...passthrough], {
      name: 'sovra-test',
      createRunner: () => ({
        async loadConfig() {
          return {
            rootDir,
            projects: [{
              rootDir, testFiles, sentinelFiles: [path.join(rootDir, 'setup.js')],
              resolveOptions: { roots: [rootDir], extensions: ['.js'] },
            }],
          };
        },
        async run(files, args) { runs.push({ files, args }); return { success: true }; },
        async runAll(args) { runs.push({ all: true, args }); return { success: true }; },
      }),
    });
    assert.equal(code, 0);
    assert.deepEqual(runs, [change === 'setup.js'
      ? { all: true, args: passthrough }
      : { files: testFiles, args: passthrough }]);
  });
}
