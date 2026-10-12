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
  'Premium':    0.005,  // DTU Premium per DTU (P1 = 125 DTU = $15/day = $0.625/hr; verified against the Retail Prices API)
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
      case 'azure_postgres':        return this._flexibleServer('postgres', resource, config, region, mult);
      case 'azure_mysql':           return this._flexibleServer('mysql', resource, config, region, mult);
      case 'azure_service_bus':     return this._serviceBus(resource, config, region, mult);
      case 'azure_acr':             return this._acr(resource, config, region, mult);
      case 'azure_monitor':         return this._monitor(resource, config, region, mult);
      case 'azure_private_endpoint': return this._privateEndpoint(resource, config, region, mult);
      case 'azure_firewall':        return this._firewall(resource, config, region, mult);
      case 'azure_event_hubs':      return this._eventHubs(resource, config, region, mult);
      case 'azure_event_grid':      return this._eventGrid(resource, config, region, mult);
      case 'azure_api_management':  return this._apiManagement(resource, config, region, mult);
      case 'azure_container_apps':  return this._containerApps(resource, config, region, mult);
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
      // P1-P11 and a bare "Premium" are Premium-DTU tiers (a bare "Premium" is priced as P1); everything else is Standard-DTU.
      const isPremium = tier === 'Premium' || /^P\d+$/.test(tier);
      const dtu = tier === 'Premium' ? 125 : this._dtuFromTier(tier);
      const perDtu = SQL_HOURLY_PER_VCORE[isPremium ? 'Premium' : 'Standard']!;
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
    // Standard: $0.025/hr including the first 5 rules (Retail Prices API, "Standard Included LB Rules and Outbound Rules"); Basic is free.
    const hourly = (sku === 'Basic' ? 0 : 0.025) * mult;
    const rulesMonthly = 0;

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
        { label: 'First 5 rules included (data processed $0.005/GB not included)', monthlyUsd: rulesMonthly },
      ],
      assumptions: [
        `${sku} SKU load balancer`,
        'First 5 rules are included in the hourly price; extra rules and data processing are not included',
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
    const isWaf = sku === 'WAF_v2';
    const baseHourly = (isWaf ? 0.36 : 0.20) * mult; // fixed gateway charge, eastus (Retail Prices API)
    const capacity = Math.max(1, Number(config['autoscaleEnabled'] !== false ? config['minCapacity'] ?? 2 : config['capacity'] ?? 2));
    // Fixed gateway charge plus a per-capacity-unit charge ($0.008/hr for Standard_v2, $0.0144/hr for WAF_v2).
    const capacityHourly = capacity * (isWaf ? 0.0144 : 0.008) * mult;
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

  /**
   * Flexible servers: compute per vCore-hour plus storage per GB-month. Rates are the Azure Retail Prices API list prices for eastus, read on
   * 2026-10-12 (PostgreSQL: Burstable B1ms 0.017/h, B2s 0.068/h, General Purpose Ddsv5 0.089 per vCore-h, Memory Optimized Edsv5 0.125 per
   * vCore-h, storage 0.115 per GB-month; MySQL: the same Burstable rates, General Purpose 0.0855 and Memory Optimized 0.1181 per vCore-h).
   * Zone-redundant high availability runs a second copy of both compute and storage, so it doubles them.
   */
  private _flexibleServer(
    kind: 'postgres' | 'mysql',
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const sku = (config['skuName'] as string) || 'B_Standard_B1ms';
    const vcores = Number(/(?:D|E)(\d+)/.exec(sku)?.[1] ?? 1);
    const perVcoreGp = kind === 'postgres' ? 0.089 : 0.0855;
    const perVcoreMo = kind === 'postgres' ? 0.125 : 0.1181;
    const hourlyBase = sku === 'B_Standard_B2s' ? 0.068
      : sku.startsWith('B_') ? 0.017
        : sku.startsWith('MO_') ? vcores * perVcoreMo
          : vcores * perVcoreGp;
    const ha = config['highAvailability'] === 'ZoneRedundant' && !sku.startsWith('B_');
    const copies = ha ? 2 : 1;
    const storageGb = Math.max(1, Number(config['storageGb'] ?? (kind === 'postgres' ? 32 : 20)));
    const hourly = hourlyBase * copies * mult;
    const computeMonthly = toMonthly(hourly);
    const storageMonthly = storageGb * 0.115 * copies * mult;
    const monthly = computeMonthly + storageMonthly;
    const engine = kind === 'postgres' ? 'PostgreSQL' : 'MySQL';
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'azure',
      region,
      hourlyUsd: hourly + storageMonthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: `${engine} flexible server ${sku}${ha ? ' x2 (zone-redundant standby)' : ''}`, monthlyUsd: computeMonthly },
        { label: `Storage ${storageGb} GB${ha ? ' x2' : ''}`, monthlyUsd: storageMonthly },
      ],
      assumptions: [
        `Size: ${sku}${ha ? ', zone-redundant high availability (a second copy of compute and storage)' : ''}`,
        `Storage: ${storageGb} GB at $0.115 per GB-month`,
        'Backup storage beyond the free allowance equal to the provisioned size, geo-redundant backup, and data transfer are not included',
        `Region: ${region}`,
      ],
      pricingSource: `azure-${kind}-flexible-list-price`,
      confidence: 'estimate',
    };
  }

  /** Service Bus: Basic is per operation, Standard is a fixed monthly base (the first 13 million operations are included), Premium is per messaging unit-hour. */
  private _serviceBus(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const sku = (config['sku'] as string) || 'Standard';
    const units = Math.max(1, Number(config['capacity'] ?? 1));
    let monthly: number;
    let label: string;
    const assumptions: string[] = [];
    if (sku === 'Premium') {
      monthly = toMonthly(0.9275 * units * mult);
      label = `Premium ${units} messaging unit(s) at $0.9275 per unit-hour`;
    } else if (sku === 'Basic') {
      monthly = 10 * 0.05 * mult;
      label = 'Basic: 10 million operations at $0.05 per million';
      assumptions.push('Assumed 10 million operations a month');
    } else {
      monthly = 10 * mult;
      label = 'Standard: $10 base, includes the first 13 million operations';
      assumptions.push('Assumed usage within the 13 million included operations; more is billed per million');
    }
    return {
      resourceId: resource.id, resourceLabel: resource.label, resourceType: resource.resourceType, provider: 'azure', region,
      hourlyUsd: monthly / 730, monthlyUsd: monthly,
      breakdown: [{ label: `Service Bus ${label}`, monthlyUsd: monthly }],
      assumptions: [`Tier: ${sku}`, ...assumptions, 'Brokered connections beyond the included allowance and geo-replication data are not included', `Region: ${region}`],
      pricingSource: 'azure-service-bus-list-price',
      confidence: 'estimate',
    };
  }

  /** Container Registry: a fixed daily price per tier (Retail Prices API, read 2026-10-12: Basic 0.1666, Standard 0.6666, Premium 1.6666 per day) plus storage above the tier's allowance at 0.10 per GB-month. */
  private _acr(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const sku = (config['sku'] as string) || 'Standard';
    const perDay = sku === 'Premium' ? 1.6666 : sku === 'Basic' ? 0.1666 : 0.6666;
    const includedGb = sku === 'Premium' ? 500 : sku === 'Basic' ? 10 : 100;
    const storageGb = Math.max(0, Number(config['estimatedStorageGb'] ?? 20));
    const base = perDay * (730 / 24) * mult;
    const extra = Math.max(0, storageGb - includedGb) * 0.1 * mult;
    const monthly = base + extra;
    return {
      resourceId: resource.id, resourceLabel: resource.label, resourceType: resource.resourceType, provider: 'azure', region,
      hourlyUsd: monthly / 730, monthlyUsd: monthly,
      breakdown: [
        { label: `Container Registry ${sku}`, monthlyUsd: base },
        ...(extra > 0 ? [{ label: `Storage above the included ${includedGb} GB`, monthlyUsd: extra }] : []),
      ],
      assumptions: [`Tier: ${sku} (${includedGb} GB of storage included)`, `Estimated image storage: ${storageGb} GB`, 'Geo-replication, build tasks and data transfer are not included', `Region: ${region}`],
      pricingSource: 'azure-container-registry-list-price',
      confidence: 'estimate',
    };
  }

  /** Log Analytics + Application Insights: pay-as-you-go ingestion at $2.30 per GB after the 5 GB free each month, and retention beyond 31 days at $0.10 per GB-month. */
  private _monitor(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const ingestGb = Math.max(0, Number(config['estimatedIngestionGbPerMonth'] ?? 10));
    const cap = Number(config['dailyQuotaGb'] ?? -1);
    const cappedGb = cap >= 0 ? Math.min(ingestGb, cap * 30) : ingestGb;
    const retention = Math.max(30, Number(config['retentionDays'] ?? 30));
    const ingestion = Math.max(0, cappedGb - 5) * 2.3 * mult;
    const retentionCost = cappedGb * (Math.max(0, retention - 31) / 30) * 0.1 * mult;
    const monthly = ingestion + retentionCost;
    return {
      resourceId: resource.id, resourceLabel: resource.label, resourceType: resource.resourceType, provider: 'azure', region,
      hourlyUsd: monthly / 730, monthlyUsd: monthly,
      breakdown: [
        { label: `Log ingestion ${cappedGb} GB (first 5 GB free)`, monthlyUsd: ingestion },
        ...(retentionCost > 0 ? [{ label: `Retention ${retention} days`, monthlyUsd: retentionCost }] : []),
      ],
      assumptions: [
        `Estimated ingestion: ${ingestGb} GB a month${cap >= 0 ? `, capped at ${cap} GB a day` : ''}`,
        'Pay-as-you-go rate $2.30 per GB; commitment tiers, alerts, tests and export are not included',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-monitor-list-price',
      confidence: 'estimate',
    };
  }

  /** Private Endpoint: $0.01 per hour plus $0.01 per GB processed. (Microsoft's published Private Link rate; the Retail Prices API does not list it.) */
  private _privateEndpoint(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const gb = Math.max(0, Number(config['estimatedDataGbPerMonth'] ?? 100));
    const hourly = 0.01 * mult;
    const fixed = toMonthly(hourly);
    const data = gb * 0.01 * mult;
    return {
      resourceId: resource.id, resourceLabel: resource.label, resourceType: resource.resourceType, provider: 'azure', region,
      hourlyUsd: hourly + data / 730, monthlyUsd: fixed + data,
      breakdown: [
        { label: 'Private Endpoint hours', monthlyUsd: fixed },
        { label: `Data processed ${gb} GB`, monthlyUsd: data },
      ],
      assumptions: [`Estimated data processed: ${gb} GB a month at $0.01 per GB`, 'The private DNS zone ($0.50 a month per zone) and DNS queries are not included', `Region: ${region}`],
      pricingSource: 'azure-private-link-published-rate',
      confidence: 'estimate',
    };
  }

  /** Azure Firewall: a deployment hour rate per tier plus data processed (Retail Prices API, read 2026-10-12: Standard 1.25/h, Premium 1.75/h, 0.016 per GB). The public address is a separate resource. */
  private _firewall(resource: DbArchitectureResource, config: Record<string, unknown>, region: string, mult: number): CostLineItem {
    const tier = (config['sku'] as string) === 'Premium' ? 'Premium' : 'Standard';
    const hourly = (tier === 'Premium' ? 1.75 : 1.25) * mult;
    const gb = Math.max(0, Number(config['estimatedDataGbPerMonth'] ?? 100));
    const fixed = toMonthly(hourly);
    const data = gb * 0.016 * mult;
    return {
      resourceId: resource.id, resourceLabel: resource.label, resourceType: resource.resourceType, provider: 'azure', region,
      hourlyUsd: hourly + data / 730, monthlyUsd: fixed + data,
      breakdown: [{ label: `Azure Firewall ${tier} deployment`, monthlyUsd: fixed }, { label: `Data processed ${gb} GB`, monthlyUsd: data }],
      assumptions: [`Tier: ${tier}`, `Estimated data processed: ${gb} GB a month at $0.016 per GB`, 'The firewall\'s public IP address is billed as its own resource', `Region: ${region}`],
      pricingSource: 'azure-firewall-list-price', confidence: 'estimate',
    };
  }

  /** Event Hubs: Basic 0.015/h and Standard 0.03/h per throughput unit, Premium 1.027/h per processing unit, plus 0.028 per million ingress events on Basic and Standard. */
  private _eventHubs(resource: DbArchitectureResource, config: Record<string, unknown>, region: string, mult: number): CostLineItem {
    const sku = (config['sku'] as string) || 'Standard';
    const units = Math.max(1, Number(config['capacity'] ?? 1));
    const perUnit = sku === 'Premium' ? 1.027 : sku === 'Basic' ? 0.015 : 0.03;
    const events = Math.max(0, Number(config['estimatedMillionEventsPerMonth'] ?? 10));
    const fixed = toMonthly(perUnit * units * mult);
    const ingress = sku === 'Premium' ? 0 : events * 0.028 * mult;
    return {
      resourceId: resource.id, resourceLabel: resource.label, resourceType: resource.resourceType, provider: 'azure', region,
      hourlyUsd: (fixed + ingress) / 730, monthlyUsd: fixed + ingress,
      breakdown: [{ label: `Event Hubs ${sku} x${units} ${sku === 'Premium' ? 'processing' : 'throughput'} unit(s)`, monthlyUsd: fixed }, ...(ingress > 0 ? [{ label: `Ingress ${events} million events`, monthlyUsd: ingress }] : [])],
      assumptions: [`Tier: ${sku}`, sku === 'Premium' ? 'Premium includes ingress' : `Estimated ${events} million events a month`, 'Capture, Kafka endpoint and extended retention are not included', `Region: ${region}`],
      pricingSource: 'azure-event-hubs-list-price', confidence: 'estimate',
    };
  }

  /** Event Grid topic: $0.60 per million operations after the first 100,000 a month. */
  private _eventGrid(resource: DbArchitectureResource, config: Record<string, unknown>, region: string, mult: number): CostLineItem {
    const ops = Math.max(0, Number(config['estimatedMillionOpsPerMonth'] ?? 1));
    const monthly = Math.max(0, ops - 0.1) * 0.6 * mult;
    return {
      resourceId: resource.id, resourceLabel: resource.label, resourceType: resource.resourceType, provider: 'azure', region,
      hourlyUsd: monthly / 730, monthlyUsd: monthly,
      breakdown: [{ label: `Operations ${ops} million (first 100,000 free)`, monthlyUsd: monthly }],
      assumptions: [`Estimated ${ops} million operations a month`, 'Dead-lettering, advanced filtering and MQTT are not included', `Region: ${region}`],
      pricingSource: 'azure-event-grid-list-price', confidence: 'estimate',
    };
  }

  /** API Management: per-unit hourly rate (Developer 0.0658, Basic 0.2016, Standard 0.9407, Premium 3.829) or, on Consumption, $3.50 per million calls after the first million. */
  private _apiManagement(resource: DbArchitectureResource, config: Record<string, unknown>, region: string, mult: number): CostLineItem {
    const sku = (config['sku'] as string) || 'Developer';
    const assumptions: string[] = [`Tier: ${sku}`];
    let monthly: number;
    let label: string;
    if (sku === 'Consumption') {
      const calls = Math.max(0, Number(config['estimatedMillionCallsPerMonth'] ?? 1));
      monthly = Math.max(0, calls - 1) * 3.5 * mult;
      label = `Consumption: ${calls} million calls (first million free)`;
      assumptions.push(`Estimated ${calls} million calls a month`);
    } else {
      const units = sku === 'Developer' ? 1 : Math.max(1, Number(config['capacity'] ?? 1));
      const perUnit = sku === 'Premium' ? 3.829 : sku === 'Standard' ? 0.9407 : sku === 'Basic' ? 0.2016 : 0.0658;
      monthly = toMonthly(perUnit * units * mult);
      label = `${sku} x${units} unit(s)`;
      if (sku === 'Developer') assumptions.push('The Developer tier has no SLA and is meant for non-production');
    }
    return {
      resourceId: resource.id, resourceLabel: resource.label, resourceType: resource.resourceType, provider: 'azure', region,
      hourlyUsd: monthly / 730, monthlyUsd: monthly,
      breakdown: [{ label: `API Management ${label}`, monthlyUsd: monthly }],
      assumptions: [...assumptions, 'Self-hosted gateways, workspaces and multi-region units are not included', `Region: ${region}`],
      pricingSource: 'azure-api-management-list-price', confidence: 'estimate',
    };
  }

  /**
   * Container Apps (Consumption plan): vCPU at 0.000024 per second while handling requests and 0.000003 when idle, memory at 0.000003 per GiB-second,
   * requests at $0.40 per million after the first 2 million. A replica that is always running is assumed idle outside the stated share of time.
   * The monthly free grants (180,000 vCPU-seconds, 360,000 GiB-seconds) are shared by the whole subscription and are not deducted here.
   */
  private _containerApps(resource: DbArchitectureResource, config: Record<string, unknown>, region: string, mult: number): CostLineItem {
    const cpu = Number(config['cpu'] ?? 0.5) || 0.5;
    const memGib = cpu * 2;
    const replicas = Math.max(0, Number(config['minReplicas'] ?? 1));
    const active = Math.min(100, Math.max(0, Number(config['estimatedActivePercent'] ?? 25))) / 100;
    const seconds = 730 * 3600;
    const vcpu = replicas * cpu * seconds * (active * 0.000024 + (1 - active) * 0.000003) * mult;
    const mem = replicas * memGib * seconds * 0.000003 * mult;
    const requests = Math.max(0, Number(config['estimatedMillionRequestsPerMonth'] ?? 1));
    const reqCost = Math.max(0, requests - 2) * 0.4 * mult;
    const monthly = vcpu + mem + reqCost;
    return {
      resourceId: resource.id, resourceLabel: resource.label, resourceType: resource.resourceType, provider: 'azure', region,
      hourlyUsd: monthly / 730, monthlyUsd: monthly,
      breakdown: [{ label: `vCPU ${replicas} x ${cpu}`, monthlyUsd: vcpu }, { label: `Memory ${replicas} x ${memGib} GiB`, monthlyUsd: mem }, ...(reqCost > 0 ? [{ label: `Requests ${requests} million`, monthlyUsd: reqCost }] : [])],
      assumptions: [
        `${replicas} replica(s) always running, handling requests ${Math.round(active * 100)}% of the time and idle otherwise`,
        'Replicas above the minimum are billed only while they run and are not included',
        'The monthly free grants are shared by the subscription and are not deducted',
        `Region: ${region}`,
      ],
      pricingSource: 'azure-container-apps-list-price', confidence: 'estimate',
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
