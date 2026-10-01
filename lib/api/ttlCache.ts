/**
 * A small in-process cache whose entries expire, with a size cap.
 *
 * Process-local on purpose (same tier as the rate limiter): it only saves work, so losing it on a restart or having one
 * copy per server instance costs nothing but a repeat computation. Never use it for anything that must be shared or exact.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 500, private readonly now: () => number = Date.now) {}

  get(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) { this.entries.delete(key); return undefined; }
    return e.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const t = this.now();
      for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
      // still full: drop the oldest entries (Map keeps insertion order)
      for (const k of this.entries.keys()) { if (this.entries.size < this.maxEntries) break; this.entries.delete(k); }
    }
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  delete(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}
