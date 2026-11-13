import { mergeConfig } from 'vitest/config';
import base from './vitest.config.mjs';

export default mergeConfig(base, { test: { dir: 'tests', include: ['*.test.mjs'] } });
