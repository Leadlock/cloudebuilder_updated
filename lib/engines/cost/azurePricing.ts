/**
 * Azure Pricing Provider — static fallback
 *
 * This is NOT the primary pricing path anymore. CostEstimator.estimateAsync()
 * (lib/engines/cost/CostEstimator.ts) queries the live
 * CloudProviderPricingService first, which for Azure hits the real, public,
 * unauthenticated Azure Retail Prices API
 * (https://prices.azure.com/api/retail/prices) via
 * lib/cloud/pricing/AzurePricingProvider.ts, and only falls back to this
 * class when that live call fails or times out. So this file's static
 * tables are the offline/API-down resilience path, not the everyday
 * pricing source — Azure design-time estimates are genuinely live in the
 * normal case.
 *
 * Prices below are Pay-As-You-Go East US list prices as of late 2024 and
 * will drift over time — expected for a fallback path, not a correctness bug.
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

/**
 * Azure SQL Database pricing (per vCore hour for Gen5 vCore-model tiers,
 * per DTU hour for the legacy Standard/Premium DTU-model tiers).
 * GP_Gen5/BC_Gen5 verified against the live Azure Retail Prices API
 * (prices.azure.com, armRegionName=eastus) on 2026-09-24:
 * armSkuName=SQLDB_GP_Compute_Gen5_2 -> $0.304434/hr / 2 vCores = $0.152217/vCore/hr;
 * armSkuName=SQLDB_BC_Compute_Gen5_16 -> $4.87096/hr / 16 vCores = $0.304435/vCore/hr
 * (exactly 2x General Purpose, per vCore). The previous 0.1230/0.5560
 * values were stale and, more importantly, were never actually read by
 * _sql() below — every tier fell through to the DTU 'Standard' rate.
 */
const SQL_HOURLY_PER_VCORE: Record<string, number> = {
  'GP_Gen5':    0.152217, // General Purpose Gen 5 per vCore
  'BC_Gen5':    0.304435, // Business Critical Gen 5 per vCore
  'Standard':   0.002,  // DTU Standard per DTU
  'Premium':    0.0125, // DTU Premium per DTU
};

/**
 * Azure SQL Database Single "Basic" tier — a single fixed-price product
 * (5 DTU, not user-scalable), not a per-DTU rate. Verified against the live
 * Azure Retail Prices API on 2026-09-24: armSkuName=B (SQL Database Single
 * Basic) -> $0.161/day = $0.0067/hr.
 */
const SQL_BASIC_HOURLY = 0.161 / 24;

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
      case 'azure_app_gateway':     return this._appGateway(resource, config, region, mult);
      case 'azure_functions':       return this._functions(resource, config, region, mult);
      case 'azure_aks':             return this._aks(resource, config, region, mult);
      case 'azure_app_service':     return this._appService(resource, config, region, mult);
      case 'azure_key_vault':       return this._keyVault(resource, config, region, mult);
      case 'azure_nat':             return this._nat(resource, config, region, mult);
      case 'azure_redis':           return this._redis(resource, config, region, mult);
      case 'azure_bastion':         return this._bastion(resource, config, region, mult);
      case 'azure_front_door':      return this._frontDoor(resource, config, region, mult);
      case 'azure_waf':             return this._azureWaf(resource, config, region, mult);
      case 'azure_vmss':            return this._vmss(resource, config, region, mult);
      case 'azure_cosmos_db':       return this._cosmosDb(resource, config, region, mult);
      case 'azure_public_ip':       return this._publicIp(resource, config, region, mult);
      case 'azure_resource_group':
      case 'azure_vnet':
      case 'azure_subnet':
      case 'azure_nsg':
      case 'azure_route_table':
      case 'azure_nic':
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
    const tier = (config['tier'] as string) ?? 'Standard';
    const maxSizeGb = (config['maxSizeGb'] as number) ?? 250;
    const storageMonthly = (maxSizeGb * 0.122) * mult; // ~$0.122/GB/mo included in max

    // Azure SQL has two unrelated pricing models depending on which family
    // `tier` belongs to — the vCore model (GeneralPurpose/BusinessCritical/
    // GP_Gen5_N/BC_Gen5_N, priced per vCore) and the legacy DTU model
    // (Basic/Standard/Premium/S0-S4/P1-P11, priced per DTU or, for Basic, a
    // single fixed price). Every one of the RDE's real tier dropdown values
    // (lib/resources/azure.ts) previously fell through _dtuFromTier's
    // S0-S4/P1-P11-only map to its default 10-DTU Standard price — so
    // scaling Azure SQL through this static fallback path (used when the
    // live Azure Retail Prices API is unavailable) never changed the shown
    // cost no matter which tier was actually selected.
    const gen5Match = /^(GP|BC)_Gen5_(\d+)$/.exec(tier);
    let hourly: number;
    let sourceLabel: string;
    let assumption: string;

    if (gen5Match) {
      const family = gen5Match[1] === 'BC' ? 'BusinessCritical' : 'GeneralPurpose';
      const vcores = Number(gen5Match[2]);
      const perVcore = SQL_HOURLY_PER_VCORE[gen5Match[1] === 'BC' ? 'BC_Gen5' : 'GP_Gen5']!;
      hourly = perVcore * vcores;
      sourceLabel = `Azure SQL ${family} ${tier} (${vcores} vCores)`;
      assumption = `${family} tier, ${tier} (${vcores} vCores)`;
    } else if (tier === 'GeneralPurpose' || tier === 'BusinessCritical') {
      // Selected without a specific Gen5_N size — price at the smallest
      // real Gen5 size the RDE itself offers for this family (2 vCores).
      const vcores = 2;
      const perVcore = SQL_HOURLY_PER_VCORE[tier === 'BusinessCritical' ? 'BC_Gen5' : 'GP_Gen5']!;
      hourly = perVcore * vcores;
      sourceLabel = `Azure SQL ${tier} (${vcores} vCores, default size)`;
      assumption = `${tier} tier, default ${vcores}-vCore size`;
    } else if (tier === 'Basic') {
      hourly = SQL_BASIC_HOURLY;
      sourceLabel = 'Azure SQL Basic (5 DTU, fixed)';
      assumption = 'Basic tier (fixed 5 DTU, not scalable)';
    } else {
      // Standard/Premium/S0-S4/P1-P11 DTU model
      const dtu = this._dtuFromTier(tier);
      const perDtu = SQL_HOURLY_PER_VCORE[tier === 'Premium' ? 'Premium' : 'Standard']!;
      hourly = perDtu * dtu;
      sourceLabel = `Azure SQL ${tier} (${dtu} DTUs)`;
      assumption = `${tier} tier, ${dtu} DTUs`;
    }

    hourly *= mult;
    const monthly = toMonthly(hourly);

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly + storageMonthly,
      breakdown: [
        { label: sourceLabel, monthlyUsd: monthly },
        { label: `Max storage (${maxSizeGb}GB)`, monthlyUsd: storageMonthly },
      ],
      assumptions: [
        assumption,
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

  private _appGateway(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const sku = (config['sku'] as string) || 'Standard_v2';
    const baseHourly = (sku === 'WAF_v2' ? 0.443 : 0.246) * mult;
    const capacity = Math.max(1, Number(config['autoscaleEnabled'] !== false ? config['minCapacity'] ?? 2 : config['capacity'] ?? 2));
    // Fixed gateway charge plus a per-capacity-unit charge (~$0.008/hr/unit for v2 SKUs).
    const capacityHourly = capacity * 0.008 * mult;
    const hourly = baseHourly + capacityHourly;
    const monthly = toMonthly(hourly);
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly,
      breakdown: [
        { label: `Application Gateway ${sku} fixed hourly`, monthlyUsd: toMonthly(baseHourly) },
        { label: `${capacity} capacity unit(s)`, monthlyUsd: toMonthly(capacityHourly) },
      ],
      assumptions: [
        `SKU: ${sku}, ${capacity} capacity unit(s)`,
        `Region: ${region}`,
      ],
      pricingSource: 'azure-app-gateway-list-price',
      confidence: 'estimate',
    };
  }

  private _functions(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const planType = (config['planType'] as string) || 'Y1';

    // Premium/Dedicated plans bill a fixed hourly SKU rate regardless of executions.
    const planHourlyUsd: Record<string, number> = { EP1: 0.173, EP2: 0.346, B1: 0.018, S1: 0.036 };
    if (planType !== 'Y1' && planHourlyUsd[planType] !== undefined) {
      const hourly = planHourlyUsd[planType]! * mult;
      const monthly = toMonthly(hourly);
      return {
        resourceId: resource.id,
        resourceLabel: resource.label,
        resourceType: resource.resourceType,
        provider: 'azure',
        region,
        hourlyUsd: hourly,
        monthlyUsd: monthly,
        breakdown: [
          { label: `Azure Functions ${planType} plan (always-on)`, monthlyUsd: monthly },
        ],
        assumptions: [
          `${planType} plan: fixed hourly rate regardless of execution count`,
          `Region: ${region}`,
        ],
        pricingSource: 'azure-functions-premium-list-price',
        confidence: 'estimate',
      };
    }

    // Consumption (Y1): $0.20 per million executions + $0.000016/GB-s, with a free grant.
    const invocations = Math.max(0, Number(config['estimatedInvocationsPerMonth'] ?? 1_000_000));
    const avgDurationMs = Math.max(0, Number(config['estimatedAvgDurationMs'] ?? 100));
    const memoryMb = Math.max(128, Number(config['memoryMb'] ?? 512));
    const freeExecutions = 1_000_000;
    const freeGbSeconds = 400_000;
    const gbSeconds = invocations * (memoryMb / 1024) * (avgDurationMs / 1000);
    const billableExecutions = Math.max(0, invocations - freeExecutions);
    const billableGbSeconds = Math.max(0, gbSeconds - freeGbSeconds);
    const executionCost = (billableExecutions / 1_000_000) * 0.20;
    const computeCost = billableGbSeconds * 0.000016;
    const monthly = executionCost + computeCost;

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: `Executions (${invocations.toLocaleString()}/mo, 1M free)`, monthlyUsd: executionCost },
        { label: `Compute (${memoryMb}MB x ${avgDurationMs}ms, 400K GB-s free)`, monthlyUsd: computeCost },
      ],
      assumptions: [
        'Consumption (Y1) plan: pay-per-execution',
        `${invocations.toLocaleString()} invocations/mo at ${avgDurationMs}ms average duration assumed`,
        `Region: ${region}`,
      ],
      pricingSource: 'azure-functions-consumption-list-price',
      confidence: 'estimate',
    };
  }

  private _aks(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const skuTier = (config['skuTier'] as string) || 'Free';
    const controlPlaneHourly = skuTier === 'Standard' ? 0.10 * mult : 0;
    const controlPlaneMonthly = toMonthly(controlPlaneHourly);

    const nodeVmSize = (config['nodeVmSize'] as string) ?? 'Standard_D2s_v3';
    const nodeCount = Math.max(0, Number(config['nodeCount'] ?? 3));
    const nodeBaseHourly = VM_HOURLY_USD[nodeVmSize] ?? VM_HOURLY_USD['Standard_B2s']!;
    const nodesHourly = nodeBaseHourly * mult * nodeCount;
    const nodesMonthly = toMonthly(nodesHourly);

    const hourly = controlPlaneHourly + nodesHourly;
    const monthly = controlPlaneMonthly + nodesMonthly;

    const breakdown: { label: string; monthlyUsd: number }[] = [];
    if (skuTier === 'Standard') {
      breakdown.push({ label: 'AKS cluster control plane Uptime SLA ($0.10/hr)', monthlyUsd: controlPlaneMonthly });
    } else {
      breakdown.push({ label: 'AKS cluster control plane (Free tier, no SLA charge)', monthlyUsd: 0 });
    }
    breakdown.push({ label: `Node pool: ${nodeVmSize} x${nodeCount}`, monthlyUsd: nodesMonthly });

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly,
      breakdown,
      assumptions: [
        `SKU tier: ${skuTier}`,
        `${nodeCount} x ${nodeVmSize} node(s)`,
        `Region: ${region}`,
      ],
      pricingSource: 'azure-aks-list-price',
      confidence: 'estimate',
    };
  }

  private _appService(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    // us-east region App Service Plan hourly list prices (Linux/Windows, per instance).
    const skuHourlyUsd: Record<string, number> = {
      F1: 0, B1: 0.018, B2: 0.036, S1: 0.036, P1v3: 0.146, P2v3: 0.293,
    };
    const skuName = (config['skuName'] as string) || 'B1';
    const hourly = (skuHourlyUsd[skuName] ?? skuHourlyUsd['B1']!) * mult;
    const monthly = toMonthly(hourly);

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly,
      breakdown: [
        { label: `App Service Plan ${skuName}${skuName === 'F1' ? ' (Free tier)' : ''}`, monthlyUsd: monthly },
      ],
      assumptions: [
        `SKU: ${skuName}`,
        'Single instance; scale-out instances would each add this rate',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-app-service-list-price',
      confidence: 'estimate',
    };
  }

  private _redis(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    // us-east-1 Azure Cache for Redis hourly list prices by SKU family + capacity tier.
    const sku = (config['sku'] as string) || 'Standard';
    const capacity = Number(config['capacity'] ?? 1);
    const hourlyBySku: Record<string, number[]> = {
      Basic: [0.022, 0.043, 0.087, 0.173, 0.344, 0.688, 1.376],
      Standard: [0.043, 0.087, 0.173, 0.344, 0.688, 1.376, 2.752],
      Premium: [0.344, 0.688, 1.376, 2.752],
    };
    const tiers = hourlyBySku[sku] ?? hourlyBySku['Standard']!;
    const hourly = (tiers[Math.min(capacity, tiers.length - 1)] ?? tiers[0]!) * mult;
    const monthly = toMonthly(hourly);

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly,
      breakdown: [
        { label: `Azure Cache for Redis ${sku} C${capacity}`, monthlyUsd: monthly },
      ],
      assumptions: [
        `SKU: ${sku}, capacity tier: ${capacity}`,
        `Region: ${region}`,
      ],
      pricingSource: 'azure-redis-list-price',
      confidence: 'estimate',
    };
  }

  private _bastion(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const sku = (config['sku'] as string) || 'Standard';
    const scaleUnits = sku === 'Standard' ? Math.max(2, Number(config['scaleUnits'] ?? 2)) : 1;
    // Basic: ~$0.19/hr flat. Standard: ~$0.29/hr base for 2 scale units, +$0.145/hr per additional unit.
    const hourly = (sku === 'Basic' ? 0.19 : 0.29 + Math.max(0, scaleUnits - 2) * 0.145) * mult;
    const monthly = toMonthly(hourly);

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly,
      breakdown: [
        { label: `Azure Bastion ${sku}${sku === 'Standard' ? ` (${scaleUnits} scale units)` : ''}`, monthlyUsd: monthly },
      ],
      assumptions: [
        `SKU: ${sku}`,
        'Outbound data processing charges not included',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-bastion-list-price',
      confidence: 'estimate',
    };
  }

  private _frontDoor(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const sku = (config['sku'] as string) || 'Standard_AzureFrontDoor';
    // Standard: ~$35/mo base + usage. Premium: ~$330/mo base (includes managed WAF/Private Link).
    const monthly = (sku === 'Premium_AzureFrontDoor' ? 330 : 35) * mult;

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: `Front Door ${sku === 'Premium_AzureFrontDoor' ? 'Premium' : 'Standard'} base fee`, monthlyUsd: monthly },
      ],
      assumptions: [
        'Data transfer and request-volume charges not included',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-frontdoor-list-price',
      confidence: 'estimate',
    };
  }

  private _azureWaf(
    resource: DbArchitectureResource,
    _config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    // Azure WAF policy: ~$5/policy/month base (billed via the associated Application Gateway/Front Door).
    const monthly = 5.0 * mult;

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: 'WAF policy', monthlyUsd: monthly },
      ],
      assumptions: [
        'Request-processing charges billed through the associated Application Gateway/Front Door, not included here',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-waf-list-price',
      confidence: 'estimate',
    };
  }

  private _vmss(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const sku = (config['sku'] as string) ?? 'Standard_B2s';
    const capacity = Math.max(0, Number(config['capacity'] ?? 2));
    const baseHourly = VM_HOURLY_USD[sku] ?? VM_HOURLY_USD['Standard_B2s']!;
    const hourly = baseHourly * mult * capacity;
    const monthly = toMonthly(hourly);

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly,
      breakdown: [
        { label: `VMSS ${sku} x${capacity} instance(s)`, monthlyUsd: monthly },
      ],
      assumptions: [
        `${capacity} instance(s) at ${sku}`,
        'OS disk cost not included',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-vmss-list-price',
      confidence: 'estimate',
    };
  }

  private _cosmosDb(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const throughputMode = (config['throughputMode'] as string) || 'Serverless';

    if (throughputMode === 'Provisioned') {
      // Autoscale provisioned throughput: ~$0.008/RU per hour for the max RU/s tier.
      const maxRu = Math.max(1000, Number(config['maxThroughputRu'] ?? 4000));
      const hourly = (maxRu / 100) * 0.008 * mult;
      const monthly = toMonthly(hourly);
      return {
        resourceId: resource.id,
        resourceLabel: resource.label,
        resourceType: resource.resourceType,
        provider: 'azure',
        region,
        hourlyUsd: hourly,
        monthlyUsd: monthly,
        breakdown: [
          { label: `Provisioned autoscale throughput (${maxRu} RU/s max)`, monthlyUsd: monthly },
        ],
        assumptions: [
          'Storage charges not included — $0.25/GB-mo',
          `Region: ${region}`,
        ],
        pricingSource: 'azure-cosmosdb-list-price',
        confidence: 'estimate',
      };
    }

    // Serverless: ~$0.30 per million RUs consumed. Flat baseline assumption for a light workload.
    const monthly = 24.0 * mult;
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: 'Serverless throughput (baseline usage assumed)', monthlyUsd: monthly },
      ],
      assumptions: [
        'Serverless: actual cost scales with RUs consumed ($0.30/million RUs) — a light baseline workload is assumed',
        'Storage charges not included — $0.25/GB-mo',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-cosmosdb-list-price',
      confidence: 'estimate',
    };
  }

  private _publicIp(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const sku = (config['sku'] as string) || 'Standard';
    // Standard SKU: $0.005/hr (~$3.65/mo). Basic SKU is being retired but still effectively free/negligible.
    const hourly = (sku === 'Standard' ? 0.005 : 0) * mult;
    const monthly = toMonthly(hourly);

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly,
      breakdown: [
        { label: `Public IP (${sku})`, monthlyUsd: monthly },
      ],
      assumptions: [
        `SKU: ${sku}`,
        `Region: ${region}`,
      ],
      pricingSource: 'azure-public-ip-list-price',
      confidence: 'estimate',
    };
  }

  private _keyVault(
    resource: DbArchitectureResource,
    _config: Record<string, unknown>,
    region: string,
    _mult: number,
  ): CostLineItem {
    const monthly = 3.0;
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: 'Key Vault standard operations & secret storage', monthlyUsd: monthly },
      ],
      assumptions: [
        'Includes ~100k key and secret transactions',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-keyvault-list-price',
      confidence: 'estimate',
    };
  }

  private _nat(
    resource: DbArchitectureResource,
    _config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const hourly = 0.045 * mult;
    const monthly = toMonthly(hourly) + (4.5 * mult);
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly,
      breakdown: [
        { label: 'Azure NAT Gateway hourly resource charge', monthlyUsd: toMonthly(hourly) },
        { label: 'Data processed (100GB assumed)', monthlyUsd: 4.5 * mult },
      ],
      assumptions: [
        'Assumes standard 100GB/mo data throughput',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-nat-list-price',
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
