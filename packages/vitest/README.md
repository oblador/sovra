# @sovra/vitest

Run only the Vitest tests affected by source or dependency changes, using your
existing Vitest configuration. Changes to test configuration or setup, and
incomplete analysis, fall back to the full suite.

## Install and run

Requires **Node.js 24 or newer** and **Vitest 4** with a compatible Vite version.

```sh
pnpm add -D @sovra/vitest vitest@^4
pnpm exec sovra-vitest
```

By default, Sovra compares your working tree with the merge-base of
`origin/main` and `HEAD`. It uses the Vitest installation in your project.
Add a package script for everyday use:

```json
{
  "scripts": {
    "test:affected": "sovra-vitest"
  }
}
```

```sh
pnpm test:affected
pnpm test:affected --base HEAD~1
pnpm test:affected -- --reporter=verbose
```

## Choose changes or preview tests

```sh
# Supply changed source files or dependencies
pnpm exec sovra-vitest src/math.ts npm:lodash

# Compare commits rather than the working tree
pnpm exec sovra-vitest --base origin/main...HEAD

# Read a newline-separated changeset
pnpm exec sovra-vitest --changeset changed-files.txt

# Print selected test paths without running tests
pnpm exec sovra-vitest --list

# Select a project and its runner config
pnpm exec sovra-vitest --root packages/app --config vitest.config.ts
```

A single `--base` ref includes staged and unstaged edits; ranges compare commits.
Git-derived changesets also include untracked files. Changed lockfiles are
analyzed automatically unless disabled with `--no-analyze-lockfile`.
Explicit `npm:` entries replace, rather than supplement, inferred dependencies.

`--list` / `--dry-run` prints absolute paths, one per line. Exit `0` with empty
output means no affected tests; **exit `254` means the full suite is required**.
Exit `1` means the command failed. Normal execution runs the full suite when
required and reports its success or failure.

See the [CLI guide](https://github.com/oblador/sovra/blob/main/docs/usage.md) for
change precedence, CI usage, selection files, and all shared options.
Selected tests are passed through Vitest's API, not a shell argument list.

## Configure selection

Create `sovra.config.mts` at the project root:

```ts
import type { SovraConfig } from '@sovra/vitest';

export default {
  defaultBranch: 'main',
  runAllOn: ['config/test/**', 'npm:vitest', 'npm:typescript'],
} satisfies SovraConfig;
```

`runAllOn` matches changed file paths/globs and dependency names. Other options
include `base`, `analyzeLockfile`, `ignoreTypeImports`, `requireAliases`, and
`resolveOptions`. Type-only imports are skipped by default except in
typechecking projects; an explicit `ignoreTypeImports` overrides that default.

CLI flags override config defaults. `--sovra-config` selects Sovra's config;
`--config` selects Vitest's. Other supported config extensions and matching rules
are in the [configuration reference](https://github.com/oblador/sovra/blob/main/docs/usage.md#sovra-configuration).

## Vitest behavior and limitations

- Discovery uses your Vitest config without executing tests. Multiple
  `test.projects` retain their own roots and resolver settings.
- Setup files, global setup, the loaded config and its imported files, and root
  TypeScript/JavaScript config files trigger full runs when affected.
- Ordinary manifest/package-manager config edits do not automatically run all
  tests. Dependency changes come from changed lockfiles or explicit `npm:`
  entries. pnpm linker and public-hoist settings are read from configuration,
  not installation metadata. See [dependency analysis](https://github.com/oblador/sovra/blob/main/docs/dependency-analysis.md).
- Vite string aliases and resolver settings are inferred. `vi.importActual`,
  `vi.importMock`, and their `vitest.*` equivalents are followed like imports.
- Enable `test.typecheck.enabled` in Vitest config, not only via an execution
  flag, for type tests to participate in discovery and selection.
- Execution is one-shot; watch mode is disabled. Selected paths run in every
  project that contains them. An empty selection does not run the full suite.

Regex aliases, virtual modules, and custom Vite resolution/transform plugins
cannot be inferred reliably. Supply equivalent `resolveOptions` where possible,
or use Vitest directly when your imports depend on plugin-generated code.

Put root/config options before `--`. Passthrough options apply only to execution;
use them for reporters, test-name filters, coverage, or workers. Root, config,
mode, environment, and browser overrides are rejected after `--` because they
could make discovery and execution disagree.

## Programmatic use

```ts
import { VitestRunner, runAffected } from '@sovra/vitest';

const result = await runAffected({
  runner: new VitestRunner({ rootDir: process.cwd() }),
  changedFiles: ['src/math.ts'],
  changedDependencies: [],
  passthrough: ['--reporter=verbose'],
});
process.exitCode = result.success ? 0 : 1;
```

This API takes explicit changes; it does not read Git, compare lockfiles, or load
Sovra config. Runner constructors accept `configPath` and source-analysis
overrides. To inspect a decision without execution, use `runner.loadConfig()`
with `decideAffected`. The package re-exports
[@sovra/core](https://github.com/oblador/sovra/tree/main/packages/core).

For repository build and test commands, see
[contributing](https://github.com/oblador/sovra/blob/main/CONTRIBUTING.md).
