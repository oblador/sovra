const { add } = require('../src/math');

test('add', () => {
  expect(add(1, 2)).toBe(3);
});
