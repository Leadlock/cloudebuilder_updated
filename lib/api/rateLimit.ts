/**
 * Rate limiting for expensive API routes (AI generation, cost/security/WA analysis, Terraform generation, auth attempts)
 * that have no cost to the caller but real compute/DB/third-party-API cost to us.
 *
 * Fixed-window counters, kept in one of two places:
 *  - the database (the shared store — see sharedStore.ts), so a limit is GLOBAL: every server instance counts against the
 *    same budget. Used in production by default.
 *  - this process's memory, for local development and single-instance setups, and as the fallback if the database is
 *    unreachable (a limit then applies per instance until it is back — degraded, never disabled).
 *
 * All functions are async because the shared store is; callers `await` them.
 */
import { NOW_MS, sharedDb, sharedStoreEnabled, warnSharedStore } from './sharedStore';

interface Bucket {
  count: number;
  windowStartMs: number;
}

const buckets = new Map<string, Bucket>();

// Periodically evict stale buckets so this Map doesn't grow unbounded across
// a long-running process with many distinct callers.
const MAX_BUCKETS = 50_000;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds?: number;
}

export interface RateLimitPeek { limit: number; remaining: number; used: number; resetsInSeconds: number }

// ─── In-process counters ──────────────────────────────────────────────────────────────────────

function memoryCheck(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now - existing.windowStartMs >= windowMs) {
    if (buckets.size >= MAX_BUCKETS) {
      // Defensive eviction: drop the oldest entries rather than growing unbounded.
      const oldest = [...buckets.entries()].sort((a, b) => a[1].windowStartMs - b[1].windowStartMs).slice(0, 1000);
      for (const [k] of oldest) buckets.delete(k);
    }
    buckets.set(key, { count: 1, windowStartMs: now });
    return { allowed: true, limit, remaining: limit - 1 };
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.ceil((existing.windowStartMs + windowMs - now) / 1000);
    return { allowed: false, limit, remaining: 0, retryAfterSeconds };
  }

  existing.count += 1;
  return { allowed: true, limit, remaining: limit - existing.count };
}

function memoryPeek(key: string, limit: number, windowMs: number): RateLimitPeek {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStartMs >= windowMs) return { limit, remaining: limit, used: 0, resetsInSeconds: 0 };
  return { limit, remaining: Math.max(0, limit - existing.count), used: existing.count, resetsInSeconds: Math.max(0, Math.ceil((existing.windowStartMs + windowMs - now) / 1000)) };
}

// ─── Shared (database) counters ───────────────────────────────────────────────────────────────

/**
 * One atomic statement: start a new window if the old one is over, otherwise add one. Every SET expression reads the row as it
 * was before this statement, and NOW_MS is the same value throughout it, so concurrent callers on different servers can
 * neither lose a count nor double-reset a window.
 */
export const HIT_SQL = `
INSERT INTO "rateLimitBucket" ("key", "count", "windowStartMs", "expiresAtMs")
VALUES ($1, 1, ${NOW_MS}, ${NOW_MS} + $2::double precision)
ON CONFLICT ("key") DO UPDATE SET
  "count" = CASE WHEN "rateLimitBucket"."windowStartMs" + $2::double precision <= ${NOW_MS} THEN 1 ELSE "rateLimitBucket"."count" + 1 END,
  "expiresAtMs" = CASE WHEN "rateLimitBucket"."windowStartMs" + $2::double precision <= ${NOW_MS} THEN ${NOW_MS} + $2::double precision ELSE "rateLimitBucket"."expiresAtMs" END,
  "windowStartMs" = CASE WHEN "rateLimitBucket"."windowStartMs" + $2::double precision <= ${NOW_MS} THEN ${NOW_MS} ELSE "rateLimitBucket"."windowStartMs" END
RETURNING "count", "windowStartMs", ${NOW_MS} AS "nowMs"`;

const num = (v: unknown): number => Number(v);

async function sharedCheck(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const { rows } = await sharedDb().query(HIT_SQL, [key, windowMs]);
  const row = rows[0];
  if (!row) throw new Error('rate-limit upsert returned no row');
  const count = num(row['count']);
  // Now and then, remove buckets whose window is long over (cheap, indexed, and never blocks the request).
  if (Math.random() < 0.01) void sharedDb().query(`DELETE FROM "rateLimitBucket" WHERE "expiresAtMs" < ${NOW_MS}`).catch(() => undefined);
  if (count > limit) {
    return { allowed: false, limit, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((num(row['windowStartMs']) + windowMs - num(row['nowMs'])) / 1000)) };
  }
  return { allowed: true, limit, remaining: limit - count };
}

async function sharedPeek(key: string, limit: number, windowMs: number): Promise<RateLimitPeek> {
  const { rows } = await sharedDb().query(`SELECT "count", "windowStartMs", ${NOW_MS} AS "nowMs" FROM "rateLimitBucket" WHERE "key" = $1`, [key]);
  const row = rows[0];
  if (!row || num(row['nowMs']) - num(row['windowStartMs']) >= windowMs) return { limit, remaining: limit, used: 0, resetsInSeconds: 0 };
  const used = num(row['count']);
  return { limit, remaining: Math.max(0, limit - used), used, resetsInSeconds: Math.max(0, Math.ceil((num(row['windowStartMs']) + windowMs - num(row['nowMs'])) / 1000)) };
}

// ─── Public API ───────────────────────────────────────────────────────────────────────────────

/**
 * Fixed-window rate limit check (window starts at the first request, resets on expiry).
 * `key` should uniquely identify the caller for this route (e.g. `${userId}:ai-generate`).
 */
export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  // This instance always counts what it sees, even when the database is in charge. If the database then cannot be reached
  // (say, a burst of requests exhausts the connection pool), the fallback carries on from the real local count instead of
  // starting again from zero — otherwise a burst, exactly when limiting matters, would hand out a second budget.
  const local = memoryCheck(key, limit, windowMs);
  if (sharedStoreEnabled()) {
    try { return await sharedCheck(key, limit, windowMs); } catch (err) { warnSharedStore('rate limit', err); }
  }
  return local;
}

/** Forgets a caller's counter, e.g. after a successful login clears earlier failed attempts. */
export async function resetRateLimit(key: string): Promise<void> {
  buckets.delete(key);
  if (sharedStoreEnabled()) {
    try { await sharedDb().query('DELETE FROM "rateLimitBucket" WHERE "key" = $1', [key]); } catch (err) { warnSharedStore('rate limit reset', err); }
  }
}

/**
 * Reads a caller's budget WITHOUT using any of it — for showing "N left, renews in M" in the UI.
 * Mirrors checkRateLimit's window rules exactly.
 */
export async function peekRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitPeek> {
  if (sharedStoreEnabled()) {
    try { return await sharedPeek(key, limit, windowMs); } catch (err) { warnSharedStore('rate limit read', err); }
  }
  return memoryPeek(key, limit, windowMs);
}

/** Common presets for route-level limits, per caller. */
export const RATE_LIMITS = {
  /** LLM calls are the most expensive — tightest limit. */
  AI_GENERATE: { limit: 10, windowMs: 60_000 },
  /** Analysis engines (cost, security, WA, advisor, terraform) — CPU/DB bound, not $-per-call, looser limit. */
  ANALYSIS: { limit: 30, windowMs: 60_000 },
} as const;
