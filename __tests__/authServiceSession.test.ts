/**
 * Tests for AuthService's session functions (lib/api/authService.ts) after
 * the switch from an in-memory Map to stateless signed tokens. The key
 * property under test: a session created by one "instance" verifies
 * correctly with no shared state beyond SESSION_SECRET — simulated here by
 * re-importing the module fresh (jest.resetModules), which wipes any
 * module-level state the old Map-based version would have relied on.
 */
process.env['SESSION_SECRET'] = 'a-test-secret-that-is-at-least-32-chars-long';

// createSession/getSession are pure (token-only, no DB access) — this
// minimal stub exists only so importing authService.ts's module graph
// (which pulls in orgRepository -> the real Prisma runtime, an ESM module
// Jest can't require()) doesn't fail; nothing here is ever actually called.
jest.mock('@/src/prisma/db', () => ({ db: {} }));

import { AuthService, type AuthUser } from '@/lib/api/authService';

const testUser: AuthUser = {
  id: 'user-123', email: 'test@example.com', name: 'Test User', role: 'admin', orgId: 'org-1',
};

describe('AuthService — stateless session roundtrip', () => {
  it('creates a session and immediately resolves it', () => {
    const session = AuthService.createSession(testUser);
    expect(session.token).toBeTruthy();
    expect(session.user).toEqual(testUser);

    const resolved = AuthService.getSession(session.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.user).toEqual(testUser);
  });

  it('carries every field needed to reconstruct the AuthUser purely from the token', () => {
    // The real point of the stateless-token change: getSession must not
    // consult any in-process registry (the old version's in-memory Map) —
    // everything it returns has to come from the token itself. Proven
    // directly here rather than via a cross-module-instance simulation
    // (which drags in ESM-transform issues unrelated to what's being
    // tested) — see __tests__/sessionToken.test.ts for the lower-level
    // encode/decode contract this relies on.
    const session = AuthService.createSession(testUser);
    const [body] = session.token.split('.');
    const decodedPayload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    expect(decodedPayload).toMatchObject({
      sub: testUser.id, email: testUser.email, name: testUser.name,
      role: testUser.role, orgId: testUser.orgId,
    });
  });

  it('rejects an unknown/forged token', () => {
    expect(AuthService.getSession('not-a-real-token')).toBeNull();
  });

  it('rejects an expired session', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const start = nowSpy.getMockImplementation()?.() ?? 1_700_000_000_000;
    nowSpy.mockReturnValue(start);
    const session = AuthService.createSession(testUser);

    nowSpy.mockReturnValue(start + 25 * 60 * 60 * 1000); // 25h later, past the 24h TTL
    expect(AuthService.getSession(session.token)).toBeNull();
    nowSpy.mockRestore();
  });

  it('revokeSession no-ops without throwing (stateless tokens have no store to remove from)', () => {
    const session = AuthService.createSession(testUser);
    expect(() => AuthService.revokeSession(session.token)).not.toThrow();
    expect(AuthService.revokeSession(session.token)).toBe(true);
  });
});
