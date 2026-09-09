/**
 * Test setup: configure environment variables and mock the DB client.
 */

// Set test environment variables before any module import
// NODE_ENV is read-only in strict TS; set via env in jest config
process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/cloudcraft_test';
