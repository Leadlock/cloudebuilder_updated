import { verifyAccountPassword, type VerifyDeps } from '@/lib/auth/verifyAccountPassword';

const deps = (over: Partial<VerifyDeps> = {}): VerifyDeps => ({
  getPasswordHash: async () => null,
  verifyHash: async (pw, hash) => hash === `hash:${pw}`,
  cognitoSignIn: async () => ({ sub: 'u1' }),
  ...over,
});
const input = (password = 'pw', over: { userId?: string; email?: string } = {}) => ({ userId: 'u1', email: 'a@b.c', password, ...over });

describe('verifyAccountPassword', () => {
  it('checks a local hash when there is one, and never calls Cognito', async () => {
    const cognito = jest.fn();
    const d = deps({ getPasswordHash: async () => 'hash:pw', cognitoSignIn: cognito });
    expect(await verifyAccountPassword(input('pw'), d)).toBe('ok');
    expect(await verifyAccountPassword(input('bad'), d)).toBe('wrong');
    expect(cognito).not.toHaveBeenCalled();
  });

  it('checks Cognito for accounts without a local hash', async () => {
    expect(await verifyAccountPassword(input(), deps())).toBe('ok');
    expect(await verifyAccountPassword(input(), deps({ cognitoSignIn: async () => { throw Object.assign(new Error('x'), { name: 'NotAuthorizedException' }); } }))).toBe('wrong');
  });

  it('refuses a Cognito identity that is a different user', async () => {
    expect(await verifyAccountPassword(input(), deps({ cognitoSignIn: async () => ({ sub: 'someone-else' }) }))).toBe('wrong');
  });

  it('says none when there is nowhere to check, and unavailable when Cognito fails for another reason', async () => {
    expect(await verifyAccountPassword(input('pw', { email: undefined }), deps())).toBe('none');
    expect(await verifyAccountPassword(input(), deps({ cognitoSignIn: async () => { throw Object.assign(new Error('x'), { name: 'UserNotFoundException' }); } }))).toBe('none');
    expect(await verifyAccountPassword(input(), deps({ cognitoSignIn: async () => { throw Object.assign(new Error('x'), { name: 'TooManyRequestsException' }); } }))).toBe('unavailable');
  });
});
