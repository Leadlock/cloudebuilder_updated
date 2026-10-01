/**
 * Lists accounts that have a LOCAL password (a row in User with a passwordHash) — read-only.
 *
 *   npm run auth:list-local-accounts
 *
 * Why: before sign-up failed closed, an error from AWS Cognito silently created a local account for whatever email was
 * typed, with no email verification. Those accounts can still sign in. Accounts that belong to people who joined through
 * Cognito have no local password, so any row listed here is either a legitimate pre-Cognito account, an invited user who
 * set a password, or one of those unverified sign-ups. Review each email, and remove or reset the ones you do not
 * recognise. This script never prints a password hash and never changes anything.
 */
import { db } from '../../src/prisma/db';

async function main(): Promise<void> {
  const rows = await db.orm.public.User.select('id', 'email', 'name', 'passwordHash', 'createdAt').all();
  const local = rows
    .filter((u) => typeof u.passwordHash === 'string' && u.passwordHash.length > 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  console.log(`${rows.length} user(s) in total, ${local.length} with a local password.\n`);
  if (local.length === 0) {
    console.log('No accounts with a local password — nothing to review.');
    return;
  }
  console.log('created (UTC)         email');
  for (const u of local) console.log(`${u.createdAt.slice(0, 19).replace('T', ' ')}   ${u.email}${u.name ? `  (${u.name})` : ''}`);
  console.log('\nReview each address. Remove or reset any you do not recognise.');
}

main().then(() => process.exit(0)).catch((err) => { console.error('Could not read the users table:', err instanceof Error ? err.message : String(err)); process.exit(1); });
