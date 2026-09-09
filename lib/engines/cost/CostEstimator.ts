/**
 * CostEstimator — orchestrates multi-cloud cost estimation for Phase 2D.
 *
 * Source of truth: persisted ArchitectureResource rows.
 * Delegates to provider-specific PricingProvider implementations.
 */
import type { CostEstimationInput, CostEstimationResult, CostLineItem } from './types';
import { awsPricingProvider } from './awsPricing';
import { azurePricingProvider } from './azurePricing';
import type { PricingProvider } from './types';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

// ─── Provider registry ────────────────────────────────────────────────────────

const PROVIDERS: Record<string, PricingProvider> = {
  aws:   awsPricingProvider,
  azure: azurePricingProvider,
};

// ─── CostEstimator ────────────────────────────────────────────────────────────

export class CostEstimator {
  estimate(input: CostEstimationInput): CostEstimationResult {
    const items: CostLineItem[] = [];

    for (const resource of input.resources) {
      const provider = PROVIDERS[resource.provider];
      if (!provider) {
        // Unknown provider — create an unsupported item so we surface the gap
        items.push({
          resourceId: resource.id,
          resourceLabel: resource.label,
          resourceType: resource.resourceType,
          provider: resource.provider,
          region: resource.region ?? input.defaultRegion ?? 'unknown',
          hourlyUsd: 0,
          monthlyUsd: 0,
          breakdown: [],
          assumptions: [`No pricing provider for: ${resource.provider}`],
          pricingSource: 'none',
          confidence: 'unsupported',
        });
        continue;
      }

      let config: Record<string, unknown>;
      try {
        config = JSON.parse(resource.configJson) as Record<string, unknown>;
      } catch {
        config = {};
      }

      const region = resource.region ?? input.defaultRegion ?? this._defaultRegion(resource.provider);
      const item = provider.estimateResource(resource, config, region);
      if (item !== null) {
        items.push(item);
      }
    }

    // Filter out unsupported (0-cost items with unsupported confidence don't contribute to total)
    const billableItems = items.filter((i) => i.confidence !== 'unsupported');
    const totalMonthlyUsd = billableItems.reduce((s, i) => s + i.monthlyUsd, 0);
    const totalHourlyUsd  = billableItems.reduce((s, i) => s + i.hourlyUsd,  0);

    const globalAssumptions = [
      'All prices are list prices (on-demand / Pay-As-You-Go). No reserved instance or savings plan discounts applied.',
      'Estimates do not include support charges, data transfer between regions, or third-party costs.',
      'Storage sizes and request counts use default assumptions where not specified in resource configuration.',
      'These are estimates only. Actual AWS/Azure invoices may differ.',
    ];

    return {
      items,
      totalMonthlyUsd,
      totalHourlyUsd,
      currency: 'USD',
      assumptions: globalAssumptions,
      pricingSource: this._combinedSource(items),
      confidence: 'estimate',
    };
  }

  private _defaultRegion(provider: string): string {
    return provider === 'azure' ? 'eastus' : 'us-east-1';
  }

  private _combinedSource(items: CostLineItem[]): string {
    const sources = [...new Set(items.map((i) => i.pricingSource).filter((s) => s !== 'none'))];
    return sources.length > 0 ? sources.join(', ') : 'static-list-price';
  }
}

export const costEstimator = new CostEstimator();
