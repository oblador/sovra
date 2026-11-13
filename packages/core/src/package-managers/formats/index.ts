import type { LockfileFormat } from './types';
import { npmFormat } from './npm';
import { pnpmFormat } from './pnpm';
import { yarnBerryFormat } from './yarn-berry';
import { yarnClassicFormat } from './yarn-classic';

export type { LockfileFormat, ParseInput } from './types';
export { npmFormat, pnpmFormat, yarnBerryFormat, yarnClassicFormat };

/** Lockfile filenames we recognize, in resolution-priority order. */
export const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
] as const;

/**
 * Pick the parser for a lockfile by filename, disambiguating yarn classic vs
 * berry from the file contents (`__metadata` marks a Berry lockfile).
 */
export function detectFormat(
  lockfileName: string,
  contents: string,
): LockfileFormat | undefined {
  switch (lockfileName) {
    case 'pnpm-lock.yaml':
      return pnpmFormat;
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return npmFormat;
    case 'yarn.lock':
      return /(^|\n)__metadata:/.test(contents) ? yarnBerryFormat : yarnClassicFormat;
    default:
      return undefined;
  }
}
