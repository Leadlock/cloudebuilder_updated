/**
 * Shared list of signed-out sessions (the `revokedSession` table), so a logout or "sign out everywhere" on one server
 * instance takes effect on all of them.
 *
 * The session check (AuthService.getSession) is synchronous and sits on every request, so it keeps reading an in-memory copy.
 * This module is how that copy is kept in step with the database:
 *   - saveTokenRevocation / saveUserRevocation write a revocation through (the logout request awaits it);
 *   - pullRevocations reads what other instances have written since the last pull (only new rows, so a large list is not
 *     re-read every few seconds).
 * All times are the database clock's, so instances with drifting clocks agree on when something happened.
 */
import { NOW_MS, sharedDb } from './sharedStore';

export interface PulledRevocations {
  tokens: { id: string; expiresAtMs: number }[];
  users: { userId: string; revokedAtMs: number }[];
  /** The database's clock at the time of the read; pass (minus a little overlap) as `since` next time. */
  nowMs: number;
}

/** Re-read this much history on every pull, so a row committed just before the previous read is never missed. */
export const PULL_OVERLAP_MS = 5_000;

export async function saveTokenRevocation(tokenHash: string, expiresAtMs: number): Promise<void> {
  await sharedDb().query(
    `INSERT INTO "revokedSession" ("id", "kind", "userId", "revokedAtMs", "expiresAtMs")
     VALUES ($1, 'token', NULL, ${NOW_MS}, $2::double precision)
     ON CONFLICT ("id") DO NOTHING`,
    [tokenHash, expiresAtMs],
  );
}

/** "Every session issued up to now stops working." The row lives for as long as a session can (the token lifetime). */
export async function saveUserRevocation(userId: string, lifetimeMs: number): Promise<void> {
  await sharedDb().query(
    `INSERT INTO "revokedSession" ("id", "kind", "userId", "revokedAtMs", "expiresAtMs")
     VALUES ($1, 'user', $2, ${NOW_MS}, ${NOW_MS} + $3::double precision)
     ON CONFLICT ("id") DO UPDATE SET "revokedAtMs" = ${NOW_MS}, "expiresAtMs" = ${NOW_MS} + $3::double precision`,
    [`user:${userId}`, userId, lifetimeMs],
  );
}

export async function pullRevocations(sinceMs: number): Promise<PulledRevocations> {
  const { rows } = await sharedDb().query(
    `SELECT "id", "kind", "userId", "revokedAtMs", "expiresAtMs", ${NOW_MS} AS "nowMs"
     FROM "revokedSession" WHERE "revokedAtMs" >= $1::double precision AND "expiresAtMs" > ${NOW_MS}`,
    [sinceMs],
  );
  const out: PulledRevocations = { tokens: [], users: [], nowMs: rows.length ? Number(rows[0]!['nowMs']) : Number.NaN };
  for (const r of rows) {
    if (r['kind'] === 'user' && typeof r['userId'] === 'string') out.users.push({ userId: r['userId'], revokedAtMs: Number(r['revokedAtMs']) });
    else if (r['kind'] === 'token') out.tokens.push({ id: String(r['id']), expiresAtMs: Number(r['expiresAtMs']) });
  }
  // An empty result carries no clock reading; ask for it so the next pull still advances.
  if (Number.isNaN(out.nowMs)) {
    const t = await sharedDb().query(`SELECT ${NOW_MS} AS "nowMs"`);
    out.nowMs = Number(t.rows[0]!['nowMs']);
  }
  // Old rows are useless (the token could not be used any more); tidy them now and then, never blocking.
  if (Math.random() < 0.02) void sharedDb().query(`DELETE FROM "revokedSession" WHERE "expiresAtMs" < ${NOW_MS}`).catch(() => undefined);
  return out;
}
