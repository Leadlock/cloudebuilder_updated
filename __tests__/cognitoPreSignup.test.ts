/**
 * The Cognito pre sign-up trigger (infra/cognito-pre-signup/index.mjs): the real file is run here, and it must decide exactly as CloudCraft's own
 * domain rule does, so the two cannot drift apart.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { emailAllowed } from '@/lib/auth/emailDomains';

type Handler = (event: unknown) => Promise<unknown>;
const source = readFileSync(join(__dirname, '..', 'infra', 'cognito-pre-signup', 'index.mjs'), 'utf8');
// The file is a Lambda ES module; only its "export" keyword is removed so it can run here.
const handler = new Function(`${source.replace('export const handler', 'const handler')}\nreturn handler;`)() as Handler;

const OLD = process.env['ALLOWED_EMAIL_DOMAINS'];
beforeEach(() => { process.env['ALLOWED_EMAIL_DOMAINS'] = 'neozaar.com'; jest.spyOn(console, 'warn').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => { if (OLD === undefined) delete process.env['ALLOWED_EMAIL_DOMAINS']; else process.env['ALLOWED_EMAIL_DOMAINS'] = OLD; });

const event = (email: string | undefined, extra: Record<string, unknown> = {}) => ({
  version: '1', triggerSource: 'PreSignUp_SignUp', region: 'eu-north-1', userPoolId: 'pool', userName: 'some-uuid',
  request: { userAttributes: email === undefined ? {} : { email }, validationData: null }, response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false }, ...extra,
});

describe('who is let in', () => {
  test('an address on the domain goes through, and the event comes back unchanged (nothing auto-confirmed)', async () => {
    const e = event('ajinkya@neozaar.com');
    expect(await handler(e)).toBe(e);
    expect((e.response as { autoConfirmUser: boolean }).autoConfirmUser).toBe(false);
  });

  test('capital letters and spaces around the address do not matter', async () => {
    await expect(handler(event('  Ajinkya@NeoZaar.COM '))).resolves.toBeTruthy();
  });

  test('another domain is refused, naming the allowed one', async () => {
    await expect(handler(event('someone@gmail.com'))).rejects.toThrow('Access is limited to @neozaar.com email addresses.');
  });

  test.each([
    'x@neozaar.com.evil.com',
    'x@evil.com@neozaar.com',
    '"x@neozaar.com"@evil.com',
    'x@sub.neozaar.com',
    'x@neozaar.co',
    'x@neozaar.com\n@evil.com',
    'x @neozaar.com',
    'x@neozааr.com',            // Cyrillic look-alike letters
    '@neozaar.com',
    'neozaar.com',
    '',
  ])('look-alike or malformed address is refused: %j', async (address) => {
    await expect(handler(event(address))).rejects.toThrow('Access is limited');
  });

  test('every way an account can be created is checked', async () => {
    for (const triggerSource of ['PreSignUp_SignUp', 'PreSignUp_AdminCreateUser', 'PreSignUp_ExternalProvider']) {
      await expect(handler(event('someone@gmail.com', { triggerSource }))).rejects.toThrow('Access is limited');
      await expect(handler(event('a@neozaar.com', { triggerSource }))).resolves.toBeTruthy();
    }
  });

  test('with no email attribute, a user name that is an address is checked; otherwise the sign-up is refused', async () => {
    await expect(handler(event(undefined, { userName: 'a@neozaar.com' }))).resolves.toBeTruthy();
    await expect(handler(event(undefined, { userName: 'a@gmail.com' }))).rejects.toThrow('Access is limited');
    await expect(handler(event(undefined, { userName: 'some-uuid' }))).rejects.toThrow('Access is limited');
    await expect(handler({})).rejects.toThrow();
  });

  test('several domains', async () => {
    process.env['ALLOWED_EMAIL_DOMAINS'] = 'neozaar.com, @partner.io';
    await expect(handler(event('a@partner.io'))).resolves.toBeTruthy();
    await expect(handler(event('a@other.io'))).rejects.toThrow('@neozaar.com and @partner.io');
  });
});

describe('a mistake must not open registration', () => {
  test.each([undefined, '', '   ', 'neozaar', '*', ',,'])('ALLOWED_EMAIL_DOMAINS = %j refuses every sign-up', async (value) => {
    if (value === undefined) delete process.env['ALLOWED_EMAIL_DOMAINS']; else process.env['ALLOWED_EMAIL_DOMAINS'] = value;
    await expect(handler(event('ajinkya@neozaar.com'))).rejects.toThrow('Sign-up is not available');
    expect(console.error).toHaveBeenCalled();
  });
});

describe('privacy', () => {
  test('the address is never written to the log', async () => {
    await expect(handler(event('private.person@gmail.com'))).rejects.toThrow();
    const logged = JSON.stringify([...(console.warn as jest.Mock).mock.calls, ...(console.error as jest.Mock).mock.calls]);
    expect(logged).not.toContain('private.person');
    expect(logged).toContain('PreSignUp_SignUp');
  });
});

describe('the same decisions as CloudCraft', () => {
  const addresses = [
    'ajinkya@neozaar.com', 'AJINKYA@NEOZAAR.COM', ' a@neozaar.com ', 'a@gmail.com', 'a@neozaar.com.evil.com', 'a@evil.com@neozaar.com', 'a@sub.neozaar.com',
    'a@neozaar.co', '@neozaar.com', 'neozaar.com', '', 'a b@neozaar.com', 'a@neozааr.com', 'a+tag@neozaar.com', 'a@partner.io', 'a@PARTNER.io',
  ];
  test.each(['neozaar.com', 'neozaar.com, partner.io', '@partner.io'])('for ALLOWED_EMAIL_DOMAINS = %j every address gets the same answer', async (domains) => {
    process.env['ALLOWED_EMAIL_DOMAINS'] = domains;
    for (const a of addresses) {
      const app = emailAllowed(a, { NODE_ENV: 'test', ALLOWED_EMAIL_DOMAINS: domains });
      const lambda = await handler(event(a)).then(() => true, () => false);
      expect({ address: a, lambda }).toEqual({ address: a, lambda: app });
    }
  });
});
