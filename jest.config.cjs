/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    '<rootDir>/src/**/*.ts',
    '!<rootDir>/src/__tests__/**/*.ts',
    '!<rootDir>/src/types/**/*.ts',
    '!<rootDir>/src/utils/version.ts',  // Exclude version.ts from coverage
  ],
  collectCoverage: true,
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^(\\.{1,2}/.*)\\.json$': '$1.json'
  },
  extensionsToTreatAsEsm: ['.ts', '.mts'],
  transform: {
    '^.+\\.m?[tj]sx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: './tsconfig.json'
      }
    ]
  },
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
};
