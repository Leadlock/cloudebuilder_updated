/**
 * Jest config for real PostgreSQL integration tests.
 * Uses the real .env DATABASE_URL — no mock DB.
 *
 * Runs in native ESM mode so that @prisma/orm-postgres (.mjs only) can load.
 * Run with:
 *   node --experimental-vm-modules node_modules/.bin/jest --config jest.integration.mjs
 */
/** @type {import('jest').Config} */
const config = {
  // ts-jest ESM preset
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  roots: ['<rootDir>/integration'],
  testMatch: ['**/integration/**/*.test.ts'],
  moduleNameMapper: {
    // Path alias
    '^@/(.*)$': '<rootDir>/$1',
    // ESM .js extension stripping for ts-jest ESM
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        esModuleInterop: true,
        resolveJsonModule: true,
        strict: true,
        skipLibCheck: true,
        target: 'ES2022',
        allowImportingTsExtensions: true,
        noEmit: true,
      },
    }],
  },
  // Do NOT transform node_modules — they ship as native ESM
  transformIgnorePatterns: ['/node_modules/'],
  testTimeout: 30_000,
};

export default config;
