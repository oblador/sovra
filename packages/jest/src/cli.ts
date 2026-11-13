#!/usr/bin/env node
import { cli } from '@sovra/core';

import { JestRunner } from './runner';

cli(process.argv.slice(2), {
  name: 'sovra-jest',
  runner: 'jest',
  createRunner: (options) => new JestRunner(options),
}).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `${err instanceof Error ? err.stack ?? err.message : err}\n`,
    );
    process.exit(1);
  },
);
