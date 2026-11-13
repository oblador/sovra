const { add } = require('lib/math');

test('moduleNameMapper fallback alias', () => {
  expect(add(1, 2)).toBe(3);
});
