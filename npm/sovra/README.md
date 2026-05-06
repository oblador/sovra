# Sovra

### Rust-based Test Decider for JavaScript using Oxc

Speed up your monorepo pipeline by only running the tests affected by your code diff.

[![X (formerly Twitter) Follow](https://img.shields.io/twitter/follow/trastknast)](https://x.com/trastknast) [![GitHub followers](https://img.shields.io/github/followers/oblador)](https://github.com/oblador)

---

[![CI](https://github.com/oblador/sovra/actions/workflows/ci.yml/badge.svg)](https://github.com/oblador/sovra/actions/workflows/ci.yml) ![GitHub top language](https://img.shields.io/github/languages/top/oblador/sovra) [![NPM Version](https://img.shields.io/npm/v/sovra)](https://www.npmjs.com/package/sovra) [![NPM License](https://img.shields.io/npm/l/sovra)](https://github.com/oblador/sovra/blob/main/LICENSE)

## Features

- **TypeScript** support, including path aliases
- **Configurable** resolver, with support for extensions, export conditions and more
- **High performance** because it is **written in Rust** using Oxc
- Easy to use with **Node API**

## Installation

```bash
yarn add sovra
```

## Usage

### `getAffected(testFiles: string[], changes: string[], resolverOptions: OxcResolverOptions, ignoreTypeImports?: boolean, requireAliases?: string[])`

Returns a subset of `testFiles` that have `changes` in their import graph. This is useful in order to determine which tests to run in a large repo.

#### Arguments

| Name                 | Description                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testFiles`          | List of files to check if they were affected by changes                                                                                                                                                                    |
| `changes`            | List of change entries. Each entry is either a file path (optionally `file:`-prefixed) or an npm package with the `npm:` prefix — see [Change entry formats](#change-entry-formats) below.                                 |
| `resolverOptions`    | Configuration on how to resolve imports, see [oxc-resolver](https://github.com/oxc-project/oxc-resolver?tab=readme-ov-file#options)                                                                                        |
| `ignoreTypeImports`  | When `true`, type-only imports `import type` are excluded from the import graph so changes to files that are only referenced for their types do not affect tests. Defaults to `false`.            |
| `requireAliases`     | List of function calls to treat like `require()` — e.g. `["jest.requireActual", "vi.importActual"]`. Each entry is `"name"` (bare call) or `"object.method"` (member call). Their first string-literal argument is collected as an import path. |

#### Change entry formats

Each entry in `changes` follows one of these forms:

| Entry                  | Meaning                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/foo.ts`           | A file path, relative to the working directory (default if no prefix is given).                                  |
| `file:src/foo.ts`      | Same as above with an explicit prefix.                                                                           |
| `npm:lodash`           | An npm package. Matches imports of `lodash` and any deep path like `lodash/fp`.                                  |
| `npm:@scope/foo`       | A scoped npm package. Matches imports of `@scope/foo` and any subpath.                                           |
| `npm:@scope`           | Treated like a package; segment-prefix matching catches every `@scope/...` import.                               |
| `npm:lodash/fp`        | A subpath entry. Matches imports of `lodash/fp` and below, but **not** `lodash` alone.                           |

Matching is done against the resolver's output when the package is installed (so a TypeScript path alias mapped to a local file won't false-match an `npm:` entry). When the resolver can't find the module on disk — e.g. you're running sovra in CI before `node_modules` is installed — sovra falls back to matching the raw import specifier, so `npm:lodash` still flags `import 'lodash'` even with no install.

Empty entries (`""`, `"npm:"`, `"file:"`) panic — they're treated as caller bugs, not user-facing errors. Resolving transitive dependency changes is the integrator's responsibility — sovra only matches packages that user code imports directly.

#### Example

```ts
import { getAffected } from "sovra";
import { execSync } from "node:child_process";
import { glob } from "glob";

const testFiles = glob.sync("src/**/*.spec.{ts,tsx}");
const changes = execSync("git diff --name-only main", { encoding: "utf8" })
  .trim()
  .split("\n");
const resolverOptions = {
  tsconfig: {
    configFile: "tsconfig.json",
  },
};

const affected = getAffected(testFiles, changes, resolverOptions);

if (affected.errors) {
  console.error(...affected.errors);
} else {
  console.log(affected.files);
}
```

## Test

```bash
cargo test
```

## Limitations

Imports using variables or expressions are not supported as they can only be determined during runtime:

```ts
require(process.env.SOME_VAR + ".js"); // ❌
import(`./file.${platform}.mjs`); // ❌
```

## License

MIT © Joel Arvidsson 2024
