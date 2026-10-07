/**
 * CloudCraft — Multi-Tier Cloud Pricing Cache
 *
 * Implements:
 * 1. In-memory fast cache (LRU-style map for <1ms hits)
 * 2. Disk persistence in .next/cache/pricing or local cache file
 * 3. Stale-while-revalidate & graceful offline fallback
 * 4. Clear last-updated and expiration metadata
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { NormalizedPrice, PriceQuery } from './types';
import { classifyPricingSource } from './tiers';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Raise this number whenever a pricing fix changes what a saved price should be. Keys carry it, so every price saved by older code is
 * ignored and dropped on the next load instead of being shown for up to 24 hours after the fix (an Azure Redis cache was shown at
 * double its price this way). Version 2 is the first with this prefix.
 */
export const PRICING_CACHE_VERSION = 3; // 3: keys cover every setting that can change a price (before, a node type or task size was not in the key)
const KEY_PREFIX = `v${PRICING_CACHE_VERSION}:`;

/** Settings that name or describe a resource but never change what it costs. */
const PRICE_IRRELEVANT_SETTINGS = new Set(['name', 'label', 'description', 'tags', 'id', 'containerImage', 'defaultRootObject', 'comment']);

/** An AI-matched price that lists the same meter line twice was added up twice (the old duplicate-meter bug), so it is wrong. */
function hasDoubleCountedMeter(v: NormalizedPrice): boolean {
  if (v.source !== 'azure-retail-api-ai-matched') return false;
  const meters = (v.assumptions ?? []).filter((l) => / per .+ × /.test(l));
  return new Set(meters).size < meters.length;
}

export class PricingCache {
  private _memoryCache: Map<string, NormalizedPrice> = new Map();
  private _storagePath: string | null = null;
  private _initialized = false;

  constructor() {
    this._initStorage();
  }

  private _initStorage() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      const baseDir = process.cwd();
      const dir = path.join(baseDir, '.cache', 'pricing');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this._storagePath = path.join(dir, 'pricing_cache.json');
      if (fs.existsSync(this._storagePath)) {
        const raw = fs.readFileSync(this._storagePath, 'utf8');
        const data = JSON.parse(raw) as Record<string, NormalizedPrice>;
        for (const [k, v] of Object.entries(data)) {
          if (!k.startsWith(KEY_PREFIX)) continue;     // saved by older pricing code
          if (hasDoubleCountedMeter(v)) continue; // saved before duplicate meters were counted once: price it again
          this._memoryCache.set(k, v);
        }
      }
    } catch {
      // In-memory fallback if filesystem access is restricted
      this._storagePath = null;
    }
  }

  makeCacheKey(query: PriceQuery): string {
    const { provider, resourceType, region, configuration } = query;
    // Extract key identifying attributes from configuration
    const sku = 
      (configuration['instanceType'] as string) ||
      (configuration['size'] as string) ||
      (configuration['instanceClass'] as string) ||
      (configuration['sku'] as string) ||
      (configuration['tier'] as string) ||
      'default';

    const extra = [
      configuration['multiAz'] ? 'multiAz' : '',
      configuration['engine'] ? String(configuration['engine']) : '',
      configuration['storageGb'] ? `st:${configuration['storageGb']}` : '',
    ].filter(Boolean).join('-');

    // Every setting that can change a price must change the key: a cache node type, a task size, a node count, a zone-redundancy switch.
    // Keying on a short list of fields served one resource's saved price to another that differed only in a field not on the list. A hash
    // of all plain settings (except ones that never affect a price) keeps the key short and exact; a setting that does not matter only
    // costs an extra fetch, never a wrong price.
    const settings = Object.entries(configuration)
      .filter(([k, v]) => !PRICE_IRRELEVANT_SETTINGS.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
      .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
      .sort()
      .join('|');
    const settingsHash = createHash('sha1').update(settings).digest('hex').slice(0, 10);

    return `${KEY_PREFIX}${provider.toLowerCase()}:${resourceType.toLowerCase()}:${region.toLowerCase()}:${sku.toLowerCase()}${extra ? `:${extra}` : ''}:${settingsHash}`;
  }

  get(key: string, allowStale = true): NormalizedPrice | null {
    this._initStorage();
    const item = this._memoryCache.get(key);
    if (!item) return null;

    const isExpired = Date.now() > new Date(item.expiresAt).getTime();
    if (!isExpired) {
      return item;
    }

    if (allowStale) {
      // Return stale item marked as cached; the tier is derived from the original source
      // before the display label is rewritten.
      const original = classifyPricingSource(item.source);
      return {
        ...item,
        source: `cached (stale from ${new Date(item.retrievedAt).toLocaleDateString()})`,
        tier: original === 'LIVE' ? 'CACHED_LIVE' : original,
        isStale: true,
      };
    }

    return null;
  }

  set(key: string, price: NormalizedPrice): void {
    this._initStorage();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CACHE_TTL_MS).toISOString();

    const entry: NormalizedPrice = {
      ...price,
      retrievedAt: price.retrievedAt || now.toISOString(),
      expiresAt: price.expiresAt || expiresAt,
    };

    this._memoryCache.set(key, entry);
    this._persist();
  }

  has(key: string): boolean {
    this._initStorage();
    return this._memoryCache.has(key);
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
      // Silently continue with memory cache
    }
  }
}

export const pricingCache = new PricingCache();
