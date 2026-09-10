/**
 * CostEstimator — orchestrates multi-cloud cost estimation for Phase 2D,
 * Real Pricing, and Multi-Currency with Live Exchange Rates.
 *
 * Source of truth: persisted ArchitectureResource rows.
 * Supports:
 * - REAL mode (default in production): queries live official Azure Retail Prices API & AWS Price List API with persistent caching.
 * - Multi-Currency: converts from base USD to user display currency using real exchange rates.
 * - Dual Pricing: preserves original provider USD price for transparency.
 * - TEST/MOCK mode: uses deterministic fixtures to preserve 100% backward compatibility for tests.
 */
import type { CostEstimationInput, CostEstimationResult, CostLineItem, ExchangeRateConversionMeta } from './types';
import { awsPricingProvider } from './awsPricing';
import { azurePricingProvider } from './azurePricing';
import type { PricingProvider } from './types';
import { cloudProviderPricingService } from '@/lib/cloud/pricing/CloudProviderPricingService';
import { currencyExchangeRateService } from '@/lib/currency/CurrencyExchangeRateService';

// ─── Provider registry ────────────────────────────────────────────────────────

const PROVIDERS: Record<string, PricingProvider> = {
  aws:   awsPricingProvider,
  azure: azurePricingProvider,
};

// ─── CostEstimator ────────────────────────────────────────────────────────────

export class CostEstimator {
  /**
   * Asynchronous estimation using the real CloudProviderPricingService and CurrencyExchangeRateService.
   * Preferred for server API routes.
   */
  async estimateAsync(
    input: CostEstimationInput,
    mode: 'REAL' | 'TEST' = 'REAL',
  ): Promise<CostEstimationResult> {
    if (mode === 'TEST') {
      return this.estimate(input, 'TEST');
    }

    const items: CostLineItem[] = [];
    const targetCurrency = (input.targetCurrency || 'USD').toUpperCase();

    for (const resource of input.resources) {
      const providerKey = resource.provider.toLowerCase();
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(resource.configJson) as Record<string, unknown>;
      } catch {
        config = {};
      }

      const region = resource.region ?? input.defaultRegion ?? this._defaultRegion(providerKey);

      if (providerKey !== 'aws' && providerKey !== 'azure') {
        items.push({
          resourceId: resource.id,
          resourceLabel: resource.label,
          resourceType: resource.resourceType,
          provider: resource.provider,
          region,
          hourlyUsd: 0,
          monthlyUsd: 0,
          providerPrice: {
            unitPrice: 0,
            monthlyPrice: 0,
            currency: 'USD',
            unit: '1 Hour',
          },
          breakdown: [],
          assumptions: [`No pricing provider for: ${resource.provider}`],
          pricingSource: 'none',
          confidence: 'unsupported',
        });
        continue;
      }

      // Check for non-billable containers/boundaries
      if (
        resource.resourceType === 'aws_vpc' ||
        resource.resourceType === 'aws_subnet' ||
        resource.resourceType === 'aws_igw' ||
        resource.resourceType === 'aws_sg' ||
        resource.resourceType === 'aws_route_table' ||
        resource.resourceType === 'azure_resource_group' ||
        resource.resourceType === 'azure_vnet' ||
        resource.resourceType === 'azure_subnet' ||
        resource.resourceType === 'azure_nsg'
      ) {
        continue;
      }

      try {
        const normalized = await cloudProviderPricingService.getPrice({
          provider: providerKey as 'aws' | 'azure',
          resourceType: resource.resourceType,
          region,
          configuration: config,
        });

        if (normalized && normalized.source !== 'unavailable') {
          items.push({
            resourceId: resource.id,
            resourceLabel: resource.label,
            resourceType: resource.resourceType,
            provider: providerKey,
            region,
            hourlyUsd: normalized.unitPrice,
            monthlyUsd: normalized.monthlyPrice,
            providerPrice: {
              unitPrice: normalized.unitPrice,
              monthlyPrice: normalized.monthlyPrice,
              currency: 'USD',
              unit: normalized.unit || '1 Hour',
            },
            breakdown: [
              {
                label: `${resource.label} (${normalized.sku})`,
                monthlyUsd: normalized.monthlyPrice,
              },
            ],
            assumptions: normalized.assumptions,
            pricingSource: normalized.source,
            confidence: 'estimate',
          });
        } else {
          // Fallback to provider sync estimation if available
          const syncProvider = PROVIDERS[providerKey];
          const syncItem = syncProvider ? syncProvider.estimateResource(resource, config, region) : null;
          if (syncItem) {
            items.push({
              ...syncItem,
              providerPrice: {
                unitPrice: syncItem.hourlyUsd,
                monthlyPrice: syncItem.monthlyUsd,
                currency: 'USD',
                unit: '1 Hour',
              },
            });
          } else {
            items.push({
              resourceId: resource.id,
              resourceLabel: resource.label,
              resourceType: resource.resourceType,
              provider: resource.provider,
              region,
              hourlyUsd: 0,
              monthlyUsd: 0,
              providerPrice: {
                unitPrice: 0,
                monthlyPrice: 0,
                currency: 'USD',
                unit: '1 Hour',
              },
              breakdown: [],
              assumptions: ['Pricing unavailable from official cloud provider API'],
              pricingSource: 'unavailable',
              confidence: 'unsupported',
            });
          }
        }
      } catch (err) {
        console.warn(`[CostEstimator] Real pricing error for ${resource.id}:`, err);
        const syncProvider = PROVIDERS[providerKey];
        const syncItem = syncProvider ? syncProvider.estimateResource(resource, config, region) : null;
        if (syncItem) {
          items.push({
            ...syncItem,
            providerPrice: {
              unitPrice: syncItem.hourlyUsd,
              monthlyPrice: syncItem.monthlyUsd,
              currency: 'USD',
              unit: '1 Hour',
            },
          });
        }
      }
    }

    return this._applyCurrencyConversion(items, targetCurrency);
  }

  /**
   * Synchronous estimation method (fully compatible with existing tests and fixtures).
   */
  estimate(
    input: CostEstimationInput,
    _mode: 'REAL' | 'TEST' = 'REAL',
  ): CostEstimationResult {
    const items: CostLineItem[] = [];

    for (const resource of input.resources) {
      const provider = PROVIDERS[resource.provider];
      if (!provider) {
        items.push({
          resourceId: resource.id,
          resourceLabel: resource.label,
          resourceType: resource.resourceType,
          provider: resource.provider,
          region: resource.region ?? input.defaultRegion ?? 'unknown',
          hourlyUsd: 0,
          monthlyUsd: 0,
          providerPrice: {
            unitPrice: 0,
            monthlyPrice: 0,
            currency: 'USD',
            unit: '1 Hour',
          },
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
        items.push({
          ...item,
          providerPrice: {
            unitPrice: item.hourlyUsd,
            monthlyPrice: item.monthlyUsd,
            currency: 'USD',
            unit: '1 Hour',
          },
        });
      }
    }

    return this._compileResult(items, 'USD');
  }

  private async _applyCurrencyConversion(
    items: CostLineItem[],
    targetCurrency: string
  ): Promise<CostEstimationResult> {
    if (targetCurrency === 'USD') {
      return this._compileResult(items, 'USD');
    }

    // Retrieve real exchange rate
    const rateResult = await currencyExchangeRateService.getExchangeRate({
      from: 'USD',
      to: targetCurrency,
    });

    if (!rateResult) {
      // Exchange rate unavailable — NEVER invent a fake rate!
      const res = this._compileResult(items, 'USD');
      res.assumptions.unshift(`Exchange rate unavailable for ${targetCurrency}. Showing provider pricing in USD.`);
      return res;
    }

    const { rate, source, retrievedAt, isCached, isStale } = rateResult;

    // Convert each line item
    for (const item of items) {
      const unitConverted = item.hourlyUsd * rate;
      const monthlyConverted = item.monthlyUsd * rate;

      item.convertedPrice = {
        unitPrice: unitConverted,
        monthlyPrice: monthlyConverted,
        currency: targetCurrency,
        exchangeRate: rate,
        exchangeRateSource: source,
        exchangeRateRetrievedAt: retrievedAt,
        isCachedRate: isCached,
        isStaleRate: isStale,
      };

      item.breakdown = item.breakdown.map((b) => ({
        ...b,
        monthlyConverted: b.monthlyUsd * rate,
        currency: targetCurrency,
      }));
    }

    const conversionMeta: ExchangeRateConversionMeta = {
      fromCurrency: 'USD',
      toCurrency: targetCurrency,
      rate,
      source,
      retrievedAt,
      isCached: isCached ?? false,
      isStale: isStale ?? false,
    };

    return this._compileResult(items, targetCurrency, conversionMeta);
  }

  private _compileResult(
    items: CostLineItem[],
    currency: string = 'USD',
    exchangeRateMeta?: ExchangeRateConversionMeta
  ): CostEstimationResult {
    const billableItems = items.filter((i) => i.confidence !== 'unsupported');
    const totalMonthlyUsd = billableItems.reduce((s, i) => s + i.monthlyUsd, 0);
    const totalHourlyUsd  = billableItems.reduce((s, i) => s + i.hourlyUsd,  0);

    const rate = exchangeRateMeta?.rate ?? 1.0;
    const totalMonthlyConverted = currency === 'USD' ? totalMonthlyUsd : totalMonthlyUsd * rate;
    const totalHourlyConverted  = currency === 'USD' ? totalHourlyUsd  : totalHourlyUsd  * rate;

    const globalAssumptions = [
      'Official list prices sourced from AWS Price List API and Microsoft Azure Retail Prices API in USD.',
      'All prices reflect Pay-As-You-Go / on-demand list pricing without reservations or enterprise discount agreements.',
      'Monthly estimates assume standard 730 hours/month operation unless specified otherwise.',
      'Actual AWS/Azure invoices may vary based on data transfer egress and specific usage metrics.',
    ];

    if (currency !== 'USD' && exchangeRateMeta) {
      const cacheNote = exchangeRateMeta.isCached
        ? ` (cached from ${new Date(exchangeRateMeta.retrievedAt).toLocaleDateString()})`
        : '';
      globalAssumptions.unshift(
        `Currency converted from USD to ${currency} at 1 USD = ${rate.toFixed(4)} ${currency} via ${exchangeRateMeta.source}${cacheNote}.`
      );
    }

    return {
      items,
      totalMonthlyUsd,
      totalHourlyUsd,
      currency,
      totalMonthlyConverted,
      totalHourlyConverted,
      exchangeRateMeta,
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
