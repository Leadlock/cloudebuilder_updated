/**
 * What a production server must have before it accepts a single request. Without this the app starts happily and only fails when someone first
 * signs in or saves a cloud account, which is the worst moment to find out. Errors stop the server from starting; warnings are printed.
 * Nothing here runs outside production, so development and tests are unaffected.
 */
import { createHash } from 'crypto';
import { assessEncryptionKey } from '@/lib/crypto/credentials';
import { allowedEmailDomains } from '@/lib/auth/emailDomains';
import { restrictedFeatureEmails, restrictedFeaturesClosed } from '@/lib/auth/restrictedFeatures';
import { superAdminEmails, superAdminsConfigured } from '@/lib/auth/superAdmins';

export interface StartupReport { errors: string[]; warnings: string[] }

const NEW_SECRET = `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;
/** Session secrets that were once published as examples (compared by hash, so this file does not repeat them). */
const PUBLISHED_SESSION_SECRET_HASHES = new Set(['2aeb44412f66ad1af12c68f36a4687d0855ce696c4ad3a760bf7acf191bf7f98']);

function sessionSecretProblem(v: string | undefined): string | null {
  if (!v) return 'SESSION_SECRET is not set, so nobody could sign in.';
  if (v.length < 32) return 'SESSION_SECRET is shorter than 32 characters.';
  if (PUBLISHED_SESSION_SECRET_HASHES.has(createHash('sha256').update(v, 'utf8').digest('hex'))) return 'SESSION_SECRET is a value that was published as an example, so anyone could forge a login.';
  if (new Set(v).size < 8) return 'SESSION_SECRET does not look random (too few different characters).';
  return null;
}

function databaseHost(url: string): { host: string; ssl: boolean } | null {
  try {
    const u = new URL(url);
    const mode = u.searchParams.get('sslmode') ?? '';
    return { host: u.hostname, ssl: ['require', 'verify-ca', 'verify-full'].includes(mode) || u.searchParams.get('ssl') === 'true' };
  } catch { return null; }
}

export function checkProductionConfig(env: NodeJS.ProcessEnv = process.env): StartupReport {
  const report: StartupReport = { errors: [], warnings: [] };
  if (env['NODE_ENV'] !== 'production') return report;
  const { errors, warnings } = report;

  const secret = sessionSecretProblem(env['SESSION_SECRET']);
  if (secret) errors.push(`${secret} Generate one with: ${NEW_SECRET}`);

  const key = assessEncryptionKey(env['ENCRYPTION_KEY'], true);
  if (!key.ok) errors.push(`ENCRYPTION_KEY ${key.problem}.`);
  if (env['ENCRYPTION_KEY'] && env['ENCRYPTION_KEY'] === env['SESSION_SECRET']) errors.push('ENCRYPTION_KEY and SESSION_SECRET are the same value. They protect different things: use two separate random values.');
  for (const old of (env['ENCRYPTION_KEYS_PREVIOUS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const v = assessEncryptionKey(old, true);
    if (!v.ok) { errors.push(`An entry in ENCRYPTION_KEYS_PREVIOUS ${v.problem}.`); break; }
  }

  if (env['CLOUDCRAFT_ALLOW_TEST_AUTH_HEADERS'] === '1') errors.push('CLOUDCRAFT_ALLOW_TEST_AUTH_HEADERS is on. It lets anyone log in as any user by sending a header. Remove it.');

  const db = env['DATABASE_URL'];
  if (!db) errors.push('DATABASE_URL is not set.');
  else {
    if (/USER:PASSWORD|YOUR_PASSWORD|<password>/i.test(db)) errors.push('DATABASE_URL still contains the example user and password.');
    const parsed = databaseHost(db);
    if (!parsed) errors.push('DATABASE_URL is not a valid address.');
    else if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.host) && !parsed.ssl) warnings.push('DATABASE_URL does not require TLS (add ?sslmode=require), so database traffic is not encrypted.');
  }

  const restricted = (env['ALLOWED_EMAIL_DOMAINS'] ?? '').trim() !== '';
  if (restricted) {
    const domains = allowedEmailDomains(env);
    if (domains.length === 0) errors.push('ALLOWED_EMAIL_DOMAINS is set but has no valid domain (for example neozaar.com), so nobody could sign in. Fix it or remove it.');
    else warnings.push(`Access is limited to ${domains.map((d) => `@${d}`).join(', ')} email addresses (ALLOWED_EMAIL_DOMAINS).`);
  }

  if (restrictedFeaturesClosed(env)) {
    const people = restrictedFeatureEmails(env);
    if (people.length === 0) errors.push('RESTRICTED_FEATURES_ALLOWED_EMAILS is set but has no valid email address, so nobody could use Deploy, the AI Generator or Cloud Accounts. Fix it or remove it.');
    else warnings.push(`Deploy, the AI Generator and Cloud Accounts are open only to ${people.length === 1 ? people[0] : `${people.length} listed accounts`} (RESTRICTED_FEATURES_ALLOWED_EMAILS).`);
  } else if (env['RESTRICTED_FEATURES_OPEN_TO_ALL'] === '1') {
    warnings.push('Deploy (Terraform plan, apply, destroy), the AI Generator and Cloud Accounts are open to everyone who can sign in (RESTRICTED_FEATURES_OPEN_TO_ALL=1).');
  } else {
    // An empty list means "open to everyone". On a production server that must be a decision, never what happens when a line is missing from the
    // server's own environment (which is how a second person once got into Deploy).
    errors.push('RESTRICTED_FEATURES_ALLOWED_EMAILS is not set, so everyone who can sign in could use Deploy (Terraform apply and destroy with real cloud credentials), the AI Generator and Cloud Accounts. Set it to the people who may (for example ajinkya@neozaar.com). If you really want it open to everyone, set RESTRICTED_FEATURES_OPEN_TO_ALL=1.');
  }

  if (superAdminsConfigured(env)) {
    const admins = superAdminEmails(env);
    if (admins.length === 0) errors.push('SUPER_ADMIN_EMAILS is set but has no valid email address, so nobody could approve an architecture review and nothing could be deployed. Fix it or remove it.');
    else warnings.push(`Only ${admins.join(', ')} can approve architecture reviews, and they are an owner of every organization they belong to (SUPER_ADMIN_EMAILS).`);
  } else {
    warnings.push('SUPER_ADMIN_EMAILS is not set, so any organization admin can approve an architecture review, and with it a Terraform plan and apply.');
  }

  const appUrl = env['APP_URL'];
  if (!appUrl) warnings.push('APP_URL is not set, so invitation and password-reset emails link to http://localhost:3000.');
  else if (!/^https:\/\//i.test(appUrl)) warnings.push('APP_URL is not https, so emailed links are not secure.');
  if (!env['SMTP_HOST']) warnings.push('SMTP_HOST is not set, so no verification, invitation or password-reset emails can be sent.');
  return report;
}

/** Called once when the server starts. Throws with every problem at once, so they are fixed in one go. */
export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  const { errors, warnings } = checkProductionConfig(env);
  for (const w of warnings) console.warn(`[startup] ${w}`);
  if (errors.length > 0) {
    throw new Error(`CloudBuilder will not start in production until this is fixed:\n${errors.map((e) => `  - ${e}`).join('\n')}\nSee .env.example.`);
  }
}
