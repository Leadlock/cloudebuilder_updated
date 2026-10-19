/**
 * Pricing / exchange-rate data tiers.
 *
 * Every price and exchange rate shown to a user carries exactly one tier so the
 * UI and reports never present an estimate as a live figure:
 *  - LIVE:              returned by the official provider API in this request.
 *  - CACHED_LIVE:       a previously retrieved official API value served from cache
 *                       (`isStale` is true once past its expiry).
 *  - FALLBACK_ESTIMATE: CloudBuilder's static list-price tables or a computed baseline;
 *                       the official API was not queried or did not answer.
 *  - UNAVAILABLE:       no price or rate could be determined. Never shown as 0-cost.
 */
export type PricingTier = 'LIVE' | 'CACHED_LIVE' | 'FALLBACK_ESTIMATE' | 'UNAVAILABLE';

/** Source identifiers that are only ever set after a successful official API response. */
export const LIVE_PRICING_SOURCES = new Set([
  'aws-price-list-api', 'azure-retail-api',
  // Azure Retail Prices API rows whose meters were chosen by the AI meter picker (lib/cost/ai/meterPicker.ts); the price itself is the official one.
  'azure-retail-api-ai-matched',
]);

/**
 * Tier of a price as produced by a provider (before caching). Anything that is not a known
 * live source is a fallback estimate — an unknown source is never promoted to LIVE.
 */
export function classifyPricingSource(source: string | undefined | null): PricingTier {
  if (!source || source === 'unavailable' || source === 'none') return 'UNAVAILABLE';
  if (LIVE_PRICING_SOURCES.has(source)) return 'LIVE';
  return 'FALLBACK_ESTIMATE';
}

/**
 * Tier of an exchange rate. CurrencyExchangeRateService only returns rates from its
 * providers or its cache of them (it never invents a rate), so a rate is LIVE, CACHED_LIVE
 * or UNAVAILABLE. The identity rate (USD→USD) is exact and reported as LIVE.
 */
export function classifyRate(rate: { source: string; isCached?: boolean; isStale?: boolean } | null | undefined): PricingTier {
  if (!rate) return 'UNAVAILABLE';
  if (rate.source === 'identity') return 'LIVE';
  return rate.isCached || rate.isStale ? 'CACHED_LIVE' : 'LIVE';
}

export const PRICING_TIER_LABEL: Record<PricingTier, string> = {
  LIVE: 'Live',
  CACHED_LIVE: 'Cached live',
  FALLBACK_ESTIMATE: 'Fallback estimate',
  UNAVAILABLE: 'Unavailable',
};

/** The weakest tier across a set (used for totals): UNAVAILABLE < FALLBACK < CACHED < LIVE. */
export function weakestTier(tiers: PricingTier[]): PricingTier | null {
  const order: PricingTier[] = ['UNAVAILABLE', 'FALLBACK_ESTIMATE', 'CACHED_LIVE', 'LIVE'];
  if (tiers.length === 0) return null;
  return order.find((t) => tiers.includes(t)) ?? null;
}
