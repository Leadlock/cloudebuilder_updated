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
  testMatch: ['**/__tests__/**/*.test.{ts,tsx}'],
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
        // Lets a test render a React component to HTML (react-dom/server) — still no DOM, no browser.
        jsx: 'react-jsx',
      },
    }],
  },
  // Deterministic suite (unit + integration). Live verification tests need external
  // connectivity/credentials and run only via `npm run test:live` (jest.live.config.mjs).
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/__tests__/live/'],
  setupFiles: ['<rootDir>/__tests__/setup.ts'],
  // uuid v14 is ESM-only; transform it through ts-jest
  transformIgnorePatterns: [
    '/node_modules/(?!(uuid)/)',
  ],
};

export default config;
