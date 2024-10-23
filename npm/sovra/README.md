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

### `getAffected(testFiles: string[], changedFiles: string[], resolverOptions: OxcResolverOptions)`

Returns a subset of `testFiles` that have `changedFiles` in their import graph. This is useful in order to determine which tests to run in a large repo.

#### Arguments

| Name              | Description                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `testFiles`       | List of files to check if they were affected by changes                                                                             |
| `changedFiles`    | List of changed files                                                                                                               |
| `resolverOptions` | Configuration on how to resolve imports, see [oxc-resolver](https://github.com/oxc-project/oxc-resolver?tab=readme-ov-file#options) |

#### Example

```ts
import { getAffected } from "sovra";
import { execSync } from "node:child_process";
import { glob } from "glob";

const testFiles = glob.sync("src/**/*.spec.{ts,tsx}");
const changedFiles = execSync("git diff --name-only main", { encoding: "utf8" })
  .trim()
  .split("\n");
const resolverOptions = {
  tsconfig: {
    configFile: "tsconfig.json",
  },
};

const affected = getAffected(testFiles, changedFiles, resolverOptions);

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
