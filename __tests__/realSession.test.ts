/** realSession: a real login or nothing. */
jest.mock('@/lib/api/authService', () => ({
  AuthService: { getSession: (t: string) => (t === 'good-token' ? { user: { id: 'u1', email: 'a@b.c', role: 'user' } } : t === 'no-user' ? { user: {} } : null) },
}));
import { NextRequest } from 'next/server';
import { realSession } from '@/lib/api/realSession';

const req = (headers: Record<string, string> = {}) => new NextRequest('http://localhost:3000/api/x', { headers });

describe('realSession', () => {
  it('accepts a known session cookie', () => {
    expect(realSession(req({ cookie: 'cloudbuilder_session=good-token' }))?.user.id).toBe('u1');
  });
  it('accepts a known bearer token', () => {
    expect(realSession(req({ authorization: 'Bearer good-token' }))?.user.id).toBe('u1');
    expect(realSession(req({ authorization: 'bearer good-token' }))?.user.id).toBe('u1');
  });
  it('returns null for no credentials, an unknown token, or a session with no user', () => {
    expect(realSession(req())).toBeNull();
    expect(realSession(req({ cookie: 'cloudbuilder_session=forged' }))).toBeNull();
    expect(realSession(req({ authorization: 'Bearer forged' }))).toBeNull();
    expect(realSession(req({ cookie: 'cloudbuilder_session=no-user' }))).toBeNull();
  });
  it('never trusts an identity header', () => {
    expect(realSession(req({ 'x-user-id': 'u1', 'x-user-role': 'admin' }))).toBeNull();
  });
  it('is the same in every environment', () => {
    const env = process.env as Record<string, string | undefined>;
    const before = env['NODE_ENV'];
    for (const mode of ['development', 'production', 'test']) {
      env['NODE_ENV'] = mode;
      expect(realSession(req())).toBeNull();
    }
    if (before === undefined) delete env['NODE_ENV']; else env['NODE_ENV'] = before;
  });
});
