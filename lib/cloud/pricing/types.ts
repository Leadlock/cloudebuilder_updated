/**
 * CloudBuilder — Normalized Cloud Pricing Types
 *
 * Provider-independent pricing contract for AWS and Azure.
 * Standardizes official API outputs (Azure Retail Prices API, AWS Price List API)
 * into a single unified internal structure.
 */

import type { PricingTier } from './tiers';
export type { PricingTier } from './tiers';

export type PricingModel = 'on-demand' | 'consumption' | 'tier' | 'reservation' | 'free';

export interface NormalizedPrice {
  provider: 'aws' | 'azure';
  service: string;
  resourceType: string;
  region: string;
  sku: string;
  pricingModel: PricingModel;
  unit: string;
  unitPrice: number;       // Hourly or per-unit price in USD
  monthlyPrice: number;    // Normalized 730-hour or standard monthly estimate in USD
  currency: string;        // 'USD'
  description: string;
  source: string;          // e.g. 'azure-retail-api', 'aws-price-list-api', 'cached'
  retrievedAt: string;     // ISO timestamp of price retrieval
  expiresAt: string;       // ISO timestamp when cache entry expires
  assumptions: string[];
  /** Set by CloudProviderPricingService: where this figure actually came from. */
  tier?: PricingTier;
  /** True when served from cache after its expiry because the live API failed. */
  isStale?: boolean;
}

export interface PriceQuery {
  provider: 'aws' | 'azure';
  service?: string;
  resourceType: string;
  region: string;
  configuration: Record<string, unknown>;
}

export interface ICloudPricingProvider {
  readonly name: string;
  readonly provider: 'aws' | 'azure';
  getPrice(query: PriceQuery): Promise<NormalizedPrice | null>;
}
