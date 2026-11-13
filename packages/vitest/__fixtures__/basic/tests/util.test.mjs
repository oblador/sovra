import { expect, test } from 'vitest';
import { upper } from '../src/util.mjs';

test('uppercases strings', () => expect(upper('hello')).toBe('HELLO'));
