/**
 * Test setup: configure environment variables and mock the DB client.
 */

// Set test environment variables before any module import
// NODE_ENV is read-only in strict TS; set via env in jest config
process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/cloudcraft_test';

// Access limits a developer may have in their own .env (who can sign in, who can use Deploy and the AI Generator) must not change what the
// tests see. Set to empty rather than deleted: dotenv, loaded later, only fills variables that are not defined. Tests of these limits set
// their own values.
process.env['ALLOWED_EMAIL_DOMAINS'] = '';
process.env['RESTRICTED_FEATURES_ALLOWED_EMAILS'] = '';
process.env['SUPER_ADMIN_EMAILS'] = '';

// Allow the x-user-id / x-user-role test-automation identity headers that
// lib/api/auth.ts's extractIdentity() otherwise refuses outside this opt-in —
// this test suite is exactly that sanctioned automation consumer.
process.env['CLOUDCRAFT_ALLOW_TEST_AUTH_HEADERS'] = '1';

// A fixed (not random) test-only value: lib/crypto/sessionToken.ts refuses to
// sign/verify without one, and any future test that exercises a real
// login/signup route (rather than the x-user-id bypass above) would otherwise
// fail on missing config unrelated to what it's actually testing.
process.env['SESSION_SECRET'] = 'test-session-secret-not-for-real-use-0000000000000000';

// ─── Deterministic suite: no external network ────────────────────────────────
// Unit and integration tests must never depend on third-party APIs (pricing, FX,
// cloud providers). Any real outbound request fails loudly here, so a test that
// accidentally reaches the network is a failing test, not a flaky one. Tests
// that need HTTP replace global.fetch with a mock of the official response.
// Live verification tests live in __tests__/live and run via `npm run test:live`.
{
  const realFetch = globalThis.fetch;
  const guarded: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = (() => { try { return new URL(url, 'http://localhost').hostname; } catch { return ''; } })();
    if (process.env['CLOUDCRAFT_LIVE_TESTS'] === '1' || host === 'localhost' || host === '127.0.0.1') {
      return realFetch(input, init);
    }
    throw new Error(`[deterministic test suite] external network request blocked: ${url}. Mock fetch with an official response fixture, or move the test to __tests__/live.`);
  };
  globalThis.fetch = guarded;
}
