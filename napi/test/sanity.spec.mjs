// @ts-check
import * as assert from "node:assert";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAffected } from "../index.js";

const fixturesPath = resolve(
  fileURLToPath(import.meta.url),
  "../../../fixtures/nested"
);

const testFiles = [
  join(fixturesPath, "module.spec.js"),
  join(fixturesPath, "sub-module.spec.js"),
];
const changedFiles = [join(fixturesPath, "another-module.js")];
const resolverOptions = {
  extensions: [".js", ".jsx", ".ts", ".tsx"],
  moduleDirectories: ["node_modules"],
  rootDir: process.cwd(),
};

const affected = getAffected(testFiles, changedFiles, resolverOptions);

assert.deepEqual(affected.errors, []);
assert.deepEqual(affected.files.sort(), testFiles.sort());
