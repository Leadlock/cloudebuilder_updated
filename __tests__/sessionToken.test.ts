/**
 * Tests for lib/crypto/sessionToken.ts — the stateless session token that
 * replaced the old in-memory Map-backed session store (see
 * lib/api/authService.ts). This is the entire trust boundary for "is this
 * request logged in," so it's tested directly rather than only indirectly
 * through the auth routes.
 */
process.env['SESSION_SECRET'] = 'a-test-secret-that-is-at-least-32-chars-long';

import { encodeSessionToken, decodeSessionToken } from '@/lib/crypto/sessionToken';

describe('sessionToken — encode/decode roundtrip', () => {
  it('decodes exactly what was encoded', () => {
    const payload = { sub: 'user-1', email: 'a@b.com', role: 'admin', exp: Date.now() + 60_000 };
    const token = encodeSessionToken(payload);
    const decoded = decodeSessionToken<typeof payload>(token);
    expect(decoded).toEqual(payload);
  });

  it('produces a two-part, dot-separated, base64url token', () => {
    const token = encodeSessionToken({ sub: 'x' });
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('sessionToken — tamper detection', () => {
  it('rejects a token whose payload was modified without re-signing', () => {
    const token = encodeSessionToken({ sub: 'user-1', role: 'user' });
    const [body, signature] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'user-1', role: 'admin' }), 'utf8').toString('base64url');
    const tampered = `${tamperedPayload}.${signature}`;
    expect(decodeSessionToken(tampered)).toBeNull();
  });

  it('rejects a token with a valid shape but wrong signature', () => {
    const token = encodeSessionToken({ sub: 'user-1' });
    const [body] = token.split('.');
    const forged = `${body}.${Buffer.from('not-the-real-signature').toString('base64url')}`;
    expect(decodeSessionToken(forged)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = encodeSessionToken({ sub: 'user-1' });
    const original = process.env['SESSION_SECRET'];
    process.env['SESSION_SECRET'] = 'a-completely-different-secret-value-here-32chars';
    expect(decodeSessionToken(token)).toBeNull();
    process.env['SESSION_SECRET'] = original;
  });
});

describe('sessionToken — malformed input never throws', () => {
  it.each([
    '',
    'not-a-token',
    'only.one.dot.too.many',
    'validlookingbody.',
    '.validlookingsignature',
    'a'.repeat(10000), // no dot at all
  ])('returns null (not a throw) for %j', (input) => {
    expect(() => decodeSessionToken(input)).not.toThrow();
    expect(decodeSessionToken(input)).toBeNull();
  });

  it('returns null for a syntactically valid signature over non-JSON body', () => {
    // Manually construct a token whose body isn't valid JSON, signed correctly,
    // to ensure the JSON.parse failure path returns null rather than throwing.
    const { createHmac } = require('crypto') as typeof import('crypto');
    const body = Buffer.from('not json at all {{{', 'utf8').toString('base64url');
    const signature = createHmac('sha256', process.env['SESSION_SECRET']!).update(body).digest('base64url');
    expect(decodeSessionToken(`${body}.${signature}`)).toBeNull();
  });
});

describe('sessionToken — missing/weak secret refuses to operate', () => {
  it('throws when SESSION_SECRET is unset', () => {
    const original = process.env['SESSION_SECRET'];
    delete process.env['SESSION_SECRET'];
    expect(() => encodeSessionToken({ sub: 'x' })).toThrow(/SESSION_SECRET/);
    process.env['SESSION_SECRET'] = original;
  });

  it('throws when SESSION_SECRET is too short', () => {
    const original = process.env['SESSION_SECRET'];
    process.env['SESSION_SECRET'] = 'too-short';
    expect(() => encodeSessionToken({ sub: 'x' })).toThrow(/SESSION_SECRET/);
    process.env['SESSION_SECRET'] = original;
  });
});
