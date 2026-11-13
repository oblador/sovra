import { expect, test } from 'vitest';
import { add } from '@/math.mjs';

test('adds numbers', () => {
  expect(add(2, 3)).toBe(5);
  expect(globalThis.sovraSetupReady).toBe(true);
});
