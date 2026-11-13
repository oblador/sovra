import { expect, test } from 'vitest';
import { value } from '@/value.mjs';
test('project a resolves its alias', () => expect(value).toBe('a'));
