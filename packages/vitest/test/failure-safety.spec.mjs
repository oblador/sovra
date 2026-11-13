import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../dist/cli.js');

function fixture(t, source = '') {
  // Keep each fixture isolated, but under the package so it uses the real local
  // Vitest install. No mocked analyzer, runner, Git commands, or exit status.
  const root = mkdtempSync(path.resolve(here, '../__fixtures__/failure-safety-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, contents) => writeFileSync(path.join(root, file), contents);
  write('package.json', '{"type":"module"}');
  write('vitest.config.mjs', "export default { test: { include: ['*.test.mjs'] } };");
  write('pass.test.mjs', `import { test, expect } from 'vitest';
${source}
test('unaffected passing test', () => expect(true).toBe(true));`);
  write('fail.test.mjs', `import { test, expect } from 'vitest';
test('intentional full-suite failure', () => expect(true).toBe(false));`);
  const run = (args) => exec(process.execPath, [cli, ...args], { cwd: root });
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  return { root, write, run, git };
}

async function expectFallback(run, args, reason) {
  for (const mode of ['--list', '--dry-run']) {
    await assert.rejects(run([mode, ...args]), (error) => {
      assert.equal(error.code, 254);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, reason);
      assert.doesNotMatch(error.stderr, /No affected tests/);
      return true;
    });
  }
  await assert.rejects(run([...args, '--', '--reporter=dot', '--no-color']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, reason);
    assert.match(error.stdout + error.stderr, /intentional full-suite failure/);
    return true;
  });
}

for (const [name, source] of [
  ['resolver failure', "if (false) require('./missing.mjs');"],
  ['unresolved bare import', "if (false) require('#internal/missing');"],
  ['dynamic require', "const target = './missing.mjs'; if (false) require(target);"],
]) {
  test(`CLI ${name} runs the full suite and preserves its failure`, async (t) => {
    const { run } = fixture(t, source);
    await expectFallback(run, ['README.md'], /Source dependency analysis was incomplete/);
  });
}

for (const failure of ['malformed lockfile', 'unreadable lockfile', 'invalid baseline']) {
  test(`CLI ${failure} cannot report a false green`, async (t) => {
    const { root, write, run, git } = fixture(t);
    const lockfile = 'package-lock.json';
    write(lockfile, JSON.stringify({ lockfileVersion: 3, packages: {} }));
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    if (failure === 'malformed lockfile') write(lockfile, '{');
    // An existing non-file must not be confused with an absent/deleted lockfile.
    // This is deterministic even on Windows or when tests run as root.
    if (failure === 'unreadable lockfile') {
      rmSync(path.join(root, lockfile));
      mkdirSync(path.join(root, lockfile));
    }
    const base = failure === 'invalid baseline' ? 'does-not-exist' : 'HEAD';
    await expectFallback(run, ['--base', base, lockfile], /Dependency analysis failed/);
  });
}

test('CLI configuration-loading failures exit unsuccessfully', async (t) => {
  const { write, run } = fixture(t);
  write('vitest.config.mjs', "throw new Error('broken config');");
  await assert.rejects(run(['README.md']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /broken config/);
    return true;
  });
});

test('CLI Git-loading failures exit unsuccessfully', async (t) => {
  const { run } = fixture(t);
  await assert.rejects(run(['--base', 'does-not-exist']), (error) => {
    assert.equal(error.code, 1);
    assert.doesNotMatch(error.stderr, /No (affected tests|changes detected)/);
    return true;
  });
});

test('CLI --list also signals a full-suite requirement for a changed sentinel', async (t) => {
  const { run } = fixture(t);
  await expectFallback(run, ['--no-analyze-lockfile', 'vitest.config.mjs'], /vitest\.config\.mjs changed/);
});

test('a genuinely empty selection still succeeds without running unrelated failing tests', async (t) => {
  const { run } = fixture(t);
  for (const args of [['--list', 'README.md'], ['README.md']]) {
    const { stdout, stderr } = await run(args);
    assert.equal(stdout, '');
    assert.match(stderr, /No affected tests/);
  }
});
