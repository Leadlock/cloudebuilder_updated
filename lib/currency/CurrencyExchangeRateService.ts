/**
 * CloudCraft — Currency Exchange Rate Service
 *
 * Dedicated domain service providing real-time & cached multi-currency conversion rates.
 * Sourced from authoritative live Forex feeds with persistent multi-tier caching
 * and graceful fallback.
 *
 * Guarantees:
 * 1. Base currency default: USD (flexible for any base).
 * 2. Identity shortcut: USD -> USD rate is always exactly 1.0.
 * 3. Never invent fake conversion rates if external APIs fail and cache is empty.
 * 4. Transparent metadata: rate, source, retrievedAt, expiresAt, isCached, isStale.
 */
import type { ExchangeRateQuery, ExchangeRateResult } from './types';
import { BASE_CURRENCY } from './types';
import type { IExchangeRateProvider } from './providers/IExchangeRateProvider';
import { openErApiProvider } from './providers/OpenErApiProvider';
import { frankfurterProvider } from './providers/FrankfurterProvider';
import { CurrencyExchangeRateCache, currencyExchangeRateCache } from './CurrencyExchangeRateCache';

export class CurrencyExchangeRateService {
  private _providers: IExchangeRateProvider[] = [];
  private _cache: CurrencyExchangeRateCache;

  constructor(
    cache: CurrencyExchangeRateCache = currencyExchangeRateCache,
    providers: IExchangeRateProvider[] = [openErApiProvider, frankfurterProvider]
  ) {
    this._cache = cache;
    this._providers = providers;
  }

  /** Replace providers (e.g. for deterministic unit testing) */
  setProviders(providers: IExchangeRateProvider[]): void {
    this._providers = providers;
  }

  /**
   * Primary entry point to get exchange rate between two currencies.
   * e.g. getExchangeRate({ from: 'USD', to: 'INR' })
   */
  async getExchangeRate(query: ExchangeRateQuery): Promise<ExchangeRateResult | null> {
    const from = (query.from || BASE_CURRENCY).toUpperCase();
    const to = (query.to || BASE_CURRENCY).toUpperCase();

    // 1. Identity conversion shortcut (USD -> USD is 1.0)
    if (from === to) {
      const now = new Date().toISOString();
      return {
        fromCurrency: from,
        toCurrency: to,
        rate: 1.0,
        retrievedAt: now,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        source: 'identity',
        isCached: false,
        isStale: false,
      };
    }

    // 2. Check fresh cache
    const cached = this._cache.get(from, to, false);
    if (cached) {
      return cached;
    }

    // 3. Try live providers in order
    for (const provider of this._providers) {
      try {
        const liveResult = await provider.getRate(from, to);
        if (liveResult && typeof liveResult.rate === 'number' && liveResult.rate > 0) {
          await this._cache.set(liveResult);
          return {
            ...liveResult,
            isCached: false,
            isStale: false,
          };
        }
      } catch (err) {
        console.warn(`[CurrencyExchangeRateService] Provider ${provider.name} failed for ${from}->${to}:`, err);
      }
    }

    // 4. Stale fallback from cache if external APIs failed
    const stale = this._cache.get(from, to, true);
    if (stale) {
      return stale;
    }

    // 5. Explicit failure: do NOT invent a fake rate!
    return null;
  }

  /**
   * Convert an amount from one currency to another using real exchange rates.
   * Returns converted amount + original amount + conversion metadata.
   */
  async convertAmount(
    amount: number,
    from: string,
    to: string
  ): Promise<{
    originalAmount: number;
    originalCurrency: string;
    convertedAmount: number;
    targetCurrency: string;
    rate: number;
    source: string;
    retrievedAt: string;
    isCached: boolean;
    isStale: boolean;
  } | null> {
    const rateInfo = await this.getExchangeRate({ from, to });
    if (!rateInfo) return null;

    const convertedAmount = amount * rateInfo.rate;
    return {
      originalAmount: amount,
      originalCurrency: from.toUpperCase(),
      convertedAmount,
      targetCurrency: to.toUpperCase(),
      rate: rateInfo.rate,
      source: rateInfo.source,
      retrievedAt: rateInfo.retrievedAt,
      isCached: rateInfo.isCached ?? false,
      isStale: rateInfo.isStale ?? false,
    };
  }

  /**
   * Batch fetches rates for all supported target currencies against a base.
   */
  async getBatchRates(
    targets: string[],
    base: string = BASE_CURRENCY
  ): Promise<Map<string, ExchangeRateResult | null>> {
    const results = new Map<string, ExchangeRateResult | null>();
    await Promise.all(
      targets.map(async (target) => {
        const rate = await this.getExchangeRate({ from: base, to: target });
        results.set(target.toUpperCase(), rate);
      })
    );
    return results;
  }
}

export const currencyExchangeRateService = new CurrencyExchangeRateService();
