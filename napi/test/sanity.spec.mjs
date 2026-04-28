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
/** @type {import('..').NapiResolveOptions} */
const resolverOptions = {
  extensions: [".js", ".jsx", ".ts", ".tsx"],
};

const affected = getAffected(testFiles, changedFiles, resolverOptions);

assert.deepEqual(affected.errors, []);
assert.deepEqual(affected.files.sort(), testFiles.sort());

const tsFixturesPath = resolve(
  fileURLToPath(import.meta.url),
  "../../../fixtures/typescript"
);
/** @type {import('..').NapiResolveOptions} */
const tsResolverOptions = {
  extensions: [".ts"],
  tsconfig: {
    configFile: join(tsFixturesPath, "tsconfig.json"),
    references: "auto",
  },
};
const typeImportTestFiles = [join(tsFixturesPath, "type-import.ts")];
const typeImportChangedFiles = [join(tsFixturesPath, "aliased.ts")];

const typeImportAffected = getAffected(
  typeImportTestFiles,
  typeImportChangedFiles,
  tsResolverOptions
);
assert.deepEqual(typeImportAffected.errors, []);
assert.deepEqual(typeImportAffected.files, typeImportTestFiles);

const typeImportIgnored = getAffected(
  typeImportTestFiles,
  typeImportChangedFiles,
  tsResolverOptions,
  true
);
assert.deepEqual(typeImportIgnored.errors, []);
assert.deepEqual(typeImportIgnored.files, []);
