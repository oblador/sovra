# @sovra/jest

Run only the Jest tests affected by source or dependency changes, using your
existing Jest configuration. Changes to test configuration or setup, and
incomplete analysis, fall back to the full suite.

## Install and run

Requires **Node.js 24 or newer** and **Jest 29+** installed in your project.

```sh
pnpm add -D @sovra/jest
pnpm exec sovra-jest
```

By default, Sovra compares your working tree with the merge-base of
`origin/main` and `HEAD`. Add a package script for everyday use:

```json
{
  "scripts": {
    "test:affected": "sovra-jest"
  }
}
```

```sh
pnpm test:affected
pnpm test:affected --base HEAD~1
pnpm test:affected -- --ci --coverage
```

## Choose changes or preview tests

```sh
# Supply changed source files or dependencies
pnpm exec sovra-jest src/math.ts npm:lodash

# Compare commits rather than the working tree
pnpm exec sovra-jest --base origin/main...HEAD

# Read a newline-separated changeset
pnpm exec sovra-jest --changeset changed-files.txt

# Print selected test paths without running tests
pnpm exec sovra-jest --list

# Select a project in a monorepo
pnpm exec sovra-jest --root packages/app
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
Selection and execution use Jest's API, so large selections do not become a
shell argument list.

## Configure selection

Create `sovra.config.mts` at the project root:

```ts
import type { SovraConfig } from '@sovra/jest';

export default {
  defaultBranch: 'main',
  runAllOn: ['jest.resolver.js', 'npm:jest', 'npm:typescript'],
} satisfies SovraConfig;
```

`runAllOn` matches changed file paths/globs and dependency names. Other options
include `base`, `analyzeLockfile`, `ignoreTypeImports`, `requireAliases`, and
`resolveOptions`. Type-only imports are skipped by default; use
`ignoreTypeImports: false` to include them.

CLI flags override config defaults. `--sovra-config` selects Sovra's config;
`--config` selects Jest's. Other supported config extensions and matching rules
are in the [configuration reference](https://github.com/oblador/sovra/blob/main/docs/usage.md#sovra-configuration).

## Jest behavior and limitations

- Tests come from your Jest configuration, including multi-project setups.
  Each project's aliases and module-resolution settings are analyzed separately.
- Setup/lifecycle files, conventional Jest/Babel configs, and `tsconfig.json`
  trigger a full run when they or their source dependencies are affected.
  A `package.json` containing Jest/Babel configuration is included too.
- Ordinary manifest/package-manager config edits do not automatically run all
  tests. Dependency changes come from changed lockfiles or explicit `npm:`
  entries. See [dependency analysis](https://github.com/oblador/sovra/blob/main/docs/dependency-analysis.md).
- `jest.requireActual` and `jest.requireMock` are followed like imports.
  Simple exact/prefix `moduleNameMapper` patterns and fallback arrays are inferred.
- Arbitrary mapper regexes, custom resolvers, and transform-generated imports
  cannot be reproduced reliably by static analysis. Supply equivalent
  `resolveOptions` where possible, or use Jest directly for those projects.

Pass execution options such as coverage, workers, and test-name filters after
`--`. Keep discovery/resolution settings in Jest or Sovra config so selection
and execution use the same settings.

## Programmatic use

```ts
import { JestRunner, runAffected } from '@sovra/jest';

const result = await runAffected({
  runner: new JestRunner({ rootDir: process.cwd() }),
  changedFiles: ['src/math.ts'],
  changedDependencies: [],
  passthrough: ['--ci'],
});
process.exitCode = result.success ? 0 : 1;
```

This API takes explicit changes; it does not read Git, compare lockfiles, or load
Sovra config. Runner constructors accept `configPath` and source-analysis
overrides. To inspect a decision without execution, use `runner.loadConfig()`
with `decideAffected`. Both functions and the shared types are re-exported from
[@sovra/core](https://github.com/oblador/sovra/tree/main/packages/core).

For repository build and test commands, see
[contributing](https://github.com/oblador/sovra/blob/main/CONTRIBUTING.md).
