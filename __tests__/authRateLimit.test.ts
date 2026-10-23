/**
 * Rate limits on the sign-in routes. The real limiter is used; each test uses its own client address so counters never
 * leak between tests.
 */
const mockSignIn = jest.fn();
const mockSignUp = jest.fn();
const mockResend = jest.fn();
const mockConfirm = jest.fn();
jest.mock('@/lib/auth/cognitoService', () => ({
  ...jest.requireActual('@/lib/auth/cognitoService'),
  CognitoService: {
    signIn: (...a: unknown[]) => mockSignIn(...a),
    signUp: (...a: unknown[]) => mockSignUp(...a),
    resendConfirmationCode: (...a: unknown[]) => mockResend(...a),
    confirmSignUp: (...a: unknown[]) => mockConfirm(...a),
  },
}));
jest.mock('@/lib/api/authService', () => ({
  AuthService: {
    authenticate: async () => null,
    syncCognitoUser: async () => ({ id: 'u1', email: 'a@example.com', name: 'A', role: 'user', orgId: 'org-1' }),
    createSession: () => ({ token: 'tok', expiresAt: '2099-01-01T00:00:00.000Z' }),
    hashPassword: async () => 'hash',
  },
}));
const mockFindInvite = jest.fn();
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: { findInviteByToken: (...a: unknown[]) => mockFindInvite(...a) } }));

import { NextRequest } from 'next/server';
import { POST as loginPost } from '@/app/api/auth/login/route';
import { POST as signupPost } from '@/app/api/auth/signup/route';
import { POST as resendPost } from '@/app/api/auth/resend-code/route';
import { POST as confirmPost } from '@/app/api/auth/confirm/route';
import { POST as invitePost } from '@/app/api/auth/invite/accept/route';
import { AUTH_LIMITS, clientIp } from '@/lib/api/authRateLimit';

let n = 0;
const uniq = () => `${Date.now()}-${++n}`;
const post = (path: string, body: unknown, ip: string) =>
  new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `1.1.1.1 (spoofed by the caller), ${ip}` }, body: JSON.stringify(body) });
const cognitoError = (name: string) => Object.assign(new Error('cognito detail'), { name });

beforeEach(() => {
  [mockSignIn, mockSignUp, mockResend, mockConfirm, mockFindInvite].forEach((m) => m.mockReset());
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('clientIp', () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = env.CLOUDBUILDER_TRUSTED_PROXY_HOPS;
  afterEach(() => { if (saved === undefined) delete env.CLOUDBUILDER_TRUSTED_PROXY_HOPS; else env.CLOUDBUILDER_TRUSTED_PROXY_HOPS = saved; });
  const r = (h: Record<string, string>) => new NextRequest('http://localhost/x', { headers: h });

  it('trusts the entry the nearest proxy added (the last), never what the caller wrote on the left', () => {
    delete env.CLOUDBUILDER_TRUSTED_PROXY_HOPS;
    expect(clientIp(r({ 'x-forwarded-for': '6.6.6.6, 5.6.7.8' }))).toBe('5.6.7.8');
    expect(clientIp(r({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 5.6.7.8' }))).toBe('5.6.7.8');
    expect(clientIp(r({ 'x-forwarded-for': '5.6.7.8' }))).toBe('5.6.7.8');
  });

  it('a caller cannot change their address by forging the header: the same real client always maps to the same address', () => {
    delete env.CLOUDBUILDER_TRUSTED_PROXY_HOPS;
    const real = clientIp(r({ 'x-forwarded-for': '5.6.7.8' }));
    for (const forged of ['1.1.1.1', '2.2.2.2, 3.3.3.3', 'evil']) expect(clientIp(r({ 'x-forwarded-for': `${forged}, 5.6.7.8` }))).toBe(real);
  });

  it('counts back the configured number of trusted proxies (a CDN plus a load balancer = 2)', () => {
    env.CLOUDBUILDER_TRUSTED_PROXY_HOPS = '2';
    expect(clientIp(r({ 'x-forwarded-for': 'forged, 5.6.7.8, 10.0.0.9' }))).toBe('5.6.7.8');
  });

  it('does not trust a header that is shorter than the number of proxies, or any header when exposed directly (0 hops)', () => {
    env.CLOUDBUILDER_TRUSTED_PROXY_HOPS = '2';
    expect(clientIp(r({ 'x-forwarded-for': '5.6.7.8' }))).toBe('unknown');
    env.CLOUDBUILDER_TRUSTED_PROXY_HOPS = '0';
    expect(clientIp(r({ 'x-forwarded-for': '5.6.7.8', 'x-real-ip': '9.9.9.9' }))).toBe('unknown');
  });

  it('falls back to X-Real-IP when there is no forwarded chain, then "unknown"; nonsense settings mean the default', () => {
    delete env.CLOUDBUILDER_TRUSTED_PROXY_HOPS;
    expect(clientIp(r({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientIp(r({}))).toBe('unknown');
    env.CLOUDBUILDER_TRUSTED_PROXY_HOPS = 'lots';
    expect(clientIp(r({ 'x-forwarded-for': 'a, 5.6.7.8' }))).toBe('5.6.7.8');
  });
});

describe('login', () => {
  const login = (ip: string, email: string) => loginPost(post('/api/auth/login', { email, password: 'wrong-pass1' }, ip));

  it('locks one (address, email) after repeated failures — without calling Cognito again — and says when to retry', async () => {
    const ip = `ip-${uniq()}`; const email = `v${uniq()}@example.com`;
    mockSignIn.mockRejectedValue(cognitoError('NotAuthorizedException'));
    for (let i = 0; i < AUTH_LIMITS.loginFailures.limit; i++) expect((await login(ip, email)).status).toBe(401);
    mockSignIn.mockClear();
    const blocked = await login(ip, email);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('does not let a stranger lock the real user out: another address can still sign in for the same email', async () => {
    const email = `v${uniq()}@example.com`; const attacker = `ip-${uniq()}`; const owner = `ip-${uniq()}`;
    mockSignIn.mockRejectedValue(cognitoError('NotAuthorizedException'));
    for (let i = 0; i < AUTH_LIMITS.loginFailures.limit; i++) await login(attacker, email);
    expect((await login(attacker, email)).status).toBe(429);
    mockSignIn.mockResolvedValue({ idToken: 'i', accessToken: 'a', sub: 's', email, name: 'N' });
    expect((await login(owner, email)).status).toBe(200);
  });

  it('a successful sign-in clears earlier failures', async () => {
    const ip = `ip-${uniq()}`; const email = `v${uniq()}@example.com`;
    mockSignIn.mockRejectedValue(cognitoError('NotAuthorizedException'));
    for (let i = 0; i < AUTH_LIMITS.loginFailures.limit - 1; i++) await login(ip, email);
    mockSignIn.mockResolvedValue({ idToken: 'i', accessToken: 'a', sub: 's', email, name: 'N' });
    expect((await login(ip, email)).status).toBe(200);
    mockSignIn.mockRejectedValue(cognitoError('NotAuthorizedException'));
    for (let i = 0; i < AUTH_LIMITS.loginFailures.limit; i++) expect((await login(ip, email)).status).toBe(401);   // a fresh budget
  });

  it('a Cognito outage is not counted against the user', async () => {
    const ip = `ip-${uniq()}`; const email = `v${uniq()}@example.com`;
    mockSignIn.mockRejectedValue(cognitoError('InternalErrorException'));
    for (let i = 0; i < AUTH_LIMITS.loginFailures.limit + 3; i++) expect((await login(ip, email)).status).toBe(503);
    mockSignIn.mockResolvedValue({ idToken: 'i', accessToken: 'a', sub: 's', email, name: 'N' });
    expect((await login(ip, email)).status).toBe(200);
  });

  it('limits one address overall, whatever emails it tries', async () => {
    const ip = `ip-${uniq()}`;
    mockSignIn.mockRejectedValue(cognitoError('InternalErrorException'));
    for (let i = 0; i < AUTH_LIMITS.loginIp.limit; i++) await login(ip, `x${i}-${uniq()}@example.com`);
    expect((await login(ip, `y${uniq()}@example.com`)).status).toBe(429);
  });

  it('blocks for 2 minutes initially, and escalates to 5 minutes for repeated failures', async () => {
    const ip = `ip-${uniq()}`; const email = `escalate-${uniq()}@example.com`;
    mockSignIn.mockRejectedValue(cognitoError('NotAuthorizedException'));

    // 1st round: 5 failures triggers 2-min (120s) lockout
    let fifthRes: any;
    for (let i = 0; i < AUTH_LIMITS.loginFailures.limit; i++) {
      fifthRes = await login(ip, email);
    }
    expect(fifthRes.status).toBe(401);
    const fifthBody = await fifthRes.json();
    expect(fifthBody.error.message).toContain('2 minutes');

    // Attempting while locked out returns 429 with ~120s Retry-After
    const blockedTier1 = await login(ip, email);
    expect(blockedTier1.status).toBe(429);
    const retryAfter1 = Number(blockedTier1.headers.get('Retry-After'));
    expect(retryAfter1).toBeGreaterThanOrEqual(115);
    expect(retryAfter1).toBeLessThanOrEqual(120);
    const tier1Body = await blockedTier1.json();
    expect(tier1Body.error.message).toContain('2 minutes');

    // Simulate 2 minutes passing (121 seconds later)
    const realNow = Date.now;
    try {
      jest.spyOn(Date, 'now').mockReturnValue(realNow() + 121_000);

      // Lockout has expired, attempt reaches sign-in again
      mockSignIn.mockClear();
      const firstTryAfterLock = await login(ip, email);
      expect(firstTryAfterLock.status).toBe(401);
      expect(mockSignIn).toHaveBeenCalledTimes(1);

      // 4 more failures (total 5 in round 2)
      let repeatFifthRes: any;
      for (let i = 0; i < 4; i++) {
        repeatFifthRes = await login(ip, email);
      }
      expect(repeatFifthRes.status).toBe(401);
      const repeatFifthBody = await repeatFifthRes.json();
      expect(repeatFifthBody.error.message).toContain('5 minutes');

      // Next attempt while locked out in round 2 returns 429 with ~300s Retry-After
      const blockedTier2 = await login(ip, email);
      expect(blockedTier2.status).toBe(429);
      const retryAfter2 = Number(blockedTier2.headers.get('Retry-After'));
      expect(retryAfter2).toBeGreaterThanOrEqual(295);
      expect(retryAfter2).toBeLessThanOrEqual(300);
      const tier2Body = await blockedTier2.json();
      expect(tier2Body.error.message).toContain('5 minutes');
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('sign-up', () => {
  const signup = (ip: string, email: string) => signupPost(post('/api/auth/signup', { email, password: 'Str0ng!Passw0rd', name: 'N', orgName: 'O' }, ip));
  it('limits sign-ups per email and per address', async () => {
    mockSignUp.mockResolvedValue({ isConfirmed: false, userSub: 's' });
    const email = `s${uniq()}@example.com`;
    for (let i = 0; i < AUTH_LIMITS.signupEmail.limit; i++) expect((await signup(`ip-${uniq()}`, email)).status).toBe(200);
    expect((await signup(`ip-${uniq()}`, email)).status).toBe(429);

    const ip = `ip-${uniq()}`;
    for (let i = 0; i < AUTH_LIMITS.signupIp.limit; i++) expect((await signup(ip, `s${uniq()}@example.com`)).status).toBe(200);
    expect((await signup(ip, `s${uniq()}@example.com`)).status).toBe(429);
  });
});

describe('resend code', () => {
  const resend = (ip: string, email: string) => resendPost(post('/api/auth/resend-code', { email }, ip));

  it('answers the same whether or not the address is registered', async () => {
    mockResend.mockResolvedValueOnce(undefined);
    const a = await resend(`ip-${uniq()}`, `a${uniq()}@example.com`);
    mockResend.mockRejectedValueOnce(cognitoError('UserNotFoundException'));
    const b = await resend(`ip-${uniq()}`, `b${uniq()}@example.com`);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
  });

  it('limits repeats per email and does not leak Cognito\'s wording on a service error', async () => {
    const email = `r${uniq()}@example.com`;
    mockResend.mockResolvedValue(undefined);
    for (let i = 0; i < AUTH_LIMITS.resendEmail.limit; i++) expect((await resend(`ip-${uniq()}`, email)).status).toBe(200);
    expect((await resend(`ip-${uniq()}`, email)).status).toBe(429);

    mockResend.mockRejectedValue(cognitoError('InternalErrorException'));
    const res = await resend(`ip-${uniq()}`, `r${uniq()}@example.com`);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('cognito detail');
  });
});

describe('confirm code', () => {
  const confirm = (ip: string, email: string) => confirmPost(post('/api/auth/confirm', { email, code: '000000' }, ip));
  it('allows only a few code guesses per (address, email), then stops asking Cognito', async () => {
    const ip = `ip-${uniq()}`; const email = `c${uniq()}@example.com`;
    mockConfirm.mockRejectedValue(cognitoError('CodeMismatchException'));
    for (let i = 0; i < AUTH_LIMITS.confirmAttempts.limit; i++) expect((await confirm(ip, email)).status).toBe(400);
    mockConfirm.mockClear();
    expect((await confirm(ip, email)).status).toBe(429);
    expect(mockConfirm).not.toHaveBeenCalled();
  });
  it('does not pass Cognito\'s own wording to the caller for unexpected errors', async () => {
    mockConfirm.mockRejectedValue(cognitoError('InternalErrorException'));
    const res = await confirm(`ip-${uniq()}`, `c${uniq()}@example.com`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('cognito detail');
  });
});

describe('invite accept', () => {
  it('limits scripted guessing per address', async () => {
    mockFindInvite.mockResolvedValue(null);
    const ip = `ip-${uniq()}`;
    for (let i = 0; i < AUTH_LIMITS.inviteIp.limit; i++) expect((await invitePost(post('/api/auth/invite/accept', { token: `t${i}` }, ip))).status).toBe(400);
    expect((await invitePost(post('/api/auth/invite/accept', { token: 'tx' }, ip))).status).toBe(429);
  });
});
