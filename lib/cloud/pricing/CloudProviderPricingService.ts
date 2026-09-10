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

export class CloudProviderPricingService {
  private _providers: Map<string, ICloudPricingProvider> = new Map();
  private _cache: PricingCache;

  constructor(cache: PricingCache = pricingCache) {
    this._cache = cache;
    this._providers.set('aws', awsPricingProvider);
    this._providers.set('azure', azurePricingProvider);
  }

  async getPrice(query: PriceQuery): Promise<NormalizedPrice> {
    const provider = this._providers.get(query.provider.toLowerCase());
    if (!provider) {
      return this._unsupportedPrice(query, `No provider registered for: ${query.provider}`);
    }

    const cacheKey = this._cache.makeCacheKey(query);
    // 1. Try fresh cache
    const cached = this._cache.get(cacheKey, false);
    if (cached) {
      return cached;
    }

    // 2. Query live provider
    try {
      const price = await provider.getPrice(query);
      if (price) {
        this._cache.set(cacheKey, price);
        return price;
      }
    } catch (err) {
      console.warn(`[CloudProviderPricingService] Provider lookup failed for ${query.resourceType}:`, err);
    }

    // 3. Fallback to stale cache if available
    const stale = this._cache.get(cacheKey, true);
    if (stale) {
      return stale;
    }

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
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      assumptions: [reason],
    };
  }
}

export const cloudProviderPricingService = new CloudProviderPricingService();
