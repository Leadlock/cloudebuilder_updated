/**
 * Tests for lib/api/rateLimit.ts's checkRateLimit — previously untested,
 * even though it's now relied on by four routes including the two added
 * this session (cost-comparison, currency/rates) to close the gap the
 * audit found: those two ran full external-API-calling operations with no
 * abuse protection while cost-estimates already had it.
 */
import { checkRateLimit } from '@/lib/api/rateLimit';

describe('checkRateLimit', () => {
  it('allows requests under the limit', () => {
    const key = `test-under-${Date.now()}`;
    const r1 = checkRateLimit(key, 3, 60_000);
    const r2 = checkRateLimit(key, 3, 60_000);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
  });

  it('blocks requests once the limit is reached, with a retryAfterSeconds hint', () => {
    const key = `test-blocked-${Date.now()}`;
    checkRateLimit(key, 2, 60_000);
    checkRateLimit(key, 2, 60_000);
    const blocked = checkRateLimit(key, 2, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets the window after windowMs elapses', async () => {
    const key = `test-reset-${Date.now()}`;
    checkRateLimit(key, 1, 50);
    const blocked = checkRateLimit(key, 1, 50);
    expect(blocked.allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 60));
    const afterReset = checkRateLimit(key, 1, 50);
    expect(afterReset.allowed).toBe(true);
  });

  it('tracks distinct keys independently (per-user, per-route isolation)', () => {
    const keyA = `test-iso-a-${Date.now()}`;
    const keyB = `test-iso-b-${Date.now()}`;
    checkRateLimit(keyA, 1, 60_000);
    const blockedA = checkRateLimit(keyA, 1, 60_000);
    const allowedB = checkRateLimit(keyB, 1, 60_000);
    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });
});
