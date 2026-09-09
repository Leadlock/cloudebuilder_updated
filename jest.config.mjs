/**
 * Jest configuration for CloudCraft backend tests.
 * Tests run in Node.js environment (no DOM).
 */
/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testEnvironmentOptions: {
    env: { NODE_ENV: 'test' },
  },
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        resolveJsonModule: true,
        strict: true,
        skipLibCheck: true,
        // Needed for import assertions
        target: 'ES2020',
      },
    }],
  },
  // Don't try to run front-end component tests in this suite
  testPathIgnorePatterns: ['/node_modules/'],
  setupFiles: ['<rootDir>/__tests__/setup.ts'],
  // uuid v14 is ESM-only; transform it through ts-jest
  transformIgnorePatterns: [
    '/node_modules/(?!(uuid)/)',
  ],
};

export default config;
