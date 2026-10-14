/**
 * ALLOWED_EMAIL_DOMAINS on the sign-in routes: another domain is refused before the sign-in service is touched.
 */
const mockCognito = { signIn: jest.fn(), signUp: jest.fn(), confirmSignUp: jest.fn(), confirmForgotPassword: jest.fn(), forgotPassword: jest.fn(), resendConfirmationCode: jest.fn() };
jest.mock('@/lib/auth/cognitoService', () => ({ ...jest.requireActual('@/lib/auth/cognitoService'), CognitoService: mockCognito }));
jest.mock('@/lib/api/authService', () => ({ AuthService: { syncCognitoUser: jest.fn(), createSession: jest.fn(), authenticate: jest.fn() } }));
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: {} }));
jest.mock('@/lib/api/authRateLimit', () => ({ limitAuthAttempt: async () => null, loginLocked: async () => null, clearLoginFailures: async () => undefined, recordLoginFailure: async () => undefined }));

import { NextRequest } from 'next/server';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as signup } from '@/app/api/auth/signup/route';
import { POST as confirm } from '@/app/api/auth/confirm/route';
import { POST as resetPassword } from '@/app/api/auth/reset-password/route';
import { POST as forgotPassword } from '@/app/api/auth/forgot-password/route';
import { POST as resendCode } from '@/app/api/auth/resend-code/route';

const OLD = process.env['ALLOWED_EMAIL_DOMAINS'];
beforeEach(() => { process.env['ALLOWED_EMAIL_DOMAINS'] = 'neozaar.com'; Object.values(mockCognito).forEach((f) => f.mockReset()); });
afterAll(() => { if (OLD === undefined) delete process.env['ALLOWED_EMAIL_DOMAINS']; else process.env['ALLOWED_EMAIL_DOMAINS'] = OLD; });

const post = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const calls = () => Object.values(mockCognito).reduce((n, f) => n + f.mock.calls.length, 0);

describe('another domain', () => {
  test.each([
    ['login', login, '/api/auth/login', { email: 'x@gmail.com', password: 'Passw0rd!long' }],
    ['signup', signup, '/api/auth/signup', { email: 'x@gmail.com', password: 'Passw0rd!long', name: 'X', orgName: 'Org' }],
    ['confirm', confirm, '/api/auth/confirm', { email: 'x@gmail.com', code: '123456' }],
    ['reset-password', resetPassword, '/api/auth/reset-password', { email: 'x@gmail.com', code: '123456', newPassword: 'Passw0rd!long' }],
  ])('%s is refused with 403 and the sign-in service is never called', async (_n, handler, path, body) => {
    const res = await handler(post(path, body));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain('@neozaar.com');
    expect(calls()).toBe(0);
  });

  test.each([
    ['forgot-password', forgotPassword, '/api/auth/forgot-password'],
    ['resend-code', resendCode, '/api/auth/resend-code'],
  ])('%s answers like any other address and sends nothing', async (_n, handler, path) => {
    const res = await handler(post(path, { email: 'x@gmail.com' }));
    expect(res.status).toBe(200);
    expect(calls()).toBe(0);
  });
});

describe('the allowed domain', () => {
  test('is passed on to the sign-in service as before', async () => {
    mockCognito.signIn.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'NotAuthorizedException' }));
    const res = await login(post('/api/auth/login', { email: 'a@neozaar.com', password: 'Passw0rd!long' }));
    expect(res.status).not.toBe(403);
    expect(mockCognito.signIn).toHaveBeenCalledTimes(1);
  });

  test('with no restriction another domain is not refused', async () => {
    delete process.env['ALLOWED_EMAIL_DOMAINS'];
    mockCognito.signIn.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'NotAuthorizedException' }));
    const res = await login(post('/api/auth/login', { email: 'x@gmail.com', password: 'Passw0rd!long' }));
    expect(res.status).not.toBe(403);
  });
});
