import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { 'root-helper': fileURLToPath(new URL('./global-helper.mjs', import.meta.url)) } },
  test: {
    maxWorkers: 1,
    globalSetup: ['./global-setup.mjs'],
    projects: ['a', 'b'].map((name) => ({
      root: fileURLToPath(new URL(`./${name}`, import.meta.url)),
      resolve: { alias: { '@': fileURLToPath(new URL(`./${name}/src`, import.meta.url)) } },
      test: { name, include: ['tests/*.test.mjs'] },
    })),
  },
});
