import { expectTypeOf, test } from 'vitest';
import type { User } from './user';

test('user IDs are strings', () => {
  expectTypeOf<User['id']>().toBeString();
});
