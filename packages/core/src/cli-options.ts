import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadSovraConfig, type SovraConfig } from './config';

interface ResolvedCliOptions extends SovraConfig {
  help: false;
  cwd: string;
  configPath?: string;
  defaultBranch: string;
  analyzeLockfile: boolean;
  runAllOn: string[];
  changedFiles?: string[];
  changedDependencies?: string[];
  list: boolean;
  passthrough: string[];
}

/** The CLI's single options boundary: arguments > project config > defaults. */
export async function resolveCliOptions(argv: string[]): Promise<ResolvedCliOptions | { help: true }> {
  const separator = argv.indexOf('--');
  const { values, positionals } = parseArgs({
    args: separator === -1 ? argv : argv.slice(0, separator),
    strict: true,
    allowPositionals: true,
    allowNegative: true,
    options: {
      changeset: { type: 'string' },
      base: { type: 'string' },
      'default-branch': { type: 'string' },
      config: { type: 'string' },
      'sovra-config': { type: 'string' },
      root: { type: 'string' },
      'analyze-lockfile': { type: 'boolean' },
      list: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  // Help must work without loading a project, its config, or stdin.
  if (values.help) return { help: true };

  const cwd = realpathSync(path.resolve(values.root ?? process.cwd()));
  const loaded = await loadSovraConfig({ rootDir: cwd, configPath: values['sovra-config'] });
  const settings: SovraConfig & { defaultBranch: string; analyzeLockfile: boolean; runAllOn: string[] } = {
    defaultBranch: 'main', analyzeLockfile: true, runAllOn: [],
  };
  for (const layer of [loaded.config, {
    base: values.base, defaultBranch: values['default-branch'], analyzeLockfile: values['analyze-lockfile'],
  }]) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) Object.assign(settings, { [key]: value });
    }
  }

  let changeset: string[] | undefined;
  if (positionals.length) changeset = positionals;
  else if (values.changeset) {
    changeset = readFileSync(values.changeset === '-' ? 0 : values.changeset, 'utf8')
      .split('\n').map((line) => line.trim()).filter(Boolean);
  }
  const changedDependencies = (changeset ?? [])
    .filter((entry) => entry.startsWith('npm:')).map((entry) => entry.slice(4));
  if (changedDependencies.some((name) => !name.trim())) {
    throw new Error('npm: changeset entries require a dependency name');
  }
  return {
    ...settings,
    help: false,
    cwd,
    configPath: values.config,
    changedFiles: changeset?.filter((entry) => !entry.startsWith('npm:')),
    changedDependencies: changedDependencies.length ? changedDependencies : undefined,
    list: values.list === true || values['dry-run'] === true,
    passthrough: separator === -1 ? [] : argv.slice(separator + 1),
  };
}
