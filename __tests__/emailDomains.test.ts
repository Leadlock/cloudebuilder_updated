/**
 * ALLOWED_EMAIL_DOMAINS: only people on the listed email domains can sign up, sign in, be invited or stay signed in.
 */
import { allowedEmailDomains, domainRestrictionMessage, emailAllowed } from '@/lib/auth/emailDomains';
import { checkProductionConfig } from '@/lib/startup/productionChecks';

const env = (v?: string): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ...(v === undefined ? {} : { ALLOWED_EMAIL_DOMAINS: v }) });

describe('emailAllowed', () => {
  test('without a restriction anyone is allowed', () => {
    expect(emailAllowed('anyone@gmail.com', env())).toBe(true);
    expect(emailAllowed('anyone@gmail.com', env(''))).toBe(true);
    expect(emailAllowed('anyone@gmail.com', env('   '))).toBe(true);
  });

  test('only the listed domain is allowed, in any letter case', () => {
    expect(emailAllowed('ajinkya@neozaar.com', env('neozaar.com'))).toBe(true);
    expect(emailAllowed('Ajinkya@NeoZaar.COM', env('neozaar.com'))).toBe(true);
    expect(emailAllowed('  ajinkya@neozaar.com ', env('neozaar.com'))).toBe(true);
    expect(emailAllowed('someone@gmail.com', env('neozaar.com'))).toBe(false);
  });

  test('several domains, with spaces and a leading @', () => {
    const e = env('neozaar.com, @partner.io');
    expect(allowedEmailDomains(e)).toEqual(['neozaar.com', 'partner.io']);
    expect(emailAllowed('a@partner.io', e)).toBe(true);
    expect(emailAllowed('a@other.io', e)).toBe(false);
  });

  test.each([
    'x@neozaar.com.evil.com',
    'x@evil.com@neozaar.com',
    '"x@neozaar.com"@evil.com',
    'x@sub.neozaar.com',
    'x@neozaar.co',
    'x@neozaar.com\n@evil.com',
    'x@neozaar.com ',
    'x@neozааr.com',           // Cyrillic look-alike letters
    '@neozaar.com',
    'neozaar.com',
    '',
  ])('look-alike or malformed address is refused: %j', (address) => {
    // "x@neozaar.com " with a trailing space is trimmed and so is legitimately fine; every other case must fail.
    const expected = address === 'x@neozaar.com ';
    expect(emailAllowed(address, env('neozaar.com'))).toBe(expected);
  });

  test('values that are not text are refused', () => {
    expect(emailAllowed(undefined, env('neozaar.com'))).toBe(false);
    expect(emailAllowed(null, env('neozaar.com'))).toBe(false);
    expect(emailAllowed(['a@neozaar.com'], env('neozaar.com'))).toBe(false);
  });

  test('a restriction with only invalid entries refuses everyone instead of opening the app', () => {
    expect(emailAllowed('a@neozaar.com', env('neozaar'))).toBe(false);
    expect(emailAllowed('a@neozaar.com', env('*'))).toBe(false);
  });

  test('the message names the allowed domains', () => {
    expect(domainRestrictionMessage(env('neozaar.com'))).toBe('Access is limited to @neozaar.com email addresses.');
  });
});

describe('production startup', () => {
  const prod = (v?: string): NodeJS.ProcessEnv => ({
    NODE_ENV: 'production', SESSION_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    ENCRYPTION_KEY: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f1',
    DATABASE_URL: 'postgresql://a:b@localhost:5432/x', APP_URL: 'https://x.test', SMTP_HOST: 's', RESTRICTED_FEATURES_ALLOWED_EMAILS: 'ajinkya@neozaar.com', ...(v === undefined ? {} : { ALLOWED_EMAIL_DOMAINS: v }),
  });
  test('a working restriction is announced, not an error', () => {
    const r = checkProductionConfig(prod('neozaar.com'));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toContain('@neozaar.com');
  });
  test('a restriction nobody could satisfy stops the server from starting', () => {
    expect(checkProductionConfig(prod('neozaar')).errors.join(' ')).toContain('nobody could sign in');
  });
});

describe('production startup: closed features', () => {
  const base = (v?: string): NodeJS.ProcessEnv => ({
    NODE_ENV: 'production', SESSION_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    ENCRYPTION_KEY: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f1',
    DATABASE_URL: 'postgresql://a:b@localhost:5432/x', APP_URL: 'https://x.test', SMTP_HOST: 's', ...(v === undefined ? {} : { RESTRICTED_FEATURES_ALLOWED_EMAILS: v }),
  });
  test('a working list is announced, a list nobody could satisfy stops the server', () => {
    const ok = checkProductionConfig(base('ajinkya@neozaar.com'));
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.join(' ')).toContain('ajinkya@neozaar.com');
    expect(checkProductionConfig(base('ajinkya')).errors.join(' ')).toContain('nobody could use Deploy');
  });
});
