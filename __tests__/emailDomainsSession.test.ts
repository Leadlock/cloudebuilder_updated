/**
 * ALLOWED_EMAIL_DOMAINS and sessions: someone who is already signed in with another domain is signed out as soon as the restriction is set.
 */
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: {} }));

import { AuthService } from '@/lib/api/authService';

const OLD = process.env['ALLOWED_EMAIL_DOMAINS'];
afterEach(() => { if (OLD === undefined) delete process.env['ALLOWED_EMAIL_DOMAINS']; else process.env['ALLOWED_EMAIL_DOMAINS'] = OLD; });

const user = { id: 'u1', email: 'x@gmail.com', name: 'X', role: 'user', orgId: 'o1' } as never;

test('a session of another domain stops working when the restriction is set, and works again when it is removed', () => {
  delete process.env['ALLOWED_EMAIL_DOMAINS'];
  const { token } = AuthService.createSession(user);
  expect(AuthService.getSession(token)).not.toBeNull();
  process.env['ALLOWED_EMAIL_DOMAINS'] = 'neozaar.com';
  expect(AuthService.getSession(token)).toBeNull();
  delete process.env['ALLOWED_EMAIL_DOMAINS'];
  expect(AuthService.getSession(token)).not.toBeNull();
});

test('a session of the allowed domain keeps working', () => {
  process.env['ALLOWED_EMAIL_DOMAINS'] = 'neozaar.com';
  const { token } = AuthService.createSession({ ...(user as object), email: 'a@neozaar.com' } as never);
  expect(AuthService.getSession(token)).not.toBeNull();
});
