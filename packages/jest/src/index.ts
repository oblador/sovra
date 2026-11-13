export { JestRunner } from './runner';
export type { JestRunnerOptions } from './runner';

// Re-export the runner-agnostic core so consumers can drive everything from a
// single import (e.g. `import { decideAffected, JestRunner } from '@sovra/jest'`).
export * from '@sovra/core';
