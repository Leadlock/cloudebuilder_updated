/**
 * CloudCraft — Cloud Provider Pricing Service
 *
 * Primary provider-independent pricing entry point.
 * Orchestrates AwsPricingProvider, AzurePricingProvider, and PricingCache.
 *
 * Guarantees:
 * 1. Normalized internal pricing models (USD, hourly & monthly).
 * 2. Caching to prevent redundant API queries.
 * 3. Graceful offline fallback with stale timestamps.
 * 4. Transparent error exposure ('Pricing unavailable') if uncached.
 */
import type { NormalizedPrice, PriceQuery, ICloudPricingProvider } from './types';
import { awsPricingProvider } from './AwsPricingProvider';
import { azurePricingProvider } from './AzurePricingProvider';
import { pricingCache, PricingCache } from './PricingCache';
import { classifyPricingSource } from './tiers';

export class CloudProviderPricingService {
  private _providers: Map<string, ICloudPricingProvider> = new Map();
  private _cache: PricingCache;

  constructor(cache: PricingCache = pricingCache, providers: ICloudPricingProvider[] = [awsPricingProvider, azurePricingProvider]) {
    this._cache = cache;
    for (const p of providers) this._providers.set(p.provider, p);
  }

  async getPrice(query: PriceQuery): Promise<NormalizedPrice> {
    const provider = this._providers.get(query.provider.toLowerCase());
    if (!provider) {
      return this._unsupportedPrice(query, `No provider registered for: ${query.provider}`);
    }

    const cacheKey = this._cache.makeCacheKey(query);
    // 1. Try fresh cache
    // Only official-API responses are cached, so a cache hit is always CACHED_LIVE.
    // (Entries written by older builds may hold fallback estimates — keep their tier.)
    const cached = this._cache.get(cacheKey, false);
    if (cached) {
      const t = classifyPricingSource(cached.source);
      return { ...cached, tier: t === 'LIVE' ? 'CACHED_LIVE' : t, isStale: false };
    }

    // 2. Query the provider (official API, or the provider's own static table if the API fails)
    let fallback: NormalizedPrice | null = null;
    try {
      const price = await provider.getPrice(query);
      if (price) {
        const tier = classifyPricingSource(price.source);
        if (tier === 'LIVE') {
          this._cache.set(cacheKey, price);
          return { ...price, tier, isStale: false };
        }
        // A fallback estimate is never cached (it would later be served as "cached"),
        // and a previously cached live price beats it.
        fallback = { ...price, tier, isStale: false };
      }
    } catch (err) {
      console.warn(`[CloudProviderPricingService] Provider lookup failed for ${query.resourceType}:`, err);
    }

    // 3. Stale cached live price (expired, but a real API value)
    const stale = this._cache.get(cacheKey, true);
    if (stale) {
      return { ...stale, tier: stale.tier ?? 'CACHED_LIVE', isStale: true };
    }
    if (fallback) return fallback;

    // 4. Graceful unavailable state — do NOT silently invent fake prices
    return this._unsupportedPrice(query, 'Pricing unavailable from official cloud provider API');
  }

  async batchGetPrices(queries: PriceQuery[]): Promise<Map<string, NormalizedPrice>> {
    const results = new Map<string, NormalizedPrice>();
    await Promise.all(
      queries.map(async (q) => {
        const key = `${q.provider}:${q.resourceType}:${q.region}`;
        const price = await this.getPrice(q);
        results.set(key, price);
      })
    );
    return results;
  }

  private _unsupportedPrice(query: PriceQuery, reason: string): NormalizedPrice {
    return {
      provider: query.provider,
      service: query.service || query.resourceType,
      resourceType: query.resourceType,
      region: query.region,
      sku: 'unknown',
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: 0,
      monthlyPrice: 0,
      currency: 'USD',
      description: reason,
      source: 'unavailable',
      tier: 'UNAVAILABLE',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      assumptions: [reason],
    };
  }
}

export const cloudProviderPricingService = new CloudProviderPricingService();
