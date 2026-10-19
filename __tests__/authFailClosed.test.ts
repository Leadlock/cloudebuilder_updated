/**
 * Sign-up and sign-in must fail closed: a Cognito error never creates or accepts an unverified local account.
 */
const mockSignUp = jest.fn();
const mockSignIn = jest.fn();
jest.mock('@/lib/auth/cognitoService', () => ({
  ...jest.requireActual('@/lib/auth/cognitoService'),
  CognitoService: { signUp: (...a: unknown[]) => mockSignUp(...a), signIn: (...a: unknown[]) => mockSignIn(...a) },
}));

const mockAuthenticate = jest.fn();
const mockSync = jest.fn();
jest.mock('@/lib/api/authService', () => ({
  AuthService: {
    authenticate: (...a: unknown[]) => mockAuthenticate(...a),
    syncCognitoUser: (...a: unknown[]) => mockSync(...a),
    createSession: () => ({ token: 'tok', expiresAt: '2099-01-01T00:00:00.000Z' }),
    hashPassword: async () => 'hash',
  },
}));

const mockFindUser = jest.fn();
const mockCreateUser = jest.fn();
jest.mock('@/lib/repositories/orgRepository', () => ({
  orgRepository: {
    findUserByEmailForAuth: (...a: unknown[]) => mockFindUser(...a),
    createUserWithPassword: (...a: unknown[]) => mockCreateUser(...a),
    createOrgForSignup: async () => ({ id: 'org-1' }),
    addMember: async () => undefined,
  },
}));

import { NextRequest } from 'next/server';
import { POST as signupPost } from '@/app/api/auth/signup/route';
import { POST as loginPost } from '@/app/api/auth/login/route';
import { localLoginFallbackAllowed, localSignupAllowed, unverifiedTokenFallbackAllowed } from '@/lib/auth/localFallback';
import { readClaimsWithoutSignature } from '@/lib/auth/cognitoService';

const env = process.env as Record<string, string | undefined>;
const saved = { NODE_ENV: env.NODE_ENV, flag: env.CLOUDBUILDER_ALLOW_LOCAL_SIGNUP };
afterEach(() => { env.NODE_ENV = saved.NODE_ENV; if (saved.flag === undefined) delete env.CLOUDBUILDER_ALLOW_LOCAL_SIGNUP; else env.CLOUDBUILDER_ALLOW_LOCAL_SIGNUP = saved.flag; });
beforeEach(() => {
  [mockSignUp, mockSignIn, mockAuthenticate, mockSync, mockFindUser, mockCreateUser].forEach((m) => m.mockReset());
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

// Each call comes from its own address with its own email, so these tests exercise fail-closed behaviour, not the rate limits
// (those are covered in authRateLimit.test.ts).
let calls = 0;
const post = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.1.${Math.floor(++calls / 250)}.${calls % 250}` }, body: JSON.stringify(body) });
const signup = () => signupPost(post('/api/auth/signup', { email: `victim${calls}@example.com`, password: 'Str0ng!Passw0rd', name: 'Mallory', orgName: 'Evil Org' }));
const login = () => loginPost(post('/api/auth/login', { email: `a${calls}@example.com`, password: 'whatever1' }));
const cognitoError = (name: string, message = 'cognito says no') => Object.assign(new Error(message), { name });

describe('sign-up', () => {
  it.each(['ThrottlingException', 'TooManyRequestsException', 'InternalErrorException', 'NetworkingError', 'InvalidParameterException'])('a Cognito %s does NOT create an unverified local account', async (name) => {
    env.NODE_ENV = 'production';
    mockSignUp.mockRejectedValue(cognitoError(name));
    const res = await signup();
    expect(res.status).toBe(503);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockFindUser).not.toHaveBeenCalled();
    expect(JSON.stringify(await res.json())).not.toContain('cognito says no');   // service detail is not handed to the caller
  });

  it('still reports an existing account and a weak password normally', async () => {
    mockSignUp.mockRejectedValueOnce(cognitoError('UsernameExistsException'));
    expect((await signup()).status).toBe(409);
    mockSignUp.mockRejectedValueOnce(cognitoError('InvalidPasswordException', 'too short'));
    expect((await signup()).status).toBe(400);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('local sign-up exists only on a developer machine that asked for it', async () => {
    mockSignUp.mockRejectedValue(cognitoError('InternalErrorException'));
    mockFindUser.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({ id: 'u1', email: 'victim@example.com' });

    env.NODE_ENV = 'development'; delete env.CLOUDBUILDER_ALLOW_LOCAL_SIGNUP;
    expect((await signup()).status).toBe(503);                 // development alone is not enough
    env.NODE_ENV = 'production'; env.CLOUDBUILDER_ALLOW_LOCAL_SIGNUP = '1';
    expect((await signup()).status).toBe(503);                 // the flag alone is not enough
    expect(mockCreateUser).not.toHaveBeenCalled();

    env.NODE_ENV = 'development'; env.CLOUDBUILDER_ALLOW_LOCAL_SIGNUP = '1';
    expect((await signup()).status).toBe(200);                 // both, deliberately
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
  });
});

describe('sign-in', () => {
  it('tries a legacy local login only when Cognito does not know the user or the password is wrong', async () => {
    mockSignIn.mockRejectedValue(cognitoError('NotAuthorizedException'));
    mockAuthenticate.mockResolvedValue({ id: 'u1', email: 'a@example.com', name: 'A', role: 'user', orgId: 'org-1' });
    expect((await login()).status).toBe(200);
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);

    mockAuthenticate.mockReset(); mockAuthenticate.mockResolvedValue(null);
    mockSignIn.mockRejectedValue(cognitoError('UserNotFoundException'));
    expect((await login()).status).toBe(401);
  });

  it('never uses a local login because Cognito is down or throttling, and does not leak its message', async () => {
    for (const name of ['TooManyRequestsException', 'InternalErrorException', 'NetworkingError', 'ResourceNotFoundException']) {
      mockSignIn.mockRejectedValue(cognitoError(name, 'internal cognito detail'));
      mockAuthenticate.mockResolvedValue({ id: 'u1', email: 'a@example.com', name: 'A', role: 'admin', orgId: 'org-1' });
      const res = await login();
      expect(res.status).toBe(503);
      expect(JSON.stringify(await res.json())).not.toContain('internal cognito detail');
    }
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('still asks an unconfirmed user to verify their email', async () => {
    mockSignIn.mockRejectedValue(cognitoError('UserNotConfirmedException'));
    const body = await (await login()).json() as { requiresConfirmation?: boolean };
    expect(body.requiresConfirmation).toBe(true);
  });
});

describe('fallback rules', () => {
  it('localLoginFallbackAllowed', () => {
    expect(localLoginFallbackAllowed('UserNotFoundException')).toBe(true);
    expect(localLoginFallbackAllowed('NotAuthorizedException')).toBe(true);
    expect(localLoginFallbackAllowed('InternalErrorException')).toBe(false);
    expect(localLoginFallbackAllowed(undefined)).toBe(false);
  });
  it('localSignupAllowed / unverifiedTokenFallbackAllowed are development-only, and the second needs the dev-shortcuts flag', () => {
    const flag = env.CLOUDBUILDER_DEV_SHORTCUTS;
    try {
      env.CLOUDBUILDER_DEV_SHORTCUTS = '1';
      env.NODE_ENV = 'production'; env.CLOUDBUILDER_ALLOW_LOCAL_SIGNUP = '1';
      expect(localSignupAllowed()).toBe(false);
      expect(unverifiedTokenFallbackAllowed()).toBe(false);
      env.NODE_ENV = 'test';
      expect(unverifiedTokenFallbackAllowed()).toBe(false);
      env.NODE_ENV = 'development';
      expect(unverifiedTokenFallbackAllowed()).toBe(true);
      // `npm run dev` alone no longer accepts a token whose signature could not be checked
      delete env.CLOUDBUILDER_DEV_SHORTCUTS;
      expect(unverifiedTokenFallbackAllowed()).toBe(false);
    } finally {
      if (flag === undefined) delete env.CLOUDBUILDER_DEV_SHORTCUTS; else env.CLOUDBUILDER_DEV_SHORTCUTS = flag;
    }
  });
});

describe('readClaimsWithoutSignature (development fallback)', () => {
  const region = process.env.COGNITO_REGION || process.env.AWS_REGION || 'us-east-1';
  const pool = process.env.COGNITO_USER_POOL_ID || 'us-east-1_JWhzLoOFB';
  const client = process.env.COGNITO_CLIENT_ID || '3e9fj8jcghd5g1hp03kosmmtjv';
  const token = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const good = { iss: `https://cognito-idp.${region}.amazonaws.com/${pool}`, token_use: 'id', aud: client, exp: Math.floor(Date.now() / 1000) + 600, sub: 's', email: 'a@example.com' };

  it('accepts a token for this pool and client that has not expired', () => {
    expect(readClaimsWithoutSignature(token(good))).toMatchObject({ email: 'a@example.com' });
  });
  it('rejects another pool, another client, an access token, an expired token and garbage', () => {
    expect(readClaimsWithoutSignature(token({ ...good, iss: 'https://cognito-idp.us-east-1.amazonaws.com/other_pool' }))).toBeNull();
    expect(readClaimsWithoutSignature(token({ ...good, aud: 'someone-elses-client' }))).toBeNull();
    expect(readClaimsWithoutSignature(token({ ...good, token_use: 'access' }))).toBeNull();
    expect(readClaimsWithoutSignature(token({ ...good, exp: Math.floor(Date.now() / 1000) - 5 }))).toBeNull();
    expect(readClaimsWithoutSignature('not-a-jwt')).toBeNull();
    expect(readClaimsWithoutSignature('a.!!!.c')).toBeNull();
  });
});
