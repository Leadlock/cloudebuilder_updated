/**
 * The production startup check: a server with a missing, example or weak secret refuses to start, and says everything wrong at once.
 */
import { randomBytes } from 'crypto';
import { assertProductionConfig, checkProductionConfig } from '@/lib/startup/productionChecks';

const good = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  SESSION_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  DATABASE_URL: 'postgresql://app:s3cret@db.internal:5432/cloudcraft?sslmode=require',
  APP_URL: 'https://cloudcraft.example.com',
  SMTP_HOST: 'smtp.example.com',
  RESTRICTED_FEATURES_ALLOWED_EMAILS: 'admin@example.com',
  SUPER_ADMIN_EMAILS: 'admin@example.com',
});
/** The two notices a correctly closed server always prints: who may use Deploy, and who approves reviews. */
const NOTICES = [expect.stringContaining('open only to admin@example.com'), expect.stringContaining('Only admin@example.com can approve')];
const errors = (env: NodeJS.ProcessEnv) => checkProductionConfig(env).errors.join(' | ');

describe('production startup check', () => {
  test('a properly configured server has no errors, and only says who has access', () => {
    expect(checkProductionConfig(good())).toEqual({ errors: [], warnings: NOTICES });
  });

  test('outside production nothing is checked', () => {
    expect(checkProductionConfig({ NODE_ENV: 'development' })).toEqual({ errors: [], warnings: [] });
    expect(checkProductionConfig({ NODE_ENV: 'test' })).toEqual({ errors: [], warnings: [] });
    expect(() => assertProductionConfig({ NODE_ENV: 'development' })).not.toThrow();
  });

  test('a missing, short or non-random session secret is refused', () => {
    expect(errors({ ...good(), SESSION_SECRET: undefined })).toContain('SESSION_SECRET is not set');
    expect(errors({ ...good(), SESSION_SECRET: 'short' })).toContain('shorter than 32');
    expect(errors({ ...good(), SESSION_SECRET: 'a'.repeat(40) })).toContain('does not look random');
  });

  test('a missing, passphrase or all-zero encryption key is refused', () => {
    expect(errors({ ...good(), ENCRYPTION_KEY: undefined })).toContain('ENCRYPTION_KEY is not set');
    expect(errors({ ...good(), ENCRYPTION_KEY: 'a passphrase that is long enough but not hex' })).toContain('64 hexadecimal');
    expect(errors({ ...good(), ENCRYPTION_KEY: '0'.repeat(64) })).toContain('does not look random');
  });

  test('the same value for both secrets is refused', () => {
    const v = randomBytes(32).toString('hex');
    expect(errors({ ...good(), SESSION_SECRET: v, ENCRYPTION_KEY: v })).toContain('are the same value');
  });

  test('a bad previous encryption key is refused', () => {
    expect(errors({ ...good(), ENCRYPTION_KEYS_PREVIOUS: `${randomBytes(32).toString('hex')}, nope` })).toContain('ENCRYPTION_KEYS_PREVIOUS');
    expect(errors({ ...good(), ENCRYPTION_KEYS_PREVIOUS: randomBytes(32).toString('hex') })).toBe('');
  });

  test('the test-login header switch must be off', () => {
    expect(errors({ ...good(), CLOUDCRAFT_ALLOW_TEST_AUTH_HEADERS: '1' })).toContain('log in as any user');
  });

  test('the database address must be set, real and valid', () => {
    expect(errors({ ...good(), DATABASE_URL: undefined })).toContain('DATABASE_URL is not set');
    expect(errors({ ...good(), DATABASE_URL: 'postgresql://USER:PASSWORD@db:5432/x?sslmode=require' })).toContain('example user and password');
    expect(errors({ ...good(), DATABASE_URL: 'not a url' })).toContain('not a valid address');
  });

  test('warnings, not errors, for a database without TLS, a non-https address and no email', () => {
    const r = checkProductionConfig({ ...good(), DATABASE_URL: 'postgresql://a:b@db.internal:5432/x', APP_URL: 'http://x.test', SMTP_HOST: undefined });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toContain('does not require TLS');
    expect(r.warnings.join(' ')).toContain('not https');
    expect(r.warnings.join(' ')).toContain('SMTP_HOST');
  });

  test('a local database needs no TLS', () => {
    expect(checkProductionConfig({ ...good(), DATABASE_URL: 'postgresql://a:b@localhost:5432/x' }).warnings).toEqual(NOTICES);
  });

  describe('the access lock on Deploy, the AI Generator and Cloud Accounts', () => {
    test('a production server without the list refuses to start, and says how to fix it', () => {
      const env = good(); delete env['RESTRICTED_FEATURES_ALLOWED_EMAILS'];
      const e = errors(env);
      expect(e).toContain('RESTRICTED_FEATURES_ALLOWED_EMAILS is not set');
      expect(e).toContain('RESTRICTED_FEATURES_OPEN_TO_ALL=1');
      expect(() => assertProductionConfig(env)).toThrow(/will not start in production[\s\S]*RESTRICTED_FEATURES_ALLOWED_EMAILS/);
    });
    test('an empty or blank value is the same as missing', () => {
      expect(errors({ ...good(), RESTRICTED_FEATURES_ALLOWED_EMAILS: '' })).toContain('is not set');
      expect(errors({ ...good(), RESTRICTED_FEATURES_ALLOWED_EMAILS: '   ' })).toContain('is not set');
    });
    test('a list with no valid address is refused: it would lock everyone out', () => {
      expect(errors({ ...good(), RESTRICTED_FEATURES_ALLOWED_EMAILS: 'REPLACE_WITH_THE_EMAIL_OF_WHO_MAY_USE_DEPLOY' })).toContain('no valid email address');
    });
    test('opening it to everyone has to be said out loud, and is then only a warning', () => {
      const env = good(); delete env['RESTRICTED_FEATURES_ALLOWED_EMAILS'];
      const r = checkProductionConfig({ ...env, RESTRICTED_FEATURES_OPEN_TO_ALL: '1' });
      expect(r.errors).toEqual([]);
      expect(r.warnings.join(' ')).toContain('open to everyone who can sign in');
      expect(errors({ ...env, RESTRICTED_FEATURES_OPEN_TO_ALL: 'true' })).toContain('is not set');   // only the exact value 1
    });
    test('a listed person is a notice, and the open-to-all switch does not override a list', () => {
      const r = checkProductionConfig({ ...good(), RESTRICTED_FEATURES_OPEN_TO_ALL: '1' });
      expect(r.errors).toEqual([]);
      expect(r.warnings.join(' ')).toContain('open only to admin@example.com');
      expect(r.warnings.join(' ')).not.toContain('open to everyone');
    });
    test('development and test builds are not affected', () => {
      expect(checkProductionConfig({ NODE_ENV: 'development' }).errors).toEqual([]);
      expect(checkProductionConfig({ NODE_ENV: 'test' }).errors).toEqual([]);
    });
    test('no super administrator is a warning, not an error', () => {
      const env = good(); delete env['SUPER_ADMIN_EMAILS'];
      const r = checkProductionConfig(env);
      expect(r.errors).toEqual([]);
      expect(r.warnings.join(' ')).toContain('any organization admin can approve');
    });
  });

  test('starting throws once, listing every problem and never printing a secret', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const secret = 'x'.repeat(10);
    let message = '';
    try { assertProductionConfig({ NODE_ENV: 'production', SESSION_SECRET: secret }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('will not start in production');
    expect(message).toContain('SESSION_SECRET');
    expect(message).toContain('ENCRYPTION_KEY');
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(secret);
  });
});
