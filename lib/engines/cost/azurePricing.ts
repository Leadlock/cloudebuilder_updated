/**
 * Azure Pricing Provider — Phase 2D
 *
 * IMPORTANT: This implementation uses Azure public list prices sourced from
 * the Azure Pricing Calculator and Azure documentation.
 *
 * LIMITATIONS:
 * - The Azure Retail Prices API (https://prices.azure.com/api/retail/prices) is
 *   publicly accessible without authentication and returns real-time pricing.
 *   However, making live HTTP requests per estimate would add latency and
 *   create external dependencies. Phase 2D uses static price tables instead.
 * - Prices are Pay-As-You-Go East US list prices as of late 2024.
 * - Actual Azure bills may differ due to Azure Hybrid Benefit, reservations,
 *   enterprise agreements, support plans, or Azure dev/test pricing.
 */

import type { PricingProvider, CostLineItem } from './types';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

// ─── Static price tables (USD/hour, Pay-As-You-Go, East US base) ─────────────

/** Azure VM hourly prices (Linux, eastus) — Azure public list price */
const VM_HOURLY_USD: Record<string, number> = {
  // B-series (burstable)
  'Standard_B1s':    0.0104,
  'Standard_B1ms':   0.0207,
  'Standard_B2s':    0.0416,
  'Standard_B2ms':   0.0832,
  'Standard_B4ms':   0.1660,
  // D-series v3
  'Standard_D2s_v3': 0.096,
  'Standard_D4s_v3': 0.192,
  'Standard_D8s_v3': 0.384,
  // E-series v3 (memory optimised)
  'Standard_E2s_v3': 0.1260,
  'Standard_E4s_v3': 0.2520,
  // F-series (compute optimised)
  'Standard_F2s_v2': 0.085,
  'Standard_F4s_v2': 0.169,
};

/** Azure SQL Database pricing (General Purpose, per vCore hour) */
const SQL_HOURLY_PER_VCORE: Record<string, number> = {
  'GP_Gen5':    0.1230, // General Purpose Gen 5 per vCore
  'BC_Gen5':    0.5560, // Business Critical Gen 5 per vCore
  'Standard':   0.002,  // DTU Standard per DTU
  'Premium':    0.0125, // DTU Premium per DTU
};

/** Regional multipliers for Azure relative to eastus */
const REGION_MULTIPLIER: Record<string, number> = {
  'eastus':       1.00,
  'eastus2':      1.00,
  'westus':       1.05,
  'westeurope':   1.08,
  'northeurope':  1.08,
  'southeastasia':1.12,
};

function regionMultiplier(region: string): number {
  return REGION_MULTIPLIER[region] ?? 1.10;
}

function toMonthly(hourly: number): number {
  return hourly * 730;
}

// ─── Azure Pricing Provider ───────────────────────────────────────────────────

export class AzurePricingProvider implements PricingProvider {
  readonly name = 'azure-static-list-price';

  estimateResource(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
  ): CostLineItem | null {
    const mult = regionMultiplier(region);

    switch (resource.resourceType) {
      case 'azure_vm':              return this._vm(resource, config, region, mult);
      case 'azure_sql':             return this._sql(resource, config, region, mult);
      case 'azure_storage':         return this._storage(resource, config, region, mult);
      case 'azure_lb':              return this._lb(resource, config, region, mult);
      case 'azure_resource_group':
      case 'azure_vnet':
      case 'azure_subnet':
      case 'azure_nsg':
        return null; // No direct charges
      default:
        return this._unknown(resource, region);
    }
  }

  private _vm(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const size = (config['size'] as string) ?? 'Standard_B2s';
    const baseHourly = VM_HOURLY_USD[size] ?? VM_HOURLY_USD['Standard_B2s']!;
    const hourly = baseHourly * mult;
    const monthly = toMonthly(hourly);
    const diskGb = (config['osDiskGb'] as number) ?? 128;
    const diskMonthly = diskGb * 0.10; // Premium SSD P10 ~$0.10/GB/mo

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly + diskMonthly,
      breakdown: [
        { label: `Azure VM ${size} (Pay-As-You-Go, Linux)`, monthlyUsd: monthly },
        { label: `OS Disk Premium SSD (${diskGb}GB)`, monthlyUsd: diskMonthly },
      ],
      assumptions: [
        'Pay-As-You-Go, Linux OS',
        `${diskGb}GB Premium SSD OS disk assumed`,
        'No data transfer charges included',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-vm-payg-list-price',
      confidence: 'estimate',
    };
  }

  private _sql(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const tier = (config['tier'] as string) ?? 'S0';
    const maxSizeGb = (config['maxSizeGb'] as number) ?? 250;
    // Standard tier: DTU-based pricing
    const dtu = this._dtuFromTier(tier);
    const dtuHourly = (SQL_HOURLY_PER_VCORE['Standard'] ?? 0.002) * dtu;
    const hourly = dtuHourly * mult;
    const monthly = toMonthly(hourly);
    const storageMonthly = (maxSizeGb * 0.122) * mult; // ~$0.122/GB/mo included in max

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly + storageMonthly,
      breakdown: [
        { label: `Azure SQL Standard ${tier} (${dtu} DTUs)`, monthlyUsd: monthly },
        { label: `Max storage (${maxSizeGb}GB)`, monthlyUsd: storageMonthly },
      ],
      assumptions: [
        `Standard tier, ${tier} (${dtu} DTUs)`,
        `${maxSizeGb}GB max storage`,
        'Backup storage not included',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-sql-dtu-list-price',
      confidence: 'estimate',
    };
  }

  private _dtuFromTier(tier: string): number {
    const map: Record<string, number> = {
      'S0': 10, 'S1': 20, 'S2': 50, 'S3': 100, 'S4': 200,
      'P1': 125, 'P2': 250, 'P4': 500, 'P6': 1000, 'P11': 1750,
    };
    return map[tier] ?? 10;
  }

  private _storage(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const sku = (config['sku'] as string) ?? 'Standard_LRS';
    const capacityGb = (config['estimatedCapacityGb'] as number) ?? 100;
    // Standard LRS blob storage: ~$0.018/GB/mo
    const pricePerGb = sku.includes('GRS') ? 0.036 : 0.018;
    const monthly = capacityGb * pricePerGb * mult;

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: `Azure Blob Storage ${sku} (${capacityGb}GB)`, monthlyUsd: monthly },
      ],
      assumptions: [
        `${capacityGb}GB storage assumed (set estimatedCapacityGb to override)`,
        `SKU: ${sku}`,
        'Transactions and data egress not included',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-storage-blob-list-price',
      confidence: 'estimate',
    };
  }

  private _lb(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const sku = (config['sku'] as string) ?? 'Standard';
    const hourly = (sku === 'Standard' ? 0.005 : 0.008) * mult;
    const rulesMonthly = 5 * mult; // 5 rules × $0.008 each

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly,
      monthlyUsd: toMonthly(hourly) + rulesMonthly,
      breakdown: [
        { label: `Azure Load Balancer ${sku} (hourly)`, monthlyUsd: toMonthly(hourly) },
        { label: 'Load Balancer rules (5 assumed)', monthlyUsd: rulesMonthly },
      ],
      assumptions: [
        `${sku} SKU load balancer`,
        '5 LB rules assumed; data processing charges not included',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-lb-list-price',
      confidence: 'estimate',
    };
  }

  private _unknown(resource: DbArchitectureResource, region: string): CostLineItem {
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: 0,
      monthlyUsd: 0,
      breakdown: [],
      assumptions: [`No pricing data available for resource type: ${resource.resourceType}`],
      pricingSource: 'none',
      confidence: 'unsupported',
    };
  }
}

export const azurePricingProvider = new AzurePricingProvider();
