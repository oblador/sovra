import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertAnalysisOptions } from '../../../test/helpers/analysis-options.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../dist/cli.js');

test('Vitest CLI applies source-analysis options from Sovra config', async (t) => {
  await assertAnalysisOptions(t, 'vitest', new URL('../dist/cli.js', import.meta.url));
});

function fixture(t, config = '{}') {
  const root = mkdtempSync(path.resolve(here, '../__fixtures__/config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, contents) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  };
  write('package.json', '{"type":"module"}');
  write('vitest.config.mjs', "export default { test: { include: ['*.test.mjs'] } };");
  write('sovra.config.ts', `import type { SovraConfig } from '@sovra/core'; export default ${config} satisfies SovraConfig;`);
  for (const name of ['a', 'b']) {
    write(`${name}.mjs`, 'export const value = 1;');
    write(`${name}.test.mjs`, `import { test, expect } from 'vitest'; import { value } from './${name}.mjs'; test('${name}', () => expect(value).toBe(1));`);
  }
  const run = (args, cwd = root) => exec(process.execPath, [cli, ...args], { cwd });
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = () => {
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    return git(['rev-parse', 'HEAD']);
  };
  return { root, write, run, git, commit };
}

async function expectAll(promise, reason) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 254);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, reason);
    return true;
  });
}

test('CLI loads defaultBranch from config and lets a flag override it', async (t) => {
  const { root, write, run, git, commit } = fixture(t, "{ defaultBranch: 'master' }");
  git(['init', '-q']);
  const baseline = commit();
  git(['update-ref', 'refs/remotes/origin/master', baseline]);
  write('a.mjs', 'export const value = 2;');
  const next = commit();
  git(['update-ref', 'refs/remotes/origin/trunk', next]);
  assert.equal((await run(['--list'])).stdout.trim(), path.join(root, 'a.test.mjs'));
  const overridden = await run(['--list', '--default-branch=trunk']);
  assert.equal(overridden.stdout, '');
  assert.match(overridden.stderr, /No affected tests/);
});

test('CLI base defaults and explicit base/change lists preserve their priority', async (t) => {
  const { root, write, run, git, commit } = fixture(t, "{ base: 'HEAD~1', defaultBranch: 'does-not-exist' }");
  git(['init', '-q']);
  commit();
  write('a.mjs', 'export const value = 2;');
  commit();
  assert.equal((await run(['--list'])).stdout.trim(), path.join(root, 'a.test.mjs'));
  assert.equal((await run(['--list', '--base=HEAD'])).stdout, '');
  assert.equal((await run(['--list', '--base', 'does-not-exist', 'b.mjs'])).stdout.trim(), path.join(root, 'b.test.mjs'));
});

test('CLI lockfile analysis defaults can be overridden in either direction', async (t) => {
  const { write, run, git, commit } = fixture(t, "{ analyzeLockfile: false, base: 'HEAD' }");
  write('package-lock.json', '{"lockfileVersion":3,"packages":{}}');
  git(['init', '-q']);
  commit();
  write('package-lock.json', '{');
  assert.equal((await run(['--list', 'package-lock.json'])).stdout, '');
  await expectAll(run(['--list', '--analyze-lockfile', 'package-lock.json']), /Dependency analysis failed/);
  write('sovra.config.ts', "export default { analyzeLockfile: true, base: 'HEAD' };");
  assert.equal((await run(['--list', '--no-analyze-lockfile', 'package-lock.json'])).stdout, '');
});

test('CLI uses the last repeated lockfile analysis flag', async (t) => {
  const { write, run, git, commit } = fixture(t, "{ base: 'HEAD' }");
  write('package-lock.json', '{"lockfileVersion":3,"packages":{}}');
  git(['init', '-q']);
  commit();
  write('package-lock.json', '{');
  assert.equal((await run(['--list', '--analyze-lockfile', '--no-analyze-lockfile', 'package-lock.json'])).stdout, '');
  await expectAll(run(['--list', '--no-analyze-lockfile', '--analyze-lockfile', 'package-lock.json']), /Dependency analysis failed/);
});

test('explicit dependency entries replace lockfile analysis for arguments, files and stdin', async (t) => {
  const { root, write, run, git, commit } = fixture(t, '{ analyzeLockfile: true }');
  for (const [testName, dependency] of [['a', 'provided'], ['b', 'automatic']]) {
    write(`node_modules/${dependency}/package.json`, JSON.stringify({ name: dependency, main: 'index.js' }));
    write(`node_modules/${dependency}/index.js`, 'exports.value = 1;');
    write(`${testName}.mjs`, `import { value as dependencyValue } from '${dependency}'; export const value = dependencyValue;`);
  }
  write('package.json', '{"type":"module","dependencies":{"automatic":"*"}}');
  write('.gitignore', 'node_modules/');
  const lock = (version) => JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies: { automatic: version } }, 'node_modules/automatic': { version },
  } });
  write('package-lock.json', lock('1.0.0'));
  git(['init', '-q']);
  const base = commit();
  write('package-lock.json', lock('1.0.1'));
  const args = ['--list', '--base', base, 'package-lock.json'];
  assert.equal((await run(args)).stdout.trim(), path.join(root, 'b.test.mjs'));
  for (const flag of ['--analyze-lockfile', '--no-analyze-lockfile']) {
    assert.equal((await run([...args, flag, 'npm:provided'])).stdout.trim(), path.join(root, 'a.test.mjs'));
  }

  write('package-lock.json', '{');
  const changes = ['package-lock.json', 'b.mjs', 'npm:provided'];
  const expected = ['a.test.mjs', 'b.test.mjs'].map((file) => path.join(root, file));
  const listing = (stdout) => stdout.trim().split('\n').sort();
  assert.deepEqual(listing((await run(['--list', '--base=missing', ...changes])).stdout), expected);
  write('changes.txt', changes.join('\n'));
  assert.deepEqual(listing((await run(['--list', '--base=missing', '--changeset=changes.txt'])).stdout), expected);
  const stdout = execFileSync(process.execPath, [cli, '--list', '--base=missing', '--changeset=-'], {
    cwd: root, input: changes.join('\n'), encoding: 'utf8',
  });
  assert.deepEqual(listing(stdout), expected);

  write('sovra.config.ts', "export default { runAllOn: ['npm:provided'] };");
  await expectAll(run(['--list', ...changes]), /runAllOn/);
});

test('CLI supports equals-form options interleaved with changed paths and the dry-run alias', async (t) => {
  const { root, run } = fixture(t);
  const { stdout } = await run([
    'a.mjs', `--root=${root}`, '--config=vitest.config.mjs', '--dry-run',
    '--sovra-config=sovra.config.ts', 'b.mjs',
  ], here);
  assert.deepEqual(stdout.trim().split('\n').sort(), ['a.test.mjs', 'b.test.mjs'].map((file) => path.join(root, file)));
});

test('CLI reads file and stdin changesets while positional paths take priority', async (t) => {
  const { root, write, run } = fixture(t);
  write('changed files.txt', 'a.mjs\n');
  assert.equal((await run(['--list', '--changeset=changed files.txt'])).stdout.trim(), path.join(root, 'a.test.mjs'));
  assert.equal((await run(['--list', '--changeset=missing.txt', 'b.mjs'])).stdout.trim(), path.join(root, 'b.test.mjs'));
  const stdout = execFileSync(process.execPath, [cli, '--list', '--changeset', '-'], {
    cwd: root, input: 'b.mjs\n', encoding: 'utf8',
  });
  assert.equal(stdout.trim(), path.join(root, 'b.test.mjs'));
});

test('CLI discovers config at --root and matches changed paths and npm: entries directly', async (t) => {
  const { root, write, run } = fixture(t, "{ runAllOn: ['config/tool.{js,ts}', 'npm:typescript'] }");
  write('config/tool.js', "import '../helper.mjs';");
  write('helper.mjs', 'export const helper = true;');
  for (const change of ['config/tool.ts', 'npm:typescript']) {
    await expectAll(run(['--root', root, '--list', change], here), /runAllOn/);
  }
  assert.equal((await run(['--list', 'helper.mjs'])).stdout, '');
  assert.equal((await run(['--list', 'a.mjs'])).stdout.trim(), path.join(root, 'a.test.mjs'));
});

test('CLI stays selective when its config or imported helpers change, including config deletion', async (t) => {
  const { root, write, run } = fixture(t);
  const config = 'sovra.config.ts';
  const helper = 'defaults.ts';
  write(helper, "export const defaultBranch = 'master';");
  write(config, `import { defaultBranch } from './${helper}'; export default { defaultBranch };`);
  for (const change of [helper, config]) {
    assert.equal((await run(['--list', change])).stdout, '');
    assert.equal((await run(['--list', change, 'a.mjs'])).stdout.trim(), path.join(root, 'a.test.mjs'));
  }
  rmSync(path.join(root, config));
  assert.equal((await run(['--list', config])).stdout, '');
  assert.equal((await run(['--list', config, 'b.mjs'])).stdout.trim(), path.join(root, 'b.test.mjs'));
});

test('runAllOn can explicitly require the full suite for Sovra config or helper changes', async (t) => {
  const { write, run } = fixture(t, "{ runAllOn: ['sovra.config.ts', 'defaults.mts'] }");
  write('defaults.mts', 'export default {};');
  for (const change of ['sovra.config.ts', 'defaults.mts']) {
    await expectAll(run(['--list', change]), /runAllOn/);
  }
});

test('CLI keeps --sovra-config separate from the runner --config option', async (t) => {
  const { root, write, run } = fixture(t);
  write('config/policy.ts', "export default { runAllOn: ['a.mjs'] };");
  write('other.vitest.mjs', "export default { test: { include: ['b.test.mjs'] } };");
  const args = ['--list', '--sovra-config', 'config/policy.ts', '--config', 'other.vitest.mjs'];
  assert.equal((await run([...args, 'config/policy.ts'])).stdout, '');
  assert.equal((await run([...args, 'config/policy.ts', 'b.mjs'])).stdout.trim(), path.join(root, 'b.test.mjs'));
  assert.equal((await run([...args, 'b.mjs'])).stdout.trim(), path.join(root, 'b.test.mjs'));
  await expectAll(run([...args, 'a.mjs']), /runAllOn/);
  // Explicit config paths do not change the root for runAllOn patterns.
  assert.equal((await run([...args, 'config/a.mjs'])).stdout, '');
});

test('CLI rejects invalid Sovra config and missing option values before selection', async (t) => {
  const { write, run } = fixture(t);
  write('sovra.config.ts', 'export default { runAllOn: { files: [] } };');
  await assert.rejects(run(['--list', 'a.mjs']), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /runAllOn must be an array/);
    return true;
  });
  for (const args of [
    ...['--changeset', '--base', '--default-branch', '--config', '--sovra-config', '--root'].map((flag) => [flag]),
    ['--default-branch', '--list'], ['--base', '--', '--runner-flag'], ['--list=false'],
  ]) {
    await assert.rejects(run(args), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /ERR_PARSE_ARGS_INVALID_OPTION_VALUE/);
      return true;
    });
  }
  assert.match((await run(['--help'])).stdout, /--sovra-config/);
  assert.match((await run(['-h'])).stdout, /--sovra-config/);
});

test('manifest and lockfile updates select consumers instead of making package.json a blanket sentinel', async (t) => {
  const { root, write, run, git, commit } = fixture(t);
  write('package.json', '{"type":"module","dependencies":{"shared":"1.0.0"}}');
  write('node_modules/shared/package.json', '{"name":"shared","version":"1.0.1","main":"index.js"}');
  write('node_modules/shared/index.js', 'exports.value = 1;');
  write('a.mjs', "export { value } from 'shared';");
  write('.gitignore', 'node_modules/');
  const lock = (version) => JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies: { shared: version } }, 'node_modules/shared': { version },
  } });
  write('package-lock.json', lock('1.0.0'));
  git(['init', '-q']);
  const base = commit();
  write('package.json', '{"type":"module","dependencies":{"shared":"1.0.1"},"version":"2.0.0"}');
  assert.equal((await run(['--list', '--base', base])).stdout, '');
  write('package-lock.json', lock('1.0.1'));
  assert.equal((await run(['--list', '--base', base])).stdout.trim(), path.join(root, 'a.test.mjs'));
});

test('package-manager config changes stay selective unless explicitly covered by runAllOn', async (t) => {
  const { root, write, run, git, commit } = fixture(t);
  write('package.json', '{"type":"module","packageManager":"pnpm@10.1.0"}');
  write('pnpm-workspace.yaml', 'nodeLinker: isolated');
  git(['init', '-q']);
  const base = commit();
  write('package.json', '{"type":"module","packageManager":"pnpm@10.1.0","version":"2.0.0","scripts":{"test":"vitest"}}');
  const metadata = await run(['--list', '--base', base]);
  assert.equal(metadata.stdout, '');
  assert.match(metadata.stderr, /No affected tests/);
  write('package.json', '{"type":"module","packageManager":"pnpm@10.2.0"}');
  write('pnpm-workspace.yaml', 'nodeLinker: hoisted');
  assert.equal((await run(['--list', '--base', base])).stdout, '');
  write('a.mjs', 'export const value = 2;');
  assert.equal((await run(['--list', '--base', base])).stdout.trim(), path.join(root, 'a.test.mjs'));
  write('sovra.config.ts', "export default { runAllOn: ['pnpm-workspace.yaml'] };");
  await expectAll(run(['--list', '--base', base]), /runAllOn/);
});

test('a manifest imported by executable runner config remains a configuration dependency', async (t) => {
  const { write, run, git, commit } = fixture(t);
  write('vitest.config.mjs', "import manifest from './package.json' with { type: 'json' }; export default { test: { name: manifest.name, include: ['*.test.mjs'] } };");
  write('package.json', '{"type":"module","name":"fixture","description":"before"}');
  git(['init', '-q']);
  const base = commit();
  write('package.json', '{"type":"module","name":"fixture","description":"after"}');
  await expectAll(run(['--list', '--base', base]), /is affected|changed/);
});
