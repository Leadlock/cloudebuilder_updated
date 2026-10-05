/**
 * A person's authenticator-app setup (table `userTotp`). The secret is encrypted with the credential key and bound to the user; it is
 * only ever shown once, while setting up. Recovery codes are stored as hashes. Turning it on needs a correct code (proof the app works),
 * and a code can only be used once.
 */
import { createHash, randomInt } from 'crypto';
import { sharedDb } from '@/lib/api/sharedStore';
import { encrypt, decrypt } from '@/lib/crypto/credentials';
import { generateTotpSecret, verifyTotp, otpauthUri } from '@/lib/crypto/totp';

const context = (userId: string) => `totp:${userId}`;
const hashRecovery = (code: string) => createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

interface Row { userId: string; secretEnc: string; enabled: boolean; lastStep: number; recoveryJson: string }

async function load(userId: string): Promise<Row | null> {
  const { rows } = await sharedDb().query(`SELECT "userId", "secretEnc", "enabled", "lastStep", "recoveryJson" FROM "userTotp" WHERE "userId" = $1`, [userId]);
  const r = rows[0];
  return r ? { userId: String(r['userId']), secretEnc: String(r['secretEnc']), enabled: r['enabled'] === true, lastStep: Number(r['lastStep']), recoveryJson: String(r['recoveryJson']) } : null;
}

export async function totpEnabled(userId: string): Promise<boolean> {
  // No try/catch on purpose: if this cannot be read, confirming must fail, not quietly skip the second step.
  return (await load(userId))?.enabled === true;
}

export async function totpStatus(userId: string): Promise<{ enabled: boolean; recoveryCodesLeft: number }> {
  const row = await load(userId);
  if (!row?.enabled) return { enabled: false, recoveryCodesLeft: 0 };
  return { enabled: true, recoveryCodesLeft: (JSON.parse(row.recoveryJson) as string[]).length };
}

/** Starts (or restarts) setup with a fresh secret. Nothing is required of the person yet: it only protects them once enabled. */
export async function beginTotpSetup(userId: string, accountLabel: string): Promise<{ secret: string; uri: string }> {
  const existing = await load(userId);
  if (existing?.enabled) throw Object.assign(new Error('Two-step confirmation is already on. Turn it off first to set it up again.'), { statusCode: 409 });
  const secret = generateTotpSecret();
  await sharedDb().query(
    `INSERT INTO "userTotp" ("userId", "secretEnc", "enabled", "lastStep", "recoveryJson", "createdAt") VALUES ($1, $2, false, 0, '[]', $3)
     ON CONFLICT ("userId") DO UPDATE SET "secretEnc" = $2, "enabled" = false, "lastStep" = 0, "recoveryJson" = '[]'`,
    [userId, encrypt(secret, context(userId)), new Date().toISOString()],
  );
  return { secret, uri: otpauthUri(secret, accountLabel) };
}

function newRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Turns it on once a correct code proves the app works. Returns the recovery codes, to be shown once. */
export async function enableTotp(userId: string, code: string, nowMs = Date.now()): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; message: string }> {
  const row = await load(userId);
  if (!row) return { ok: false, message: 'Start the setup first.' };
  if (row.enabled) return { ok: false, message: 'Two-step confirmation is already on.' };
  const step = verifyTotp(decrypt(row.secretEnc, context(userId)), code, nowMs, row.lastStep);
  if (step === null) return { ok: false, message: 'That code is not right. Check the 6-digit code in your authenticator app (it changes every 30 seconds).' };
  const codes = newRecoveryCodes();
  await sharedDb().query(`UPDATE "userTotp" SET "enabled" = true, "lastStep" = $2, "recoveryJson" = $3 WHERE "userId" = $1`, [userId, step, JSON.stringify(codes.map(hashRecovery))]);
  return { ok: true, recoveryCodes: codes };
}

/**
 * Checks a code for confirming something: the 6-digit app code, or one of the recovery codes (each works once). A used app code
 * cannot be used again, even within its 30 seconds.
 */
export async function verifyTotpCode(userId: string, typed: string, nowMs = Date.now()): Promise<boolean> {
  const row = await load(userId);
  if (!row?.enabled) return false;
  const step = verifyTotp(decrypt(row.secretEnc, context(userId)), typed, nowMs, row.lastStep);
  if (step !== null) {
    // The guard makes it race-safe: if another request used this step first, nothing is updated and this one fails.
    const r = await sharedDb().query(`UPDATE "userTotp" SET "lastStep" = $2 WHERE "userId" = $1 AND "lastStep" < $2 RETURNING "userId"`, [userId, step]);
    return r.rows.length > 0;
  }
  const hash = hashRecovery(typed);
  const left = JSON.parse(row.recoveryJson) as string[];
  if (!left.includes(hash)) return false;
  const r = await sharedDb().query(`UPDATE "userTotp" SET "recoveryJson" = $3 WHERE "userId" = $1 AND "recoveryJson" = $2 RETURNING "userId"`, [userId, row.recoveryJson, JSON.stringify(left.filter((h) => h !== hash))]);
  return r.rows.length > 0;
}

export async function disableTotp(userId: string): Promise<void> {
  await sharedDb().query(`DELETE FROM "userTotp" WHERE "userId" = $1`, [userId]);
}
