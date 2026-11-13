import type { NapiResolveOptions } from 'sovra';

export type { NapiResolveOptions };

/** Source-analysis overrides shared by config files and runner constructors. */
export interface AnalysisOptions {
  /** Skip type-only imports. Omit to preserve each runner/project's default. */
  ignoreTypeImports?: boolean;
  /** Replace the runner's default require-like function names, e.g. `loader.require`. */
  requireAliases?: string[];
  /** Shallow overrides for module-resolution options inferred by the runner. */
  resolveOptions?: Partial<NapiResolveOptions>;
}

/** One independently-resolved test project within a runner configuration. */
export interface ResolvedTestProjectConfig {
  /** Absolute root used to resolve this project's test imports. */
  rootDir: string;
  /** Candidate test files belonging to this project. */
  testFiles: string[];
  /** Project-specific files that force a full-suite fallback when affected. */
  sentinelFiles: string[];
  /** Module-resolution options for this project only. */
  resolveOptions: NapiResolveOptions;
  /** Function calls treated like `require()` while walking this project. */
  requireAliases?: string[];
  /** Exclude type-only imports from this project's dependency graph. */
  ignoreTypeImports?: boolean;
}

/**
 * The runner-agnostic description of a test project, as understood by sovra.
 *
 * A runner adapter ({@link TestRunner}) is responsible for translating its
 * native config (jest config, vitest config, …) into this shape. Everything
 * downstream — the decider, the CLI — works purely against this.
 */
export interface ResolvedTestConfig {
  /** Absolute path to the project root the paths below are anchored at. */
  rootDir: string;
  /**
   * Independently-resolved projects, each with its own test files, sentinels,
   * and resolver options. Single-project runners supply one entry.
   */
  projects: ResolvedTestProjectConfig[];
}

/** Outcome of running a runner. */
export interface RunResult {
  /** Whether the underlying runner reported success. */
  success: boolean;
}

/**
 * Adapter for a concrete test runner, such as Jest or Vitest.
 *
 * The two responsibilities are deliberately split: `loadConfig` discovers
 * configuration (no tests run) and feeds the decider, while `run`/`runAll`
 * actually invoke the runner once a decision has been made.
 */
export interface TestRunner {
  /** Infer the {@link ResolvedTestConfig} from the runner's own config. */
  loadConfig(): Promise<ResolvedTestConfig>;
  /** Run only the given test files. `passthrough` is forwarded to the runner. */
  run(testFiles: string[], passthrough?: string[]): Promise<RunResult>;
  /** Run the whole suite. `passthrough` is forwarded to the runner. */
  runAll(passthrough?: string[]): Promise<RunResult>;
}

/**
 * The decision the decider reaches. Pure data — it does not run anything.
 *
 * - `none`: no tests are affected; run nothing.
 * - `run-selected`: run exactly the nonempty list of `testFiles`.
 * - `run-all`: run the whole suite because of a full-suite trigger or incomplete
 *   analysis. `reason` explains why.
 */
export type Decision =
  | { kind: 'none' }
  | { kind: 'run-selected'; testFiles: [string, ...string[]] }
  | { kind: 'run-all'; reason: string };
