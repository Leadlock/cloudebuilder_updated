import fs from 'fs';

// On Windows, ensure Git tools (bash, grep) are in PATH so shell verification tests pass seamlessly
if (process.platform === 'win32') {
  const gitPaths = [
    'C:\\Program Files\\Git\\usr\\bin',
    'C:\\Program Files\\Git\\bin',
  ];
  for (const gp of gitPaths) {
    if (fs.existsSync(gp) && !process.env.PATH?.includes(gp)) {
      process.env.PATH = `${gp};${process.env.PATH ?? ''}`;
    }
  }
}

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
    '^.+\\.[tj]sx?$': ['ts-jest', {
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
