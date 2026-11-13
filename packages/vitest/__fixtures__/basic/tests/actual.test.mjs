import { expect, test, vi } from 'vitest';

test('loads the actual math module', async () => {
  const { add } = await vi.importActual('../src/math.mjs');
  expect(add(1, 2)).toBe(3);
});
