/**
 * Test setup: configure environment variables and mock the DB client.
 */

// Set test environment variables before any module import
// NODE_ENV is read-only in strict TS; set via env in jest config
process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/cloudcraft_test';

// Allow the x-user-id / x-user-role test-automation identity headers that
// lib/api/auth.ts's extractIdentity() otherwise refuses outside this opt-in —
// this test suite is exactly that sanctioned automation consumer.
process.env['CLOUDCRAFT_ALLOW_TEST_AUTH_HEADERS'] = '1';
