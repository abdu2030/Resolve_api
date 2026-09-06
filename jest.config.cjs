module.exports = {
  clearMocks: true,
  collectCoverageFrom: [
    'apps/*/src/**/*.ts',
    'packages/*/src/**/*.ts',
    '!**/main.ts',
    '!**/index.ts',
    '!**/generated/**',
  ],
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@resolve/config$': '<rootDir>/packages/config/src/index.ts',
    '^@resolve/contracts$': '<rootDir>/packages/contracts/src/index.ts',
    '^@resolve/database$': '<rootDir>/packages/database/src/index.ts',
  },
  roots: ['<rootDir>/apps', '<rootDir>/packages', '<rootDir>/tests'],
  testEnvironment: 'node',
  testMatch: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.base.json',
        useESM: true,
      },
    ],
  },
};
