/**
 * Cost Engine — shared types for Phase 2D cost estimation.
 */
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

// ─── Input ────────────────────────────────────────────────────────────────────

export interface CostEstimationInput {
  architectureId: string;
  projectId: string;
  versionId?: string;
  resources: DbArchitectureResource[];
  defaultRegion?: string;
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
}

export interface CostBreakdownItem {
  label: string;
  monthlyUsd: number;
}

// ─── Result ──────────────────────────────────────────────────────────────────

export interface CostEstimationResult {
  items: CostLineItem[];
  totalMonthlyUsd: number;
  totalHourlyUsd: number;
  currency: string;
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
