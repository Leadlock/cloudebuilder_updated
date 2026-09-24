/**
 * LIVE verification tests: real third-party APIs (pricing, FX). Not run by `npm test`.
 * The setup's network guard is disabled via CLOUDCRAFT_LIVE_TESTS=1.
 */
import base from './jest.config.mjs';

process.env.CLOUDCRAFT_LIVE_TESTS = '1';

/** @type {import('jest').Config} */
const config = {
  ...base,
  testMatch: ['**/__tests__/live/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
};

export default config;
