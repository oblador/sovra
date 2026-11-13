# @sovra/core

Select affected tests in custom tools and integrations. Supply your test files,
resolver settings, changed paths, and changed dependency names; Sovra returns
whether to run selected tests, all tests, or nothing.

For an existing Jest or Vitest project, start with
[@sovra/jest](https://github.com/oblador/sovra/tree/main/packages/jest) or
[@sovra/vitest](https://github.com/oblador/sovra/tree/main/packages/vitest).
Those packages discover tests and handle execution for you.

## Install

Requires **Node.js 24 or newer**.

```sh
pnpm add -D @sovra/core
```

## Select tests

This example assumes a TypeScript project with `tsconfig.json` and tests under
`src/`. Replace the discovery pattern and changed files with your own inputs.

```ts
import { globSync } from 'node:fs';
import path from 'node:path';
import { decideAffected, type ResolvedTestConfig } from '@sovra/core';

const rootDir = process.cwd();
const config: ResolvedTestConfig = {
  rootDir,
  projects: [{
    rootDir,
    testFiles: Array.from(
      globSync('src/**/*.test.{js,ts,tsx}', { cwd: rootDir }),
      (file) => path.resolve(rootDir, file),
    ),
    sentinelFiles: [],
    ignoreTypeImports: true,
    resolveOptions: {
      roots: [rootDir],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.node'],
      tsconfig: { configFile: path.join(rootDir, 'tsconfig.json') },
      builtinModules: true,
    },
  }],
};

const decision = decideAffected({
  config,
  changedFiles: ['src/math.ts'],
  changedDependencies: [],
  onError: (error) => console.error(error),
});
console.log(decision);
```

| Decision | Meaning |
| --- | --- |
| `{ kind: 'none' }` | No tests are affected |
| `{ kind: 'run-selected', testFiles }` | Run the nonempty list of test files |
| `{ kind: 'run-all', reason }` | Run the full suite, not an empty selection |

Changed paths are relative to `config.rootDir`, or to an explicit `cwd` option.
Absolute paths also work. `changedDependencies` contains bare names such as
`lodash`, **without** the `npm:` prefix used by the CLI.

Each project has its own resolver settings. Test and sentinel paths must be
absolute. Add configuration/setup files to `sentinelFiles` when a change to them
or their dependencies should require all tests. `runAllOn` accepts additional
changed-path globs and `npm:` dependency triggers.

Selection reads source files but does not load runner configuration, read Git,
or infer dependency changes from lockfiles. Unresolved imports, dynamic
import/require arguments, unreadable files, and parse errors return `run-all`,
even without an `onError` reporter. Exceptions that stop analysis propagate.

## Dependency changes

Use `diffDependencies` to compare before/after lockfile snapshots. For example,
given saved baseline files in `baseline/` and current files in the project root:

```ts
import { readFileSync } from 'node:fs';
import { diffDependencies } from '@sovra/core';

const changedDependencies = diffDependencies({
  before: {
    filename: 'pnpm-lock.yaml',
    contents: readFileSync('baseline/pnpm-lock.yaml', 'utf8'),
    manifest: readFileSync('baseline/package.json', 'utf8'),
  },
  after: {
    filename: 'pnpm-lock.yaml',
    contents: readFileSync('pnpm-lock.yaml', 'utf8'),
    manifest: readFileSync('package.json', 'utf8'),
  },
  layout: { linker: 'isolated' },
});
console.log(changedDependencies);
```

Pass the result to `decideAffected` as `changedDependencies`. Use `null` for an
absent snapshot, such as an added or deleted lockfile. `manifest` is the
consuming project's manifest at that endpoint; use `''` only when absent.
For workspace lockfiles, set each snapshot's `importerPath` to the project
directory relative to the lockfile directory (default `'.'`).

The function itself performs no I/O and throws on invalid input. It supports
pnpm, Yarn Classic, Yarn Berry, and npm, including version-aware transitive
changes. See [dependency analysis](https://github.com/oblador/sovra/blob/main/docs/dependency-analysis.md)
for supported versions, peer limitations, and how to supply linker/public-hoist
settings. The explicit isolated layout above excludes public hoists.

## Git and project configuration

`readGitChanges({ cwd, base?, defaultBranch? })` returns absolute changed paths,
untracked paths, and resolved comparison endpoints. It does not infer changed
dependencies. A single base ref compares with the working tree; commit ranges
and default-branch comparisons follow the
[CLI rules](https://github.com/oblador/sovra/blob/main/docs/usage.md#choosing-changes).

`loadSovraConfig({ rootDir, configPath? })` returns `{ config, configPath? }`.
Programmatic selection does not load it automatically. Apply its source-analysis
options to your project configuration and pass its `runAllOn` to selection;
Git defaults belong to your change-loading step. See the
[configuration reference](https://github.com/oblador/sovra/blob/main/docs/usage.md#sovra-configuration).

## Custom test runners

Implement `TestRunner` when you also want Sovra to dispatch test execution:

- `loadConfig(): Promise<ResolvedTestConfig>` discovers tests and settings.
- `run(testFiles, passthrough?): Promise<RunResult>` runs selected files.
- `runAll(passthrough?): Promise<RunResult>` runs the full suite.

Both execution methods return `{ success: boolean }`. `runAffected({ runner,
changedFiles, changedDependencies?, runAllOn?, passthrough? })` combines discovery,
selection, and execution, returning `{ success, decision }`. It still takes
explicit change data; it does not read Git or Sovra config.

Once your adapter implements that interface, expose the shared CLI like this:

```ts
import { cli } from '@sovra/core';
import { MyRunner } from './my-runner.js';

process.exitCode = await cli(process.argv.slice(2), {
  name: 'sovra-myrunner',
  runner: 'myrunner',
  createRunner: (options) => new MyRunner(options),
});
```

Your constructor should accept the supplied `rootDir`, `configPath`, and
source-analysis overrides. Unlike `runAffected`, `cli` loads project defaults,
Git changes, and lockfile snapshots. Its arguments and exit codes are documented
in the [CLI guide](https://github.com/oblador/sovra/blob/main/docs/usage.md).

For repository build and test commands, see
[contributing](https://github.com/oblador/sovra/blob/main/CONTRIBUTING.md).
