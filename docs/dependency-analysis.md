# Dependency analysis

The Jest and Vitest CLIs infer changed dependencies when a relevant lockfile
changes. A transitive dependency update can affect tests even when application
source files are unchanged.

Comparison is version-aware: if `x` depends on `y@1` and `z` depends on `y@2`,
updating `y@1` affects `x` without automatically affecting `z`.

## Supported lockfiles

| Package manager | Files | Lockfile versions |
| --- | --- | --- |
| pnpm | `pnpm-lock.yaml` | 5, 6, 9 |
| Yarn Classic | `yarn.lock` | 1 |
| Yarn Berry | `yarn.lock` | Berry format with `__metadata` |
| npm | `package-lock.json`, `npm-shrinkwrap.json` | 2, 3 |

Only changed lockfiles in the project or its ancestors are considered. The
nearest directory wins; within it, priority is pnpm, Yarn, npm shrinkwrap,
then npm package-lock. Unchanged alternatives and sibling projects' lockfiles
are not inspected. The CLI compares one selected lockfile; it does not reconcile
a migration involving multiple lockfile names.

Added and deleted lockfiles are compared against absence. An unreadable,
invalid, or unsupported lockfile is an analysis failure, not an empty diff.
The CLI then requires the full suite. A relevant untracked lockfile outside a
requested commit range also requires the full suite.

Use `--no-analyze-lockfile` to disable automatic analysis. Explicit `npm:` entries
replace the inferred dependency list; they are not merged with lockfile results.

Changes to `package.json`, `pnpm-workspace.yaml`, `.npmrc`, or `.yarnrc.yml` alone
do not trigger dependency analysis or a full run. Update the lockfile, supply
changed dependencies explicitly, or use `runAllOn` for configuration files that
should require all tests. A manifest used as executable runner configuration
can still trigger a full run through the adapter's config rules.

## Linker and hoisting settings

Sovra reports dependency names that application code can import under the
configured layout:

- **Isolated:** declared direct dependencies, including those affected by
  transitive updates. pnpm's public hoists additionally expose matching
  transitive package names.
- **Hoisted:** npm's lockfile identifies the top-level installed packages.
  For pnpm and Yarn, Sovra conservatively includes all affected package names,
  which can select additional tests.
- **PnP:** direct dependencies only; pnpm public-hoist settings do not broaden
  this list. This controls dependency reporting, not support for a PnP-specific
  source resolver.

The CLI reads `.npmrc`, `pnpm-workspace.yaml`, `package.json#pnpm`, and
`.yarnrc.yml` as relevant to the selected format. It uses the newer endpoint's
layout for both lockfiles: current files for a working-tree comparison, or the
end commit's files for a commit range. It does not compare old and new layout
settings separately.

For pnpm, supported settings are `nodeLinker` / `node-linker`,
`shamefullyHoist` / `shamefully-hoist`, and `publicHoistPattern` /
`public-hoist-pattern[]`. Public-hoist patterns support `*` and ordered `!`
exclusions. `shamefullyHoist: true` exposes all packages publicly without
changing the linker to `hoisted`. Private `hoistPattern` settings do not expose
additional application imports.

Workspace settings are found by walking up from the project. Workspace YAML
settings override `.npmrc`, which overrides legacy `package.json#pnpm` settings.
Installation metadata (`node_modules/.modules.yaml`) is not read. Keep
install-time overrides in project configuration if they should affect analysis.

## Peer dependency limitations

- **pnpm:** resolved peer versions are part of package instance identities.
- **npm:** peers are resolved through the recorded `node_modules` layout.
- **Yarn Berry:** peer propagation is conservative across all resolved versions
  of the peer's name, potentially selecting extra tests.
- **Yarn Classic:** its lockfile does not record peer relationships. A test that
  imports only a peer-dependent package can be missed when its peer changes.
  Add a `runAllOn` entry for important peers if you need a full-suite fallback.

These rules do not remove static source-analysis limitations, such as imports
whose paths are calculated at runtime.

## Programmatic comparison

Use [`diffDependencies`](../packages/core/README.md#dependency-changes) with
before/after text snapshots and an optional shared layout. The function reads
no files, runs no Git commands, and throws on invalid inputs. Each snapshot
selects its own parser, so programmatic callers can compare different formats.

Without an explicit layout, npm and Yarn Classic default to hoisted; pnpm and
Yarn Berry default to isolated. `parsePnpmLayout({ manifest, npmrc, workspace })`
converts supplied configuration text into a layout without reading files.
Use `{ linker: 'isolated' }` with no public-hoist patterns to report direct
dependencies only.
