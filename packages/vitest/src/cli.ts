#!/usr/bin/env node
import { cli } from '@sovra/core';
import { VitestRunner } from './runner';

cli(process.argv.slice(2), {
  name: 'sovra-vitest',
  runner: 'vitest',
  createRunner: (options) => new VitestRunner(options),
}).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : error}\n`);
    process.exit(1);
  },
);
