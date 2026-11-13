import { test } from 'node:test';
import { assertNoInstall } from '../../../test/helpers/no-install.mjs';

test('empty Git and file changesets do not need a project install', async (t) => {
  await assertNoInstall(t, 'jest', new URL('../dist/cli.js', import.meta.url));
});
