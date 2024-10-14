# Sovra

Fast test decider for JavaScript projects, written in Rust on top of Oxc.

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
requre(process.env.SOME_VAR + ".js"); // ❌
import(`./file.${platform}.mjs`); // ❌
```

## License

MIT © Joel Arvidsson 2024
