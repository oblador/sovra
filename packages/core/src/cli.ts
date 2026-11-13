import { decideAffected } from './decide';
import { prepareChanges } from './changes';
import { resolveCliOptions } from './cli-options';
import type { AnalysisOptions, Decision, TestRunner } from './types';

/** Builds the runner with resolved paths and project-owned analysis overrides. */
export type RunnerFactory = (opts: AnalysisOptions & {
  rootDir: string;
  configPath?: string;
}) => TestRunner;

export interface CliOptions {
  /** Program name shown in usage, e.g. `sovra-jest`. */
  name: string;
  /** Word for the runner in help text, e.g. `jest`. Defaults to `the test runner`. */
  runner?: string;
  /** Constructs the {@link TestRunner} with resolved paths and analysis overrides. */
  createRunner: RunnerFactory;
}

function usage(name: string, runner: string): string {
  return `${name} — run only the ${runner} tests affected by a change

Usage:
  ${name} [options] [changed-file...] [-- <${runner} args>]

Change selection (first match wins):
  [changed-file...]        Explicit changeset as positional paths
  --changeset <file|->     Read newline-separated changeset from a file (- = stdin)
  --base <ref|range>       Diff against an explicit git ref or range
  (default)                Diff against merge-base origin/<default-branch> HEAD

Options:
  --default-branch <name>  Branch to diff against by default (default: main)
  --config <path>          Path to the ${runner} config file
  --sovra-config <path>    Sovra config (default: sovra.config.{ts,mts,cts,js,mjs,cjs} in root)
  --root <dir>             Project root (default: cwd)
  --analyze-lockfile       Infer changed dependencies from lockfile changes (default: enabled)
  --no-analyze-lockfile    Disable automatic lockfile analysis
  --list, --dry-run        Print the decision (exit 254 when the full suite is required)
  -h, --help               Show this help

CLI options override Sovra config defaults.
Explicit npm:<package> changeset entries replace automatic dependency analysis.
String options accept both --option value and --option=value.
Anything after \`--\` is forwarded verbatim to ${runner}.`;
}

/**
 * Generic affected-tests CLI, reusable across runners. A runner package wires
 * its bin to this by supplying {@link CliOptions.createRunner}; everything else
 * (change selection, lockfile dependency analysis, run-all fallback, exit code)
 * is runner-agnostic. Returns the process exit code.
 */
export async function cli(argv: string[], options: CliOptions): Promise<number> {
  const runnerName = options.runner ?? 'the test runner';
  const args = await resolveCliOptions(argv);
  if (args.help) {
    process.stdout.write(`${usage(options.name, runnerName)}\n`);
    return 0;
  }

  const { cwd } = args;
  const runnerOptions = {
    rootDir: cwd,
    configPath: args.configPath,
    ignoreTypeImports: args.ignoreTypeImports,
    requireAliases: args.requireAliases,
    resolveOptions: args.resolveOptions,
  };
  const onError = (error: string) => process.stderr.write(`${error}\n`);
  const changes = await prepareChanges(args);
  let runner: TestRunner | undefined;
  let decision: Decision;
  if (changes.runAllReason) {
    decision = { kind: 'run-all', reason: changes.runAllReason };
  } else if (changes.changedFiles.length === 0 && changes.changedDependencies.length === 0) {
    // No discovery or project dependencies are needed for an empty changeset.
    decision = { kind: 'none' };
  } else {
    runner = options.createRunner(runnerOptions);
    const config = await runner.loadConfig();
    decision = decideAffected({
      config,
      cwd,
      runAllOn: args.runAllOn,
      changedFiles: changes.changedFiles,
      changedDependencies: changes.changedDependencies,
      onError,
    });
  }

  if (args.list) {
    switch (decision.kind) {
      case 'none':
        process.stderr.write('No affected tests.\n');
        return 0;
      case 'run-all':
        process.stderr.write(`Run all: ${decision.reason}\n`);
        // Empty stdout must not look like a successful "no affected tests"
        // selection to scripts consuming this command's output.
        return 254;
      case 'run-selected':
        for (const file of decision.testFiles) process.stdout.write(`${file}\n`);
        return 0;
    }
  }

  if (decision.kind === 'none') {
    process.stderr.write('No affected tests.\n');
    return 0;
  }
  if (decision.kind === 'run-all') {
    process.stderr.write(`Running full suite: ${decision.reason}\n`);
  }
  runner ??= options.createRunner(runnerOptions);
  const { success } = decision.kind === 'run-all'
    ? await runner.runAll(args.passthrough)
    : await runner.run(decision.testFiles, args.passthrough);
  return success ? 0 : 1;
}
