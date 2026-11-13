import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { include } from './config-helper.mjs';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include,
    setupFiles: ['./setup.mjs'],
    globalSetup: ['./global-setup.mjs'],
    maxWorkers: 1,
  },
});
