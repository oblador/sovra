# CLI and configuration

This guide applies to `sovra-jest` and `sovra-vitest`. Both require Node.js 24
or newer and use the test runner installed in your project. Examples use
`sovra-jest`; substitute `sovra-vitest` for Vitest.

## Choosing changes

```sh
# Compare the working tree with the branch point from origin/main
pnpm exec sovra-jest

# Compare the working tree with a specific ref
pnpm exec sovra-jest --base HEAD~1

# Compare commits, using their common ancestor as the baseline
pnpm exec sovra-jest --base origin/main...HEAD

# Supply changed paths yourself
pnpm exec sovra-jest src/math.ts src/util.ts

# Read a newline-separated changeset from a file or stdin
pnpm exec sovra-jest --changeset changed-files.txt
pnpm exec sovra-jest --changeset - < changed-files.txt
```

Change selection uses the first available source: positional entries,
`--changeset`, `--base` (including a configured base), then the merge-base of
`origin/<defaultBranch>` and `HEAD`. The default branch is `main`; use
`--default-branch master` or configure it below. CI checkouts need the relevant
refs and enough history to resolve the comparison; Sovra does not fetch them.

A single `--base` ref includes staged and unstaged working-tree changes.
`A..B` compares A with B; `A...B` compares their merge-base with B. Git-derived
changesets include untracked paths in either case. Tests and source analysis
always use the current checkout, even when comparing historical commits.

Changed paths are relative to `--root` (the current directory by default), or
absolute. In a monorepo, invoke Sovra for the consuming project:

```sh
pnpm exec sovra-jest --root packages/app
```

### Supplying changed dependencies

Mix `npm:` entries with paths in positional arguments or a changeset file:

```text
src/math.ts
npm:lodash
npm:@scope/client
```

When any `npm:` entries are supplied, they are the **complete dependency change
list**: automatic lockfile analysis is skipped, even with `--analyze-lockfile`.
Paths are still analyzed, and `runAllOn` still applies. Without `npm:` entries,
a changed lockfile is analyzed by default. Use `--no-analyze-lockfile` to disable
that step. See [dependency analysis](dependency-analysis.md) for supported formats
and hoisting behavior.

## Previewing and consuming a selection

`--list` and `--dry-run` are equivalent: neither executes tests. They print
absolute test paths, one per line, with diagnostics on stderr.

| Result | Exit code | stdout |
| --- | --- | --- |
| Selected tests | `0` | One test path per line |
| No affected tests | `0` | Empty |
| Full suite required | `254` | Empty; the reason is on stderr |
| Cannot complete analysis or load configuration | `1` | Not a usable selection |

Always check the exit code before consuming the file. For example, this shell
snippet saves a selection for another tool and stops if selection was incomplete:

```sh
status=0
pnpm exec sovra-jest --list > affected-tests.txt || status=$?
case "$status" in
  0) ;; # The file is usable; an empty file means no affected tests.
  254) echo 'Full suite required; do not use the selection file.' >&2; exit 254 ;;
  *) exit "$status" ;;
esac
```

Do not pass an empty selection to a runner that interprets it as "run everything."
For normal test execution, use `sovra-jest` or `sovra-vitest` directly: they handle
the empty and full-suite cases and avoid putting every selected path into a
shell command line. `--list` is for integrations that need to consume the paths.

## Sovra configuration

Create `sovra.config.mts` in the selected project root:

```ts
import type { SovraConfig } from '@sovra/jest'; // or @sovra/vitest

export default {
  defaultBranch: 'main',
  analyzeLockfile: true,
  runAllOn: ['config/test/**', 'npm:typescript'],
} satisfies SovraConfig;
```

Sovra also recognizes `.ts`, `.cts`, `.js`, `.mjs`, and `.cjs`. Use
`--sovra-config <path>` to select a file explicitly; `--config` selects the
**test runner's** config instead. CLI flags override config defaults.

| Option | Default | Purpose |
| --- | --- | --- |
| `defaultBranch` | `'main'` | Remote branch name without `origin/` |
| `base` | Unset | Git ref or range; explicit changesets still take precedence |
| `analyzeLockfile` | `true` | Infer dependency changes from changed lockfiles |
| `runAllOn` | `[]` | Changed paths or dependencies that require all tests |
| `ignoreTypeImports` | Runner-specific | Include or skip type-only imports |
| `requireAliases` | Runner-specific | Additional require-like function names |
| `resolveOptions` | Runner-inferred | Module-resolution overrides |

`--analyze-lockfile` can re-enable a disabled config default. Root, changesets,
preview mode, and runner arguments are invocation options, not config fields.
Unknown config keys, invalid values, missing explicit configs, and multiple
discovered configs cause an error. There is no ancestor lookup or automatic
merging; import and spread shared defaults explicitly.

### Full-suite triggers

`runAllOn` is one array of file paths/globs and `npm:` entries:

- File patterns are relative to the project root, even if the config lives
  elsewhere. Absolute paths and an optional `file:` prefix are supported.
  Patterns match changed paths directly, including deleted files and dotfiles;
  they do not search the disk or follow those files' imports.
- Package entries match at path-segment boundaries. `npm:react` does not match
  `react-dom`; `npm:@scope` covers that scope. A whole-package change also
  matches a configured subpath such as `npm:lodash/fp`.
- Package entries are prefixes, not globs. Negated `runAllOn` rules are not supported.

Changing Sovra's config or its imported helpers does not automatically run all
tests. Add their paths to `runAllOn` if desired. Runner configuration and setup
files still trigger full runs according to the adapter's rules.

### Source-analysis overrides

- `ignoreTypeImports: true` skips type-only imports; `false` includes them.
  Jest and normal Vitest projects skip them by default. Vitest typechecking
  projects include them.
- `requireAliases` **replaces** the default list of require-like functions.
  Entries are `functionName` or `object.method`. `[]` disables these aliases,
  not ordinary `require()`. Jest defaults to `jest.requireActual` and
  `jest.requireMock`; Vitest uses `vi.importActual`, `vi.importMock`, and their
  `vitest.*` equivalents.
- `resolveOptions` shallowly overrides the inferred resolver settings. Supplied
  arrays and alias maps replace the entire corresponding field. Use absolute
  paths for filesystem mappings. The option type is `NapiResolveOptions`,
  re-exported by both adapters.

These options belong in Sovra config for CLI use. Programmatic runner
constructors accept them too, but do not automatically load Sovra config.

### JavaScript and TypeScript config files

Configs use Node's module rules. `.mts` works for ESM syntax in either a
CommonJS or ESM project; `.cts` with `module.exports` is explicitly CommonJS.
ESM configs must default-export the options object. Relative ESM imports need
extensions, such as `./defaults.mts`.

Node strips types, including `import type` and `satisfies`, but does not apply
`tsconfig` path aliases or transform enums or parameter properties by default.
Programmatic config loads use Node's module cache; start a new process to reload
an edited config or imported helper.

## Failure behavior

Unresolved imports, dynamic import/require arguments, unreadable source files,
and parser errors produce a full-suite decision rather than an empty or partial
selection. Lockfile-analysis failures also require the full suite. Config,
native binding, or Git-loading errors that stop the command exit unsuccessfully.

Normal execution runs the full suite when required. Passing tests or no affected
tests return `0`; failures return `1`. In preview mode, a full-suite decision
returns `254` instead of running tests.

An empty changeset exits before loading the test runner, so that case needs no
project install. Lockfile comparison also needs no project install. Source
analysis generally needs the runner and relevant project dependencies installed.
Sovra itself and any dependencies imported by its config must still be available.

## Runner arguments

Put Sovra options before `--` and test-execution options after it:

```sh
pnpm exec sovra-jest --base origin/main -- --ci --coverage
pnpm exec sovra-vitest --base origin/main -- --reporter=verbose
```

Pass root/config selection before `--` so discovery and execution agree.
Execution filters can further narrow what runs; for example, a test-name filter
still applies when Sovra requests all tests. See the
[Jest](../packages/jest/README.md) and [Vitest](../packages/vitest/README.md)
guides for runner-specific restrictions.
