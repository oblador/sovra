import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function assertNoInstall(t, runner, entryUrl) {
  const entry = fileURLToPath(entryUrl);
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), `sovra-${runner}-no-install-`)));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, 'package.json'), '{}');
  writeFileSync(path.join(rootDir, 'changes.txt'), '');
  const require = createRequire(path.join(rootDir, 'package.json'));
  assert.equal(existsSync(path.join(rootDir, 'node_modules')), false);
  assert.throws(() => require.resolve(`${runner}/package.json`), { code: 'MODULE_NOT_FOUND' });
  const git = (args) => execFileSync('git', args, { cwd: rootDir, stdio: 'pipe' });
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
  const run = (args) => exec(process.execPath, [entry, ...args], { cwd: rootDir });
  for (const changes of [['--changeset', 'changes.txt'], ['--base', 'HEAD']]) {
    for (const mode of [[], ['--list'], ['--dry-run']]) {
      const { stdout, stderr } = await run([...mode, ...changes]);
      assert.equal(stdout, '');
      assert.match(stderr, /No affected tests/);
    }
  }
  // Missing discovery dependencies must not become a successful empty selection.
  await assert.rejects(run(['--list', 'README.md']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Cannot find module/);
    return true;
  });
}
