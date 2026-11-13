import path from 'node:path';

import { matchRunAllOn, validateRunAllOn } from './run-all-on';
import type {
  Decision,
  ResolvedTestConfig,
  RunResult,
  TestRunner,
} from './types';

export interface DecideOptions {
  /** Already-resolved test files, sentinels, and resolver settings. */
  config: ResolvedTestConfig;
  /** Changed paths, absolute or relative to cwd (default: config.rootDir). */
  changedFiles: string[];
  /** Changed importable package names, without an `npm:` prefix. */
  changedDependencies?: string[];
  /** Extra full-suite triggers: file paths/globs and npm: dependency entries. */
  runAllOn?: string[];
  cwd?: string;
  /** Reports analysis errors; omitting the reporter does not disable fallback. */
  onError?: (error: string) => void;
}

/**
 * Select tests from explicit change data and resolved configuration. Reads the
 * source import graph, but never invokes Git, loads runner config, or runs tests.
 */
export function decideAffected(opts: DecideOptions): Decision {
  const { config, changedFiles, changedDependencies: changedDeps = [] } = opts;
  const cwd = path.resolve(opts.cwd ?? config.rootDir);
  const runAllOn = opts.runAllOn ?? [];
  validateRunAllOn(runAllOn);
  if (changedFiles.length === 0 && changedDeps.length === 0) {
    return { kind: 'none' };
  }

  // sovra compares against resolved import targets, which are absolute (roots
  // is the absolute rootDir). Make the changed files absolute to match, and
  // keep a set for the "directly changed sentinel" check below.
  const changedAbs = changedFiles.map((file) => path.resolve(cwd, file));
  const runAllReason = matchRunAllOn(runAllOn, cwd, changedAbs, changedDeps);
  if (runAllReason) return { kind: 'run-all', reason: runAllReason };
  const changedAbsSet = new Set(changedAbs);
  const changes = [
    ...new Set([
      ...changedDeps.map((name) => `npm:${name}`),
      ...changedAbs,
    ]),
  ];

  const { projects } = config;
  // A directly-changed sentinel never reaches sovra's affected set (it has no
  // importing test among `testFiles`), so check every project explicitly.
  const directlyChangedSentinel = projects.flatMap((project) => project.sentinelFiles)
    .find((file) => changedAbsSet.has(file));
  if (directlyChangedSentinel) {
    return {
      kind: 'run-all',
      reason: `${directlyChangedSentinel} changed`,
    };
  }

  const selected = new Set<string>();
  // Lockfile-only consumers do not need to load the native source analyzer.
  const { getAffected } = require('sovra') as typeof import('sovra');

  for (const project of projects) {
    const sentinelSet = new Set(project.sentinelFiles);
    const result = getAffected(
      [...new Set([...project.testFiles, ...sentinelSet])],
      changes,
      project.resolveOptions,
      project.ignoreTypeImports,
      project.requireAliases,
    );

    // An unresolved bare import can be an internal alias, and a dynamic require
    // can hide a changed dependency. Neither is safe to discard as "noise".
    if (result.errors.length > 0) {
      for (const error of new Set(result.errors)) opts.onError?.(error);
      return { kind: 'run-all', reason: 'Source dependency analysis was incomplete' };
    }

    const affectedSentinel = result.files.find((file) => sentinelSet.has(file));
    if (affectedSentinel) {
      return { kind: 'run-all', reason: `${affectedSentinel} is affected` };
    }

    for (const file of result.files) {
      if (!sentinelSet.has(file)) selected.add(file);
    }
  }

  const [first, ...rest] = selected;
  return first === undefined
    ? { kind: 'none' }
    : { kind: 'run-selected', testFiles: [first, ...rest] };
}

export interface RunAffectedOptions extends Omit<DecideOptions, 'config'> {
  runner: TestRunner;
  /** Extra args forwarded to the runner (e.g. `--ci --coverage`). */
  passthrough?: string[];
}

/** Decide, then dispatch to the runner. Returns the run result + decision. */
export async function runAffected(
  opts: RunAffectedOptions,
): Promise<RunResult & { decision: Decision }> {
  const decision = decideAffected({ ...opts, config: await opts.runner.loadConfig() });
  const passthrough = opts.passthrough ?? [];

  switch (decision.kind) {
    case 'none':
      return { success: true, decision };
    case 'run-all':
      return { ...(await opts.runner.runAll(passthrough)), decision };
    case 'run-selected':
      return {
        ...(await opts.runner.run(decision.testFiles, passthrough)),
        decision,
      };
  }
}
