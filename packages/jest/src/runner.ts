import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type {
  AnalysisOptions,
  NapiResolveOptions,
  ResolvedTestConfig,
  ResolvedTestProjectConfig,
  RunResult,
  TestRunner,
} from '@sovra/core';

/**
 * Minimal structural views of the jest internals we touch. The real modules
 * are resolved from the *target project* at runtime (see {@link JestRunner}),
 * so we deliberately avoid importing their types at build time — that keeps
 * `@sovra/jest` from hard-depending on a particular jest version.
 */
interface JestProjectConfig {
  rootDir: string;
  moduleFileExtensions: string[];
  moduleDirectories: string[];
  modulePaths?: string[];
  setupFiles: string[];
  setupFilesAfterEnv: string[];
  globalSetup?: string | null;
  globalTeardown?: string | null;
  /** Normalized to `Array<[regexString, replacement]>`. */
  moduleNameMapper: Array<[string, string | string[]]>;
}

interface JestGlobalConfig {
  rootDir: string;
}

interface JestTest {
  path: string;
}

type JestRequire = NodeJS.Require;

export interface JestRunnerOptions extends AnalysisOptions {
  /** Project root. Defaults to `process.cwd()`. */
  rootDir?: string;
  /** Explicit path to a jest config file (forwarded as `--config`). */
  configPath?: string;
}

const DEFAULT_REQUIRE_ALIASES = ['jest.requireActual', 'jest.requireMock'];

/**
 * {@link TestRunner} adapter for jest.
 *
 * Everything is done programmatically against the jest installation found in
 * the target project — no child processes. `loadConfig` infers the test/config/
 * setup files and resolver options; `run`/`runAll` drive `runCLI`.
 */
export class JestRunner implements TestRunner {
  private readonly rootDir: string;
  private readonly options: JestRunnerOptions;
  private readonly require: JestRequire;

  constructor(options: JestRunnerOptions = {}) {
    this.options = options;
    this.rootDir = path.resolve(options.rootDir ?? process.cwd());
    // Resolve jest's own packages from the project so versions always match.
    this.require = createRequire(path.join(this.rootDir, '__sovra_jest__.js'));
  }

  /** Build the `Config.Argv` skeleton readConfigs/runCLI expect. */
  private baseArgv(): Record<string, unknown> {
    const argv: Record<string, unknown> = { $0: 'sovra-jest', _: [] };
    if (this.options.configPath) argv.config = this.options.configPath;
    return argv;
  }

  /** Project argument expected by Jest's config loader for this invocation. */
  private jestProjects(): string[] {
    return [
      this.options.configPath
        ? path.resolve(this.options.configPath)
        : this.rootDir,
    ];
  }

  async loadConfig(): Promise<ResolvedTestConfig> {
    const { readConfigs } = this.require('jest-config') as {
      readConfigs: (
        argv: unknown,
        projects: string[],
      ) => Promise<{ globalConfig: JestGlobalConfig; configs: JestProjectConfig[] }>;
    };
    const { SearchSource } = this.require('@jest/core') as {
      SearchSource: new (context: unknown) => {
        getTestPaths: (
          globalConfig: JestGlobalConfig,
        ) => Promise<{ tests: JestTest[] }>;
      };
    };
    const Runtime = this.requireDefault('jest-runtime') as {
      createContext: (
        config: JestProjectConfig,
        options: { maxWorkers: number; watchman: boolean },
      ) => Promise<unknown>;
    };

    const { globalConfig, configs } = await readConfigs(
      this.baseArgv(),
      this.jestProjects(),
    );

    const projects: ResolvedTestProjectConfig[] = [];
    const requireAliases =
      this.options.requireAliases ?? DEFAULT_REQUIRE_ALIASES;
    const ignoreTypeImports = this.options.ignoreTypeImports ?? true;
    const globalSentinels = new Set(
      this.collectConfigurationSentinels(this.rootDir),
    );

    // The explicitly-selected config file may live above the project roots.
    if (this.options.configPath) {
      globalSentinels.add(path.resolve(this.options.configPath));
    }

    for (const config of configs) {
      const context = await Runtime.createContext(config, {
        maxWorkers: 1,
        watchman: false,
      });
      const search = new SearchSource(context);
      const { tests } = await search.getTestPaths(globalConfig);
      const projectTestFiles = tests.map((test) => test.path);
      const projectSentinels = new Set([
        ...globalSentinels,
        ...this.collectSentinels(config),
      ]);

      projects.push({
        rootDir: config.rootDir,
        testFiles: projectTestFiles,
        sentinelFiles: [...projectSentinels],
        resolveOptions: this.resolveOptionsFor(config),
        requireAliases,
        ignoreTypeImports,
      });
    }

    return {
      rootDir: this.rootDir,
      projects,
    };
  }

  async run(testFiles: string[], passthrough: string[] = []): Promise<RunResult> {
    const argv = {
      ...this.parsePassthrough(passthrough),
      ...this.baseArgv(),
      _: testFiles,
      runTestsByPath: true,
    };
    return this.runCLI(argv);
  }

  async runAll(passthrough: string[] = []): Promise<RunResult> {
    const parsed = this.parsePassthrough(passthrough);
    const argv = {
      ...parsed,
      ...this.baseArgv(),
      _: (parsed._ as unknown[] | undefined) ?? [],
    };
    return this.runCLI(argv);
  }

  private async runCLI(argv: Record<string, unknown>): Promise<RunResult> {
    const { runCLI } = this.require('@jest/core') as {
      runCLI: (
        argv: unknown,
        projects: string[],
      ) => Promise<{ results: { success: boolean } }>;
    };
    const { results } = await runCLI(argv, this.jestProjects());
    return { success: results.success };
  }

  /** Setup + lifecycle files; all already absolute in the normalized config. */
  private collectSentinels(config: JestProjectConfig): string[] {
    const files: string[] = [
      ...config.setupFiles,
      ...config.setupFilesAfterEnv,
    ];
    if (config.globalSetup) files.push(config.globalSetup);
    if (config.globalTeardown) files.push(config.globalTeardown);

    files.push(...this.collectConfigurationSentinels(config.rootDir));
    return files;
  }

  /** Conventional config files rooted at one Jest project or workspace root. */
  private collectConfigurationSentinels(rootDir: string): string[] {
    const files: string[] = [];
    // Jest config, babel and tsconfig at the project root are universal test
    // deps too: changing any of them should force the whole suite to run.
    for (const name of [
      'jest.config.js',
      'jest.config.cjs',
      'jest.config.mjs',
      'jest.config.ts',
      'jest.config.json',
      'babel.config.js',
      'babel.config.cjs',
      'babel.config.mjs',
      'babel.config.json',
      '.babelrc',
      '.babelrc.js',
      '.babelrc.cjs',
      '.babelrc.json',
      'tsconfig.json',
    ]) {
      const file = path.join(rootDir, name);
      if (existsSync(file)) files.push(file);
    }
    // A package.json that carries jest/babel config is a sentinel as well.
    const pkgJson = path.join(rootDir, 'package.json');
    if (existsSync(pkgJson) && this.packageJsonHoldsConfig(pkgJson)) {
      files.push(pkgJson);
    }
    return files;
  }

  /** Infer sovra resolver options for exactly one normalized Jest project. */
  private resolveOptionsFor(config: JestProjectConfig): NapiResolveOptions {
    const alias = this.aliasFromModuleNameMapper(config);
    const tsconfigFile = path.join(config.rootDir, 'tsconfig.json');
    const modules = [
      ...(config.modulePaths ?? []),
      ...config.moduleDirectories,
    ];

    return {
      extensions: config.moduleFileExtensions.map((ext) => `.${ext}`),
      modules: [...new Set(modules)],
      roots: [config.rootDir],
      conditionNames: ['node', 'require', 'default'],
      mainFields: ['main', 'module'],
      builtinModules: true,
      ...(Object.keys(alias).length > 0 ? { alias } : {}),
      ...(existsSync(tsconfigFile)
        ? { tsconfig: { configFile: tsconfigFile } }
        : {}),
      ...this.options.resolveOptions,
    };
  }

  /** Whether a package.json embeds jest or babel config (making it a sentinel). */
  private packageJsonHoldsConfig(pkgJsonPath: string): boolean {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<
        string,
        unknown
      >;
      return pkg.jest !== undefined || pkg.babel !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Best-effort conversion of jest's regex-based `moduleNameMapper` into
   * sovra's webpack-style `alias`. Only simple prefix patterns
   * (`^<prefix>/(.*)$` or `^<prefix>$`) are handled; anything else is left to
   * the tsconfig `paths`. `<rootDir>` tokens are expanded.
   */
  private aliasFromModuleNameMapper(
    config: JestProjectConfig,
  ): Record<string, Array<string | null>> {
    const alias: Record<string, Array<string | null>> = {};
    for (const [pattern, replacement] of config.moduleNameMapper ?? []) {
      const exact = /^\^([^^$()|\\?*+[\]{}.]+)\$$/.exec(pattern);
      const prefix = /^\^([^^$()|\\?*+[\]{}.]+)\/\(\.\*\)\$$/.exec(pattern);
      const match = exact ?? prefix;
      if (!match) continue;
      const key = exact ? `${match[1]}$` : match[1];
      const replacements = Array.isArray(replacement)
        ? replacement
        : [replacement];
      alias[key] = replacements.map((target) =>
        target
          .replace(/<rootDir>/g, config.rootDir)
          .replace(/\/?\$1$/, ''),
      );
    }
    return alias;
  }

  /**
   * Parse jest passthrough flags into the `Config.Argv` shape `runCLI` wants,
   * using jest's own yargs option definitions for correct type coercion.
   * Resolution and parsing failures propagate rather than guessing flag semantics.
   */
  private parsePassthrough(passthrough: string[]): Record<string, unknown> {
    if (!passthrough || passthrough.length === 0) return { _: [] };
    const yargsParser = this.requireDefault('yargs-parser') as (
      args: string[],
      opts?: unknown,
    ) => Record<string, unknown>;
    const { yargsOptions } = this.require('jest-cli') as {
      yargsOptions: Record<
        string,
        { type?: string; alias?: string | string[] }
      >;
    };
    return yargsParser(passthrough, buildYargsParserOptions(yargsOptions));
  }

  /** Load a module's default export, tolerating both ESM-interop and CJS. */
  private requireDefault(id: string): unknown {
    const mod = this.require(id) as { default?: unknown };
    return mod && mod.default ? mod.default : mod;
  }
}

/** Translate jest's `yargsOptions` map into a `yargs-parser` config. */
function buildYargsParserOptions(
  yargsOptions: Record<string, { type?: string; alias?: string | string[] }>,
): Record<string, unknown> {
  const boolean: string[] = [];
  const string: string[] = [];
  const array: string[] = [];
  const number: string[] = [];
  const alias: Record<string, string[]> = {};
  for (const [key, opt] of Object.entries(yargsOptions)) {
    switch (opt.type) {
      case 'boolean':
        boolean.push(key);
        break;
      case 'string':
        string.push(key);
        break;
      case 'array':
        array.push(key);
        break;
      case 'number':
        number.push(key);
        break;
    }
    if (opt.alias) alias[key] = Array.isArray(opt.alias) ? opt.alias : [opt.alias];
  }
  return {
    boolean,
    string,
    array,
    number,
    alias,
    configuration: { 'camel-case-expansion': true, 'dot-notation': false },
  };
}
