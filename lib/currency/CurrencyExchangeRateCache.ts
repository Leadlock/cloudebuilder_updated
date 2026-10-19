/**
 * CloudBuilder — Multi-Tier Currency Exchange Rate Cache
 *
 * Implements:
 * 1. Fast in-memory map (<1ms hits)
 * 2. Disk persistence in .cache/currency/rates_cache.json
 * 3. PostgreSQL database cache table persistence (graceful fallback if offline)
 * 4. Stale-while-revalidate & graceful offline fallback with timestamps
 */
import fs from 'fs';
import path from 'path';
import type { ExchangeRateResult } from './types';

export const DEFAULT_EXCHANGE_RATE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export class CurrencyExchangeRateCache {
  private _memoryCache: Map<string, ExchangeRateResult> = new Map();
  private _storagePath: string | null = null;
  private _initialized = false;
  private _ttlMs: number;
  private _persistToDisk: boolean;

  constructor(ttlMs: number = DEFAULT_EXCHANGE_RATE_TTL_MS, persistToDisk: boolean = true) {
    this._ttlMs = ttlMs;
    this._persistToDisk = persistToDisk;
    if (this._persistToDisk) {
      this._initStorage();
    }
  }

  private _initStorage() {
    if (!this._persistToDisk) return;
    if (this._initialized) return;
    this._initialized = true;

    try {
      const baseDir = process.cwd();
      const dir = path.join(baseDir, '.cache', 'currency');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this._storagePath = path.join(dir, 'rates_cache.json');
      if (fs.existsSync(this._storagePath)) {
        const raw = fs.readFileSync(this._storagePath, 'utf8');
        const data = JSON.parse(raw) as Record<string, ExchangeRateResult>;
        for (const [k, v] of Object.entries(data)) {
          this._memoryCache.set(k.toUpperCase(), v);
        }
      }
    } catch {
      this._storagePath = null;
    }
  }

  makeKey(from: string, to: string): string {
    return `${from.trim().toUpperCase()}:${to.trim().toUpperCase()}`;
  }

  /**
   * Retrieves a cached rate.
   * If fresh, returns with isCached: true.
   * If expired and allowStale is true, returns with isCached: true and isStale: true.
   */
  get(from: string, to: string, allowStale = true): ExchangeRateResult | null {
    this._initStorage();
    const key = this.makeKey(from, to);
    const item = this._memoryCache.get(key);
    if (!item) return null;

    const isExpired = Date.now() > new Date(item.expiresAt).getTime();
    if (!isExpired) {
      return {
        ...item,
        isCached: true,
        isStale: false,
      };
    }

    if (allowStale) {
      return {
        ...item,
        isCached: true,
        isStale: true,
        source: `${item.source} (cached stale from ${new Date(item.retrievedAt).toISOString()})`,
      };
    }

    return null;
  }

  async set(result: ExchangeRateResult): Promise<void> {
    this._initStorage();
    const key = this.makeKey(result.fromCurrency, result.toCurrency);
    const now = new Date();
    const expiresAt = result.expiresAt || new Date(now.getTime() + this._ttlMs).toISOString();

    const entry: ExchangeRateResult = {
      ...result,
      fromCurrency: result.fromCurrency.toUpperCase(),
      toCurrency: result.toCurrency.toUpperCase(),
      retrievedAt: result.retrievedAt || now.toISOString(),
      expiresAt,
      isCached: false,
      isStale: false,
    };

    this._memoryCache.set(key, entry);
    this._persist();

    // Asynchronously save to PostgreSQL if accessible
    try {
      const { db } = await import('@/src/prisma/db');
      if (db && db.orm && (db.orm as any).public?.CurrencyExchangeRate) {
        const id = `${entry.fromCurrency}_${entry.toCurrency}`;
        await (db.orm as any).public.CurrencyExchangeRate.upsert({
          where: {
            baseCurrency_targetCurrency: {
              baseCurrency: entry.fromCurrency,
              targetCurrency: entry.toCurrency,
            },
          },
          update: {
            rate: entry.rate,
            source: entry.source,
            retrievedAt: entry.retrievedAt,
            expiresAt: entry.expiresAt,
          },
          create: {
            id,
            baseCurrency: entry.fromCurrency,
            targetCurrency: entry.toCurrency,
            rate: entry.rate,
            source: entry.source,
            retrievedAt: entry.retrievedAt,
            expiresAt: entry.expiresAt,
          },
        }).catch(() => {});
      }
    } catch {
      // Graceful offline fallback
    }
  }

  has(from: string, to: string): boolean {
    this._initStorage();
    return this._memoryCache.has(this.makeKey(from, to));
  }

  clear(): void {
    this._memoryCache.clear();
    this._persist();
  }

  private _persist(): void {
    if (!this._storagePath) return;
    try {
      const obj = Object.fromEntries(this._memoryCache.entries());
      fs.writeFileSync(this._storagePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch {
      // Memory fallback
    }
  }
}

export const currencyExchangeRateCache = new CurrencyExchangeRateCache();
