/**
 * Rate limiting for expensive API routes (AI generation, cost/security/WA
 * analysis, Terraform generation) that have no cost to the caller but real
 * compute/DB/third-party-API cost to us.
 *
 * LIMITATION (documented, not hidden): this is an in-process sliding-window
 * counter, the same durability tier as the existing canvas-save revision
 * counter (see draftRepository.ts / canvas/route.ts). It protects a single
 * server instance from a runaway client or script, but a horizontally-scaled
 * or serverless deployment with N instances effectively multiplies each
 * caller's budget by N, since each instance counts independently. A
 * production deployment that actually scales out needs a shared store
 * (Redis, or a DB-backed counter) for a real global limit — this is a
 * best-effort mitigation for the common single-instance/dev/small-deployment
 * case, not a claim of distributed correctness.
 */

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

/**
 * Sliding-window-ish (fixed-window, reset on expiry) rate limit check.
 * `key` should uniquely identify the caller for this route (e.g. `${userId}:ai-generate`).
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
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

/** Forgets a caller's counter, e.g. after a successful login clears earlier failed attempts. */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/**
 * Reads a caller's budget WITHOUT using any of it — for showing "N left, renews in M" in the UI.
 * Mirrors checkRateLimit's window rules exactly.
 */
export function peekRateLimit(key: string, limit: number, windowMs: number): { limit: number; remaining: number; used: number; resetsInSeconds: number } {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStartMs >= windowMs) return { limit, remaining: limit, used: 0, resetsInSeconds: 0 };
  return { limit, remaining: Math.max(0, limit - existing.count), used: existing.count, resetsInSeconds: Math.max(0, Math.ceil((existing.windowStartMs + windowMs - now) / 1000)) };
}

/** Common presets for route-level limits, per caller. */
export const RATE_LIMITS = {
  /** LLM calls are the most expensive — tightest limit. */
  AI_GENERATE: { limit: 10, windowMs: 60_000 },
  /** Analysis engines (cost, security, WA, advisor, terraform) — CPU/DB bound, not $-per-call, looser limit. */
  ANALYSIS: { limit: 30, windowMs: 60_000 },
} as const;
