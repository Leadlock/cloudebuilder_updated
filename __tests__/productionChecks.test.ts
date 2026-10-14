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
});
const errors = (env: NodeJS.ProcessEnv) => checkProductionConfig(env).errors.join(' | ');

describe('production startup check', () => {
  test('a properly configured server has no errors and no warnings', () => {
    expect(checkProductionConfig(good())).toEqual({ errors: [], warnings: [] });
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
    expect(checkProductionConfig({ ...good(), DATABASE_URL: 'postgresql://a:b@localhost:5432/x' }).warnings).toEqual([]);
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
