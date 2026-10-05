/**
 * Unit tests for AWS Cognito MFA (Authenticator TOTP, SMS, Email OTP) and MFA challenge flows.
 */
const mockSignIn = jest.fn();
const mockRespondToMfaChallenge = jest.fn();
const mockAssociateSoftwareToken = jest.fn();
const mockVerifySoftwareToken = jest.fn();

jest.mock('@/lib/auth/cognitoService', () => ({
  ...jest.requireActual('@/lib/auth/cognitoService'),
  CognitoService: {
    signIn: (...args: unknown[]) => mockSignIn(...args),
    respondToMfaChallenge: (...args: unknown[]) => mockRespondToMfaChallenge(...args),
    associateSoftwareToken: (...args: unknown[]) => mockAssociateSoftwareToken(...args),
    verifySoftwareToken: (...args: unknown[]) => mockVerifySoftwareToken(...args),
  },
}));

const mockSync = jest.fn();
jest.mock('@/lib/api/authService', () => ({
  AuthService: {
    syncCognitoUser: (...args: unknown[]) => mockSync(...args),
    createSession: (user: { id: string }) => ({
      token: `session-${user.id}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
  },
}));

import { NextRequest } from 'next/server';
import { POST as loginPost } from '@/app/api/auth/login/route';
import { POST as mfaVerifyPost } from '@/app/api/auth/mfa/verify/route';
import { POST as mfaSetupPost } from '@/app/api/auth/mfa/setup/route';

describe('Cognito MFA Flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('login route returns requiresMfa: true when Cognito returns SOFTWARE_TOKEN_MFA challenge', async () => {
    mockSignIn.mockResolvedValueOnce({
      challenge: true,
      challengeName: 'SOFTWARE_TOKEN_MFA',
      session: 'sess-12345',
      challengeParameters: {},
      email: 'alex@example.com',
    });

    const req = new NextRequest('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alex@example.com', password: 'ValidPassword1!' }),
    });

    const res = await loginPost(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.requiresMfa).toBe(true);
    expect(body.challengeName).toBe('SOFTWARE_TOKEN_MFA');
    expect(body.session).toBe('sess-12345');
    expect(body.email).toBe('alex@example.com');
  });

  it('mfa/verify route completes authentication when valid OTP code is submitted', async () => {
    mockRespondToMfaChallenge.mockResolvedValueOnce({
      challenge: false,
      idToken: 'valid-id-token',
      accessToken: 'valid-access-token',
      sub: 'user-sub-123',
      email: 'alex@example.com',
      name: 'Alex Rivera',
    });

    mockSync.mockResolvedValueOnce({
      id: 'user-sub-123',
      email: 'alex@example.com',
      name: 'Alex Rivera',
      role: 'user',
      orgId: 'org-1',
    });

    const req = new NextRequest('http://localhost/api/auth/mfa/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'alex@example.com',
        session: 'sess-12345',
        challengeName: 'SOFTWARE_TOKEN_MFA',
        code: '123456',
      }),
    });

    const res = await mfaVerifyPost(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.user.email).toBe('alex@example.com');
    expect(res.cookies.get('cloudcraft_session')?.value).toBe('session-user-sub-123');
  });

  it('mfa/verify route returns 400 when invalid OTP code is entered (CodeMismatchException)', async () => {
    const err = new Error('Invalid code');
    (err as any).name = 'CodeMismatchException';
    mockRespondToMfaChallenge.mockRejectedValueOnce(err);

    const req = new NextRequest('http://localhost/api/auth/mfa/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'alex@example.com',
        session: 'sess-12345',
        challengeName: 'SOFTWARE_TOKEN_MFA',
        code: '000000',
      }),
    });

    const res = await mfaVerifyPost(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error?.message ?? body.error).toContain('Invalid verification code');
  });

  it('mfa/verify route completes authentication for MFA_SETUP challenge', async () => {
    mockRespondToMfaChallenge.mockResolvedValueOnce({
      challenge: false,
      idToken: 'valid-id-token-setup',
      accessToken: 'valid-access-token-setup',
      sub: 'user-sub-setup-123',
      email: 'alex@example.com',
      name: 'Alex Rivera',
    });

    mockSync.mockResolvedValueOnce({
      id: 'user-sub-setup-123',
      email: 'alex@example.com',
      name: 'Alex Rivera',
      role: 'user',
      orgId: 'org-1',
    });

    const req = new NextRequest('http://localhost/api/auth/mfa/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'alex@example.com',
        session: 'sess-setup-updated',
        challengeName: 'MFA_SETUP',
        code: '530736',
      }),
    });

    const res = await mfaVerifyPost(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.user.email).toBe('alex@example.com');
  });

  it('mfa/setup route returns software token secret key for enrollment', async () => {
    mockAssociateSoftwareToken.mockResolvedValueOnce({
      secretCode: 'JBSWY3DPEHPK3PXP',
      session: 'sess-updated-67890',
    });

    const req = new NextRequest('http://localhost/api/auth/mfa/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'sess-initial-123' }),
    });

    const res = await mfaSetupPost(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.secretCode).toBe('JBSWY3DPEHPK3PXP');
    expect(body.session).toBe('sess-updated-67890');
  });
});
