const { noop } = require('../src/util');

test('noop', () => {
  expect(noop()).toBeUndefined();
});
