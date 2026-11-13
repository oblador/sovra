import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateRunAllOn } from './run-all-on';
import type { AnalysisOptions } from './types';

/** Project-owned defaults, shared by every runner adapter. */
export interface SovraConfig extends AnalysisOptions {
  /** Default remote branch, without `origin/`. Defaults to `main`. */
  defaultBranch?: string;
  /** Default Git comparison ref/range. Explicit change lists still take priority. */
  base?: string;
  /** Infer dependency changes from a changed lockfile. Defaults to true. */
  analyzeLockfile?: boolean;
  /**
   * Files/globs (relative to the project root) and `npm:` dependency entries
   * that require the full suite when they match a changed file or dependency.
   */
  runAllOn?: string[];
}

export interface LoadSovraConfigOptions {
  rootDir: string;
  /** Explicit config path, relative to rootDir or absolute. */
  configPath?: string;
}

export interface LoadedSovraConfig {
  config: SovraConfig;
  /** Absolute filename of the loaded config, when present. */
  configPath?: string;
}

const SOVRA_CONFIG_NAMES = [
  'sovra.config.ts', 'sovra.config.mts', 'sovra.config.cts',
  'sovra.config.js', 'sovra.config.mjs', 'sovra.config.cjs',
];
const CONFIG_KEYS = new Set([
  'defaultBranch', 'base', 'analyzeLockfile', 'runAllOn',
  'ignoreTypeImports', 'requireAliases', 'resolveOptions',
]);

function exists(file: string): boolean {
  try {
    if (!statSync(file).isFile()) throw new Error(`Expected a Sovra config file: ${file}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function validateConfig(value: unknown): SovraConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sovra config must export an object');
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`Unknown Sovra config option: ${key}`);
  }
  for (const key of ['defaultBranch', 'base']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key].trim())) {
      throw new Error(`Sovra config ${key} must be a non-empty string`);
    }
  }
  for (const key of ['analyzeLockfile', 'ignoreTypeImports']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') {
      throw new Error(`Sovra config ${key} must be a boolean`);
    }
  }
  if (config.requireAliases !== undefined && (!Array.isArray(config.requireAliases)
    || config.requireAliases.some((alias) => typeof alias !== 'string' || !/^[^\s.]+(?:\.[^\s.]+)?$/.test(alias)))) {
    throw new Error('Sovra config requireAliases must be an array of function names, e.g. loadModule or loader.require');
  }
  if (config.resolveOptions !== undefined && (config.resolveOptions === null
    || typeof config.resolveOptions !== 'object' || Array.isArray(config.resolveOptions))) {
    throw new Error('Sovra config resolveOptions must be an object');
  }
  if (config.runAllOn !== undefined) validateRunAllOn(config.runAllOn);
  return config as SovraConfig;
}

/**
 * Load one config at the selected project root, with no ancestor merging.
 * This is an explicit I/O boundary; decideAffected never loads configuration.
 * Uses Node's native module resolution, TypeScript support, and module cache.
 */
export async function loadSovraConfig(opts: LoadSovraConfigOptions): Promise<LoadedSovraConfig> {
  const rootDir = realpathSync(opts.rootDir);
  let configPath: string | undefined;
  if (opts.configPath !== undefined) {
    configPath = path.resolve(rootDir, opts.configPath);
    if (!exists(configPath)) throw new Error(`Sovra config not found: ${configPath}`);
  } else {
    const candidates = SOVRA_CONFIG_NAMES.map((name) => path.join(rootDir, name)).filter(exists);
    if (candidates.length > 1) {
      throw new Error(`Multiple Sovra configs found: ${candidates.join(', ')}. Select one with --sovra-config.`);
    }
    configPath = candidates[0];
  }
  if (!configPath) return { config: {} };

  try {
    const { default: config } = await import(pathToFileURL(configPath).href);
    return { config: validateConfig(config), configPath };
  } catch (error) {
    throw new Error(`Cannot load Sovra config ${configPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
