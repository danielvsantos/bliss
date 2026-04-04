module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  testMatch: ['**/*.test.js'],
  setupFiles: [
    '<rootDir>/src/__tests__/setup/env.js',   // loads .env.test before any module is required
    '<rootDir>/src/__tests__/setup/sentry.js', // mocks @sentry/node
  ],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',
    '!src/app.js',
    '!**/node_modules/**',
  ],
  coverageThreshold: {
    global: { branches: 60, functions: 70, lines: 70 },
  },
  verbose: true,
  moduleNameMapper: {
    '^p-limit$': '<rootDir>/src/__tests__/setup/p-limit-shim.js',
  },
};
