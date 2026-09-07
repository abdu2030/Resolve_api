const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  collectCoverage: false,
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['**/*.integration.ts'],
  testTimeout: 120_000,
};
