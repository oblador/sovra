module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/module-path-tests/**/*.test.js'],
  modulePaths: ['<rootDir>/src'],
  moduleNameMapper: {
    '^lib/(.*)$': ['<rootDir>/src/$1', '<rootDir>/fallback/$1'],
  },
};
