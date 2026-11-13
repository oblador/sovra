import { expect, test } from 'vitest';
import { value } from '@/value.mjs';
test('project b resolves its alias', () => expect(value).toBe('b'));
