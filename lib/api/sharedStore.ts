/**
 * Access to the shared (database-backed) store used for state that every server instance must agree on: rate-limit counters
 * and revoked sessions.
 *
 * Why not the Prisma client: these are hot-path, single-statement operations (an atomic upsert on every rate-limited request),
 * so they go through a small connection pool of their own instead of opening a connection per call.
 *
 * When it is used:
 *   CLOUDCRAFT_SHARED_STORE=db      always (needs DATABASE_URL)
 *   CLOUDCRAFT_SHARED_STORE=memory  never (single-instance deployments, local development)
 *   unset                           in production, yes; in development and tests, no
 * If the database cannot be reached, callers fall back to their in-process behaviour and log the problem — a database outage
 * must not take the API down (and must not make every limit unlimited).
 */
import { Pool } from 'pg';

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The database's clock in epoch milliseconds, stable within one statement. All shared timing uses it, so servers with drifting clocks still agree. */
export const NOW_MS = '(extract(epoch from now()) * 1000)';

declare global {
  var __cloudcraft_shared_pool__: Pool | undefined;
}

let override: Queryable | null = null;

/** Tests inject a fake database here; pass null to restore. */
export function _setSharedDbForTests(q: Queryable | null): void { override = q; }

export function sharedStoreEnabled(): boolean {
  if (override) return true;
  const mode = process.env['CLOUDCRAFT_SHARED_STORE'];
  if (mode === 'memory') return false;
  if (!process.env['DATABASE_URL']) return false;
  if (mode === 'db') return true;
  return process.env['NODE_ENV'] === 'production';
}

export function sharedDb(): Queryable {
  if (override) return override;
  if (!global.__cloudcraft_shared_pool__) {
    global.__cloudcraft_shared_pool__ = new Pool({ connectionString: process.env['DATABASE_URL'], max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 3_000 });
    // An idle client erroring (e.g. the server restarted) must not crash the process.
    global.__cloudcraft_shared_pool__.on('error', (err) => console.warn('[shared-store] idle connection error:', err.message));
  }
  return global.__cloudcraft_shared_pool__ as unknown as Queryable;
}

const lastWarn = new Map<string, number>();
/** One warning per minute per topic, so an outage does not flood the log (never logs SQL or parameters). */
export function warnSharedStore(topic: string, err: unknown): void {
  const now = Date.now();
  if ((lastWarn.get(topic) ?? 0) + 60_000 > now) return;
  lastWarn.set(topic, now);
  console.warn(`[shared-store] ${topic}: ${err instanceof Error ? err.message : String(err)} — using in-process state until the database is reachable`);
}
