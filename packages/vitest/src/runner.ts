import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  AnalysisOptions,
  NapiResolveOptions,
  ResolvedTestConfig,
  ResolvedTestProjectConfig,
  RunResult,
  TestRunner,
} from '@sovra/core';
import type { TestProject, Vitest } from 'vitest/node' with { 'resolution-mode': 'import' };

type VitestAPI = typeof import('vitest/node', { with: { 'resolution-mode': 'import' } });

export interface VitestRunnerOptions extends AnalysisOptions {
  /** Project root. Defaults to process.cwd(). */
  rootDir?: string;
  /** Vitest/Vite config path, resolved relative to rootDir. */
  configPath?: string;
}

const REQUIRE_ALIASES = ['vi.importActual', 'vi.importMock', 'vitest.importActual', 'vitest.importMock'];

/** A one-shot adapter using the target project's Vitest 4 public Node API. */
export class VitestRunner implements TestRunner {
  private readonly rootDir: string;
  private readonly configPath?: string;

  constructor(private readonly options: VitestRunnerOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? process.cwd());
    this.configPath = options.configPath
      ? path.resolve(this.rootDir, options.configPath) : undefined;
  }

  private async api(): Promise<VitestAPI> {
    const require = createRequire(path.join(this.rootDir, '__sovra_vitest__.js'));
    const { version } = require('vitest/package.json') as { version: string };
    if (!version.startsWith('4.')) {
      throw new Error(`@sovra/vitest requires Vitest 4; found ${version}.`);
    }
    // Node16 compilation preserves native import(), so Vitest's ESM entry
    // works even when this adapter is loaded by a CommonJS consumer.
    return import(pathToFileURL(require.resolve('vitest/node')).href) as Promise<VitestAPI>;
  }

  private baseOptions() {
    return {
      root: this.rootDir,
      ...(this.configPath ? { config: this.configPath } : {}),
      watch: false,
      run: true,
    };
  }

  async loadConfig(): Promise<ResolvedTestConfig> {
    const { createVitest } = await this.api();
    const vitest = await createVitest('test', this.baseOptions());
    try {
      this.normalizeTestDirectories(vitest);
      const specifications = await vitest.globTestSpecifications();
      const rootProject = vitest.getRootProject();
      const globalSentinels = this.configurationFiles(rootProject);
      if (this.configPath) globalSentinels.push(this.configPath);
      const requireAliases = this.options.requireAliases ?? REQUIRE_ALIASES;
      const configuredProjects = [...vitest.projects];
      // The root can have global setup even when it doesn't own any tests.
      // Analyze it with its own aliases instead of a child project's resolver.
      if (!configuredProjects.includes(rootProject)) configuredProjects.push(rootProject);
      const projects: ResolvedTestProjectConfig[] = configuredProjects.map((project) => ({
        rootDir: project.config.root,
        testFiles: [...new Set(specifications
          .filter((spec) => spec.project === project)
          .map((spec) => path.resolve(spec.moduleId)))],
        sentinelFiles: [...new Set([
          ...(project === rootProject ? globalSentinels : []),
          ...this.configurationFiles(project),
          ...project.config.setupFiles,
          ...project.config.globalSetup,
        ])],
        resolveOptions: this.resolveOptionsFor(project),
        requireAliases,
        ignoreTypeImports: this.options.ignoreTypeImports ?? !project.config.typecheck.enabled,
      }));
      return {
        rootDir: vitest.config.root,
        projects,
      };
    } finally {
      await vitest.close();
    }
  }

  async run(testFiles: string[], passthrough: string[] = []): Promise<RunResult> {
    if (testFiles.length === 0) return { success: true };
    return this.execute(testFiles, passthrough);
  }

  async runAll(passthrough: string[] = []): Promise<RunResult> {
    return this.execute(undefined, passthrough);
  }

  private async execute(testFiles: string[] | undefined, passthrough: string[]): Promise<RunResult> {
    const { createVitest, parseCLI, TestsNotFoundError } = await this.api();
    const { options, filter } = parseCLI(['vitest', ...passthrough]);
    for (const option of ['root', 'config', 'mode', 'environment', 'browser'] as const) {
      if (options[option] !== undefined) {
        throw new Error(`Vitest --${option} cannot be passed only at execution time. Set it in the runner configuration so discovery uses the same settings.`);
      }
    }
    const previousExitCode = process.exitCode;
    let vitest: Vitest | undefined;
    let success = false;
    // Vitest communicates coverage/snapshot/teardown failures through the
    // process exit code as well as its result. Keep that out of the host API.
    process.exitCode = 0;
    try {
      vitest = await createVitest('test', { ...options, ...this.baseOptions() });
      this.normalizeTestDirectories(vitest);
      try {
        if (testFiles) {
          // The public initialization method was renamed in Vitest 4.1.
          if (typeof vitest.standalone === 'function') await vitest.standalone();
          else await vitest.init();
          const selected = new Set(testFiles.map((file) => path.resolve(this.rootDir, file)));
          const specs = (await vitest.globTestSpecifications(filter))
            .filter((spec) => selected.has(path.resolve(spec.moduleId)));
          if (specs.length === 0) {
            success = Boolean(vitest.config.passWithNoTests);
          } else {
            const result = await vitest.runTestSpecifications(specs);
            success = result.unhandledErrors.length === 0 && result.testModules.every((mod) => mod.ok());
          }
        } else {
          const result = await vitest.start(filter);
          success = result.unhandledErrors.length === 0 && result.testModules.every((mod) => mod.ok());
        }
      } catch (error) {
        if (!(error instanceof TestsNotFoundError)) throw error;
        success = Boolean(vitest.config.passWithNoTests);
      }
      await vitest.close();
      vitest = undefined;
      return { success: success && Number(process.exitCode ?? 0) === 0 };
    } finally {
      try {
        await vitest?.close();
      } finally {
        process.exitCode = previousExitCode;
      }
    }
  }

  private normalizeTestDirectories(vitest: Vitest): void {
    // Vitest leaves test.dir relative and globs it against process.cwd().
    // Honor rootDir even when the host is launched from another directory.
    for (const project of new Set([...vitest.projects, vitest.getRootProject()])) {
      if (project.config.dir) {
        project.config.dir = path.resolve(project.config.root, project.config.dir);
      }
    }
  }

  private configurationFiles(project: TestProject): string[] {
    const config = project.vite.config;
    const files = [...config.configFileDependencies];
    if (config.configFile) files.push(config.configFile);
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const file = path.join(project.config.root, name);
      if (existsSync(file)) files.push(file);
    }
    return files;
  }

  private resolveOptionsFor(project: TestProject): NapiResolveOptions {
    const config = project.vite.config;
    const alias: Record<string, Array<string | null>> = {};
    for (const entry of config.resolve.alias) {
      // Vite string aliases match the exact name and slash-prefixed children,
      // just like sovra aliases. Regex/plugin aliases need an explicit override.
      if (typeof entry.find === 'string' && !(entry.find in alias)) {
        alias[entry.find] = [entry.replacement];
      }
    }
    const browser = project.isBrowserEnabled();
    const resolve = browser ? config.resolve : config.ssr.resolve;
    const conditions = (resolve?.conditions ?? []).map((condition) =>
      condition === 'development|production'
        ? (config.isProduction ? 'production' : 'development') : condition);
    const tsconfig = path.join(project.config.root, 'tsconfig.json');
    const includeTypes = !(this.options.ignoreTypeImports ?? !project.config.typecheck.enabled);
    return {
      extensions: [...new Set([
        ...config.resolve.extensions,
        ...(includeTypes ? ['.d.ts', '.d.mts', '.d.cts'] : []),
      ])],
      modules: ['node_modules'],
      roots: [project.config.root],
      conditionNames: [...new Set([browser ? 'browser' : 'node', 'import', 'default', ...conditions])],
      mainFields: resolve?.mainFields ?? config.resolve.mainFields,
      builtinModules: true,
      alias,
      ...(existsSync(tsconfig) ? { tsconfig: { configFile: tsconfig } } : {}),
      ...this.options.resolveOptions,
    };
  }
}
