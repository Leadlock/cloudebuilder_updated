/**
 * Cost Engine — shared types for Phase 2D cost estimation and multi-currency pricing.
 */
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

// ─── Currency / Price Info ───────────────────────────────────────────────────

export interface ProviderPriceInfo {
  unitPrice: number;
  monthlyPrice: number;
  currency: string;
  unit?: string;
}

export interface ConvertedPriceInfo {
  unitPrice: number;
  monthlyPrice: number;
  currency: string;
  exchangeRate: number;
  exchangeRateSource: string;
  exchangeRateRetrievedAt: string;
  isCachedRate?: boolean;
  isStaleRate?: boolean;
}

export interface ExchangeRateConversionMeta {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  source: string;
  retrievedAt: string;
  isCached: boolean;
  isStale?: boolean;
}

// ─── Input ────────────────────────────────────────────────────────────────────

export interface CostEstimationInput {
  architectureId: string;
  projectId: string;
  versionId?: string;
  resources: DbArchitectureResource[];
  defaultRegion?: string;
  targetCurrency?: string; // e.g. 'USD', 'INR', 'EUR', 'GBP', etc.
}

// ─── Line item ───────────────────────────────────────────────────────────────

export interface CostLineItem {
  resourceId: string;
  resourceLabel: string;
  resourceType: string;
  provider: string;
  region: string;
  hourlyUsd: number;
  monthlyUsd: number;
  breakdown: CostBreakdownItem[];
  assumptions: string[];
  pricingSource: string;
  /** estimate | approximation | unsupported */
  confidence: string;

  // Real Multi-Currency fields
  providerPrice?: ProviderPriceInfo;
  convertedPrice?: ConvertedPriceInfo;
}

export interface CostBreakdownItem {
  label: string;
  monthlyUsd: number;
  monthlyConverted?: number;
  currency?: string;
}

// ─── Result ──────────────────────────────────────────────────────────────────

export interface CostEstimationResult {
  items: CostLineItem[];
  totalMonthlyUsd: number;
  totalHourlyUsd: number;
  currency: string; // Active display currency (default 'USD')
  totalMonthlyConverted?: number;
  totalHourlyConverted?: number;
  exchangeRateMeta?: ExchangeRateConversionMeta;
  assumptions: string[];
  pricingSource: string;
  confidence: string;
}

// ─── Provider interface ──────────────────────────────────────────────────────

export interface PricingProvider {
  readonly name: string;
  estimateResource(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
  ): CostLineItem | null;
}
