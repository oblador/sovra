# Developing Sovra

Use Node.js 24 or newer, Yarn Classic, and a Rust toolchain meeting the
`rust-version` in `Cargo.toml`.

From the repository root:

```sh
yarn install
yarn build:debug
yarn test:packages
```

`build:debug` builds the native binding and the core, Jest, and Vitest packages
in dependency order. `test:packages` rebuilds the TypeScript packages and runs
their tests, including integrations with the installed runners.

For the Rust tests, install the workspace fixture dependencies first, as CI does:

```sh
yarn --cwd fixtures/yarn-workspace install --immutable
cargo test
node --test napi/test/sanity.spec.mjs
```

Use `yarn build` for an optimized native build before measuring performance.
For TypeScript-only changes, `yarn build:packages` avoids rebuilding the binding.
Commit generated binding files if the native API changes.
