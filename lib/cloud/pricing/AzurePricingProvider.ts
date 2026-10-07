/**
 * CloudCraft — Real Azure Pricing Provider
 *
 * Integrates directly with Microsoft's official Azure Retail Prices API:
 * https://prices.azure.com/api/retail/prices
 *
 * Requires NO credentials. Publicly accessible and returns real-time retail list prices.
 */
import type { ICloudPricingProvider, NormalizedPrice, PriceQuery } from './types';
import { HOURS_PER_MONTH, monthlyFromRetailItem, type AzureRetailPriceItem } from './azureRetail';
import { AZURE_METER_SOURCES, azureMeterFilter, pickAzureMeters } from '@/lib/cost/ai/meterPicker';
import { askFoundryJson, aiCostAvailable, type AskModel } from '@/lib/cost/ai/askModel';
import { azurePricingProvider as staticAzureTable } from '@/lib/engines/cost/azurePricing';

export { monthlyFromRetailItem, type AzureRetailPriceItem };

export interface AzurePricingOptions {
  /** Let the AI choose price-list meters for resource types without a hand-written lookup. Default: on when a model is configured. */
  aiMeterMatching?: boolean;
  ask?: AskModel;
}

interface AzureRetailApiResponse {
  Items: AzureRetailPriceItem[];
  NextPageLink?: string | null;
  Count: number;
}

export class AzurePricingProvider implements ICloudPricingProvider {
  readonly name = 'azure-retail-api';
  readonly provider = 'azure' as const;

  private readonly _ai: boolean;
  private readonly _ask: AskModel;

  constructor(options: AzurePricingOptions = {}) {
    // Never on under Jest unless a test injects a model: unit tests must not reach a real model.
    this._ai = options.aiMeterMatching ?? (!process.env['JEST_WORKER_ID'] && aiCostAvailable());
    this._ask = options.ask ?? askFoundryJson;
  }

  async getPrice(query: PriceQuery): Promise<NormalizedPrice | null> {
    const { resourceType, region, configuration } = query;
    const cleanRegion = (region || 'eastus').toLowerCase().replace(/\s+/g, '');

    try {
      switch (resourceType) {
        case 'azure_vm':
          return await this._getVmPrice(configuration, cleanRegion);
        case 'azure_sql':
          return await this._getSqlPrice(configuration, cleanRegion);
        case 'azure_storage':
          return await this._getStoragePrice(configuration, cleanRegion);
        case 'azure_lb':
          return await this._getLbPrice(configuration, cleanRegion);
        case 'azure_app_gateway':
          return await this._getAppGatewayPrice(configuration, cleanRegion);
        case 'azure_functions':
          return await this._getFunctionsPrice(configuration, cleanRegion);
        case 'azure_aks':
          return await this._getAksPrice(configuration, cleanRegion);
        case 'azure_key_vault':
          return await this._getKeyVaultPrice(configuration, cleanRegion);
        case 'azure_front_door':
          return await this._getFrontDoorPrice(configuration, cleanRegion);
        case 'azure_cosmos_db':
          // The direct lookup first; the AI meter picker stays as a fallback for a price list that is laid out differently.
          return (await this._getCosmosPrice(configuration, cleanRegion)) ?? (await this._getAiMatchedPrice(resourceType, configuration, cleanRegion));
        case 'azure_resource_group':
        case 'azure_vnet':
        case 'azure_subnet':
        case 'azure_nsg':
          return {
            provider: 'azure',
            service: resourceType,
            resourceType,
            region: cleanRegion,
            sku: 'default',
            pricingModel: 'on-demand',
            unit: '1 Hour',
            unitPrice: 0,
            monthlyPrice: 0,
            currency: 'USD',
            description: 'No direct charges for networking/container boundaries',
            source: 'azure-static-estimate',
            retrievedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            assumptions: ['Free tier resource boundary'],
          };
        default:
          return await this._getAiMatchedPrice(resourceType, configuration, cleanRegion);
      }
    } catch (err) {
      console.warn(`[AzurePricingProvider] Error fetching live price for ${resourceType} (${cleanRegion}):`, err);
      return null;
    }
  }

  /**
   * Resource types with no hand-written lookup: fetch the service's real price rows and let the AI choose which ones apply
   * (lib/cost/ai/meterPicker.ts). Null when AI matching is off, the type has no known service, or the answer fails any check.
   */
  private async _getAiMatchedPrice(resourceType: string, config: Record<string, unknown>, region: string): Promise<NormalizedPrice | null> {
    const source = AZURE_METER_SOURCES[resourceType];
    if (!this._ai || !source) return null;
    let rows: AzureRetailPriceItem[];
    try {
      rows = await this._fetchRetailPrices(azureMeterFilter(source.service, region));
    } catch {
      return null;
    }
    const anchor = staticAzureTable.estimateResource({ id: 'anchor', label: 'anchor', resourceType, provider: 'azure' } as never, config, region)?.monthlyUsd ?? null;
    try {
      return await pickAzureMeters({ resourceType, region, config, rows, anchorMonthlyUsd: anchor && anchor > 0 ? anchor : null, ask: this._ask });
    } catch (err) {
      console.warn(`[AzurePricingProvider] AI meter matching failed for ${resourceType}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  private async _fetchRetailPrices(filter: string): Promise<AzureRetailPriceItem[]> {
    const url = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4500);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status} from Azure Retail Prices API`);
      const data = (await res.json()) as AzureRetailApiResponse;
      return data.Items || [];
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  private async _getVmPrice(config: Record<string, unknown>, region: string): Promise<NormalizedPrice> {
    const size = (config['size'] as string) || 'Standard_B2s';
    // Remove "Standard_" prefix for meter matching if needed
    const bareSize = size.replace(/^Standard_/i, '');
    // armSkuName is the exact size name (Standard_D2s_v3). skuName spells it differently ("D2s v3", with a space), so matching the size inside
    // skuName found no rows for most sizes and every VM silently used the built-in price.
    const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and armSkuName eq '${size}' and priceType eq 'Consumption'`;
    
    const items = await this._fetchRetailPrices(filter);
    // Find non-spot, non-low-priority Linux instance
    // Only a meter that matches the requested SKU counts as a live price; an unrelated
    // first result is not used (it would be a real price for the wrong size).
    const best = items.find((i) =>
      !i.meterName.toLowerCase().includes('spot') &&
      !i.meterName.toLowerCase().includes('low priority') &&
      !i.productName.toLowerCase().includes('windows') &&
      (i.armSkuName === size || i.skuName.toLowerCase().includes(bareSize.toLowerCase()))
    );

    const hourly = best && best.retailPrice > 0 ? best.retailPrice : 0.0416;
    const osDiskGb = Number(config['osDiskGb'] || 128);
    // Standard Premium SSD rate ~$0.10/GB/month
    const diskMonthly = osDiskGb * 0.10;
    const monthlyPrice = (hourly * 730) + diskMonthly;

    return {
      provider: 'azure',
      service: 'Virtual Machines',
      resourceType: 'azure_vm',
      region,
      sku: size,
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: hourly,
      monthlyPrice,
      currency: 'USD',
      description: `Azure VM ${size} (Pay-As-You-Go, Linux) + ${osDiskGb}GB Premium SSD`,
      source: best && best.retailPrice > 0 ? 'azure-retail-api' : 'azure-static-estimate',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        best && best.retailPrice > 0 ? `Live price from Azure Retail Prices API: $${hourly.toFixed(4)}/hr`
          : `No matching Azure Retail Prices meter for ${size}; CloudCraft baseline estimate $${hourly.toFixed(4)}/hr`,
        `Assumes 730 hours/month compute runtime: $${(hourly * 730).toFixed(2)}/mo`,
        `${osDiskGb}GB Premium SSD OS disk: $${diskMonthly.toFixed(2)}/mo`,
        `Region: ${region}`,
      ],
    };
  }

  private async _getSqlPrice(config: Record<string, unknown>, region: string): Promise<NormalizedPrice | null> {
    const tier = (config['tier'] as string) || 'S0';
    const maxSizeGb = Number(config['maxSizeGb'] || 250);

    // vCore tiers (GP_Gen5_N, BC_Gen5_N) are priced from the live compute, zone-redundancy and storage rows.
    const vcore = /^(GP|BC)_Gen5_(\d{1,2})$/i.exec(tier);
    if (vcore) return this._getSqlVcorePrice(vcore[1]!.toUpperCase() as 'GP' | 'BC', Number(vcore[2]), config, region);

    // The classic DTU tiers (Basic, S0-S12, P1-P15) are single meters. Any other tier name returns null here rather than matching some
    // unrelated meter, and the static table prices it.
    if (!/^(Basic|S\d{1,2}|P\d{1,2})$/i.test(tier)) return null;

    const filter = `serviceName eq 'SQL Database' and armRegionName eq '${region}' and skuName eq '${tier}' and priceType eq 'Consumption'`;
    let items: AzureRetailPriceItem[] = [];
    try {
      items = await this._fetchRetailPrices(filter);
    } catch {
      return null;
    }

    // EXACT sku match: contains(skuName,'S1') also matches 'S12' ($145/day) and 'PRS1', which is how a small database was priced at $100,000+/mo.
    const item = items.find((i) => i.skuName.toLowerCase() === tier.toLowerCase() && !/secondary/i.test(i.meterName) && i.retailPrice > 0);
    const computeMonthly = item ? monthlyFromRetailItem(item) : null;
    if (!item || computeMonthly === null) return null;

    // DTU tiers include storage up to a tier-specific size; only the excess over ~250GB is billed here.
    const storageMonthly = tier.toLowerCase() === 'basic' ? 0 : Math.max(0, maxSizeGb - 250) * 0.115;
    const monthlyPrice = computeMonthly + storageMonthly;

    return {
      provider: 'azure',
      service: 'SQL Database',
      resourceType: 'azure_sql',
      region,
      sku: tier,
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: computeMonthly / HOURS_PER_MONTH,
      monthlyPrice,
      currency: 'USD',
      description: `Azure SQL Database ${tier} (${maxSizeGb}GB max size)`,
      source: 'azure-retail-api',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `Database ${tier} list price: $${item.retailPrice} per ${item.unitOfMeasure} = $${computeMonthly.toFixed(2)}/mo`,
        storageMonthly > 0 ? `Storage above 250GB: $${storageMonthly.toFixed(2)}/mo` : 'Storage up to 250GB is included in the DTU price',
        `Region: ${region}`,
      ],
    };
  }

  /**
   * Azure SQL Database in the vCore model, General Purpose or Business Critical, Gen5. Three official meters make the monthly price:
   *  - compute: the row whose SKU is "<n> vCore" (its price is for all n vCores, per hour);
   *  - zone redundancy: a separate row, "<n> vCore Zone Redundancy", added when the database is zone redundant (the Multi-AZ counterpart);
   *  - storage: per GB for the maximum size, at the zone-redundant rate when zone redundant.
   * Azure SQL prices include the SQL Server license, which an AWS PostgreSQL instance does not have, and the assumptions say so. Null when
   * any needed row is missing, so the static table prices it and the line is labelled an estimate.
   */
  private async _getSqlVcorePrice(family: 'GP' | 'BC', vcores: number, config: Record<string, unknown>, region: string): Promise<NormalizedPrice | null> {
    const familyName = family === 'GP' ? 'General Purpose' : 'Business Critical';
    const zoneRedundant = config['zoneRedundant'] === true;
    const maxSizeGb = Number(config['maxSizeGb'] || 32);
    const filter = `serviceName eq 'SQL Database' and armRegionName eq '${region}' and priceType eq 'Consumption' and contains(productName,'Single/Elastic Pool ${familyName}')`;
    let items: AzureRetailPriceItem[] = [];
    try {
      items = await this._fetchRetailPrices(filter);
    } catch {
      return null;
    }
    const compute = items.find((i) => /Compute Gen5/i.test(i.productName) && i.skuName === `${vcores} vCore` && i.meterName === 'vCore' && i.retailPrice > 0);
    const zone = zoneRedundant ? items.find((i) => /Compute Gen5/i.test(i.productName) && i.skuName === `${vcores} vCore Zone Redundancy` && i.retailPrice > 0) : undefined;
    const storage = items.find((i) => /Storage/i.test(i.productName) && /Data Stored$/i.test(i.meterName) && !/Free/i.test(i.meterName) && (zoneRedundant ? /Zone Redundancy/i.test(i.skuName) : !/Zone Redundancy/i.test(i.skuName)) && i.retailPrice > 0);
    if (!compute || (zoneRedundant && !zone) || !storage) return null;
    const computeMonthly = monthlyFromRetailItem(compute);
    const zoneMonthly = zone ? monthlyFromRetailItem(zone) : 0;
    const storageMonthly = maxSizeGb * storage.retailPrice;
    if (computeMonthly === null || zoneMonthly === null) return null;
    const monthlyPrice = computeMonthly + zoneMonthly + storageMonthly;
    return {
      provider: 'azure',
      service: 'SQL Database',
      resourceType: 'azure_sql',
      region,
      sku: `${family}_Gen5_${vcores}${zoneRedundant ? '_ZR' : ''}`,
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: (computeMonthly + zoneMonthly) / HOURS_PER_MONTH,
      monthlyPrice,
      currency: 'USD',
      description: `Azure SQL Database ${familyName} Gen5, ${vcores} vCores${zoneRedundant ? ', zone redundant' : ''} (${maxSizeGb}GB)`,
      source: 'azure-retail-api',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `${familyName} ${vcores} vCore compute: ${compute.retailPrice} per Hour = ${computeMonthly.toFixed(2)}/mo`,
        ...(zone ? [`Zone redundancy: ${zone.retailPrice} per Hour = ${(zoneMonthly ?? 0).toFixed(2)}/mo`] : []),
        `Storage ${maxSizeGb}GB at ${storage.retailPrice}/GB-month = ${storageMonthly.toFixed(2)}/mo`,
        'Includes the SQL Server license; an AWS PostgreSQL instance has no license cost, so part of any gap is the license.',
        `Region: ${region}`,
      ],
    };
  }

  private async _getStoragePrice(config: Record<string, unknown>, region: string): Promise<NormalizedPrice | null> {
    const sku = (config['sku'] as string) || 'Standard_LRS';
    const capacityGb = Number(config['estimatedCapacityGb'] || 100);
    const redundancy = /RAGZRS/i.test(sku) ? 'RA-GZRS' : /GZRS/i.test(sku) ? 'GZRS' : /RAGRS|RA-GRS/i.test(sku) ? 'RA-GRS' : /GRS/i.test(sku) ? 'GRS' : /ZRS/i.test(sku) ? 'ZRS' : 'LRS';
    // Hot-tier block blob storage, first pricing tier. (A bare "LRS data stored" match picked up Cold, Files and Queue meters, $0.0036-0.06/GB.)
    const filter = `serviceName eq 'Storage' and armRegionName eq '${region}' and skuName eq 'Hot ${redundancy}' and contains(meterName, 'Data Stored') and priceType eq 'Consumption'`;

    let items: AzureRetailPriceItem[] = [];
    try {
      items = await this._fetchRetailPrices(filter);
    } catch {
      return null;
    }
    const blob = items
      .filter((i) => i.unitOfMeasure === '1 GB/Month' && i.retailPrice > 0 && /blob/i.test(i.productName) && !/hierarchical|data lake/i.test(i.productName))
      .sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits)[0];
    if (!blob) return null;

    const monthlyPrice = capacityGb * blob.retailPrice;
    return {
      provider: 'azure',
      service: 'Storage',
      resourceType: 'azure_storage',
      region,
      sku,
      pricingModel: 'consumption',
      unit: '1 GB/Month',
      unitPrice: blob.retailPrice,
      monthlyPrice,
      currency: 'USD',
      description: `Azure Blob Storage Hot ${redundancy} (${capacityGb}GB)`,
      source: 'azure-retail-api',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `Hot ${redundancy} rate: $${blob.retailPrice.toFixed(4)}/GB-month`,
        `Assumed capacity: ${capacityGb}GB`,
        'Transaction and network egress charges not included',
        `Region: ${region}`,
      ],
    };
  }

  private async _getLbPrice(config: Record<string, unknown>, region: string): Promise<NormalizedPrice | null> {
    const sku = (config['sku'] as string) || 'Standard';
    // The Basic Load Balancer is free (and being retired); only Standard is billed. Load Balancer meters are filed under the "Global" region.
    if (sku === 'Basic') return null;
    const filter = `serviceName eq 'Load Balancer' and armRegionName eq 'Global' and skuName eq 'Standard' and priceType eq 'Consumption'`;
    let items: AzureRetailPriceItem[] = [];
    try {
      items = await this._fetchRetailPrices(filter);
    } catch {
      return null;
    }
    const hourly = items.find((i) => /included lb rules/i.test(i.meterName) && i.retailPrice > 0)?.retailPrice;
    if (!hourly) return null;

    return {
      provider: 'azure',
      service: 'Load Balancer',
      resourceType: 'azure_lb',
      region,
      sku,
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: hourly,
      monthlyPrice: hourly * HOURS_PER_MONTH,
      currency: 'USD',
      description: `Azure Load Balancer ${sku}`,
      source: 'azure-retail-api',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `Includes the first 5 load-balancing/outbound rules: $${hourly.toFixed(4)}/hr`,
        'Data processed ($0.005/GB) and rules beyond 5 are not included',
        `Region: ${region}`,
      ],
    };
  }

  private async _getAppGatewayPrice(config: Record<string, unknown>, region: string): Promise<NormalizedPrice | null> {
    const waf = String(config['sku'] || 'Standard_v2').toLowerCase().includes('waf');
    const product = waf ? 'Application Gateway WAF v2' : 'Application Gateway Standard v2';
    const filter = `serviceName eq 'Application Gateway' and armRegionName eq '${region}' and productName eq '${product}' and priceType eq 'Consumption'`;
    let items: AzureRetailPriceItem[] = [];
    try {
      items = await this._fetchRetailPrices(filter);
    } catch {
      return null;
    }
    // Two hourly meters: the fixed gateway charge and one per capacity unit. (The old lookup took the first meter with "gateway" in its name,
    // which could belong to any SKU family, and ignored capacity units entirely.)
    const fixed = items.find((i) => /fixed cost/i.test(i.meterName) && i.retailPrice > 0)?.retailPrice;
    const unit = items.find((i) => /capacity units?/i.test(i.meterName) && i.retailPrice > 0)?.retailPrice;
    if (!fixed || !unit) return null;

    const capacity = Math.max(1, Number(config['autoscaleEnabled'] !== false ? config['minCapacity'] ?? 2 : config['capacity'] ?? 2));
    const hourly = fixed + unit * capacity;

    return {
      provider: 'azure',
      service: 'Application Gateway',
      resourceType: 'azure_app_gateway',
      region,
      sku: waf ? 'WAF_v2' : 'Standard_v2',
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: hourly,
      monthlyPrice: hourly * HOURS_PER_MONTH,
      currency: 'USD',
      description: `Azure Application Gateway ${waf ? 'WAF_v2' : 'Standard_v2'}`,
      source: 'azure-retail-api',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `Gateway fixed charge: $${fixed.toFixed(4)}/hr ($${(fixed * HOURS_PER_MONTH).toFixed(2)}/mo)`,
        `${capacity} capacity unit(s) at $${unit.toFixed(4)}/hr each: $${(unit * capacity * HOURS_PER_MONTH).toFixed(2)}/mo`,
        'Additional capacity units above the minimum are metered by traffic',
        `Region: ${region}`,
      ],
    };
  }

  private async _getFunctionsPrice(_config: Record<string, unknown>, region: string): Promise<NormalizedPrice> {
    // Consumption plan: first 1M executions and 400,000 GB-s are free
    const monthlyPrice = 5.0; // Typical small serverless baseline for warm instances/excess
    return {
      provider: 'azure',
      service: 'Functions',
      resourceType: 'azure_functions',
      region,
      sku: 'Consumption',
      pricingModel: 'consumption',
      unit: 'Execution / GB-s',
      unitPrice: 0.000016,
      monthlyPrice,
      currency: 'USD',
      description: 'Azure Functions Consumption Plan',
      // Not queried from the Retail Prices API (usage-tiered / flat baseline).
      source: 'azure-static-estimate',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        'Includes free monthly grant: 1M executions and 400,000 GB-s',
        'Baseline estimate assumes moderate production workload',
        `Region: ${region}`,
      ],
    };
  }

  private async _getAksPrice(_config: Record<string, unknown>, region: string): Promise<NormalizedPrice> {
    // AKS standard cluster management fee: free cluster tier available, or $0.10/hr for Uptime SLA
    const hourly = 0.10;
    return {
      provider: 'azure',
      service: 'Azure Kubernetes Service',
      resourceType: 'azure_aks',
      region,
      sku: 'Standard Tier (Uptime SLA)',
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: hourly,
      monthlyPrice: hourly * 730,
      currency: 'USD',
      description: 'AKS Cluster Management (Uptime SLA enabled)',
      // Not queried from the Retail Prices API (usage-tiered / flat baseline).
      source: 'azure-static-estimate',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        'Cluster management with 99.95% SLA: $0.10/hr',
        'Worker node VM costs calculated separately in node pool',
        `Region: ${region}`,
      ],
    };
  }

  /**
   * Front Door: the fixed monthly base fee of the SKU (Standard or Premium), from the official list. The fee is the same in every pricing
   * zone, so the rows are compared and the price is used only when they agree (the US Government zone is priced higher and is not meant).
   * Request and data-transfer charges depend on traffic, so they are not included, and the line says so.
   */
  private async _getFrontDoorPrice(config: Record<string, unknown>, region: string): Promise<NormalizedPrice | null> {
    const tier = /premium/i.test(String(config['sku'] ?? '')) ? 'Premium' : 'Standard';
    let items: AzureRetailPriceItem[] = [];
    try {
      items = await this._fetchRetailPrices("(serviceName eq 'Azure Front Door Service' or serviceName eq 'Azure Front Door') and priceType eq 'Consumption' and contains(meterName,'Base Fees')");
    } catch {
      return null;
    }
    const rows = items.filter((i) => i.skuName === tier && i.meterName === `${tier} Base Fees` && !/gov/i.test(i.armRegionName) && i.retailPrice > 0);
    const prices = [...new Set(rows.map((r) => r.retailPrice))];
    if (rows.length === 0 || prices.length !== 1) return null;
    const monthlyPrice = monthlyFromRetailItem(rows[0]!);
    if (monthlyPrice === null) return null;
    return {
      provider: 'azure',
      service: 'Azure Front Door',
      resourceType: 'azure_front_door',
      region,
      sku: tier,
      pricingModel: 'on-demand',
      unit: '1 Month',
      unitPrice: monthlyPrice / HOURS_PER_MONTH,
      monthlyPrice,
      currency: 'USD',
      description: `Azure Front Door ${tier} base fee`,
      source: 'azure-retail-api',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `${tier} base fee: ${rows[0]!.retailPrice} a month`,
        'Data transfer and request-volume charges not included',
        `Region: ${region}`,
      ],
    };
  }

  /**
   * Cosmos DB: official rates, with the usage the design cannot know stated as assumptions on the line.
   *  - Serverless: $ per million request units, times an assumed 100 million a month (estimatedMonthlyMillionRus), plus storage.
   *  - Provisioned (autoscale): the autoscale rate per 100 RU/s-hour times the maximum RU/s all month, which is an upper bound (autoscale drops
   *    to 10% of the maximum when idle), plus storage. The earlier built-in table used the manual-throughput rate here, a third too low.
   *  - Storage: $ per GB-month times an assumed 10 GB (estimatedStorageGb).
   * Null when any needed row is missing, so the built-in estimator (or the AI picker) prices it and the line is labelled accordingly.
   */
  private async _getCosmosPrice(config: Record<string, unknown>, region: string): Promise<NormalizedPrice | null> {
    const provisioned = String(config['throughputMode'] ?? 'Serverless') === 'Provisioned';
    const storageGb = Number(config['estimatedStorageGb'] ?? 10);
    if (!Number.isFinite(storageGb) || storageGb < 0) return null;
    let items: AzureRetailPriceItem[] = [];
    try {
      items = await this._fetchRetailPrices(`serviceName eq 'Azure Cosmos DB' and armRegionName eq '${region}' and priceType eq 'Consumption'`);
    } catch {
      return null;
    }
    const storage = items.find((i) => i.meterName === 'Data Stored' && i.skuName === (provisioned ? 'RUm' : 'RUs') && i.retailPrice > 0);
    if (!storage) return null;
    const storageMonthly = storageGb * storage.retailPrice;
    const assumptions: string[] = [];
    let throughputMonthly: number;
    let label: string;
    if (provisioned) {
      const maxRu = Math.max(1000, Number(config['maxThroughputRu'] ?? 4000));
      const autoscale = items.find((i) => /autoscale/i.test(i.productName) && /100 RUs$/.test(i.meterName) && /hour/i.test(i.unitOfMeasure) && i.retailPrice > 0);
      if (!autoscale) return null;
      throughputMonthly = (maxRu / 100) * autoscale.retailPrice * HOURS_PER_MONTH;
      label = `autoscale ${maxRu} RU/s max`;
      assumptions.push(`Autoscale ${maxRu} RU/s at ${autoscale.retailPrice} per 100 RU/s-hour = ${throughputMonthly.toFixed(2)}/mo`);
      assumptions.push('Assumed billed at the maximum RU/s all month, an upper bound: autoscale drops to 10% of the maximum when idle');
    } else {
      const serverless = items.find((i) => /serverless/i.test(i.productName) && i.meterName === '1M RUs' && i.retailPrice > 0);
      if (!serverless) return null;
      const millionRus = Number(config['estimatedMonthlyMillionRus'] ?? 100);
      if (!Number.isFinite(millionRus) || millionRus < 0) return null;
      throughputMonthly = millionRus * serverless.retailPrice;
      label = `serverless, ${millionRus} million RUs`;
      assumptions.push(`Serverless: ${serverless.retailPrice} per million request units = ${throughputMonthly.toFixed(2)}/mo`);
      assumptions.push(`Assumed usage: ${millionRus} million request units a month (set estimatedMonthlyMillionRus to change it)`);
    }
    assumptions.push(`Assumed storage: ${storageGb} GB at ${storage.retailPrice} per GB-month = ${storageMonthly.toFixed(2)}/mo (set estimatedStorageGb to change it)`);
    assumptions.push('Backups beyond the free periodic backup, multi-region replication and analytical storage not included');
    assumptions.push(`Region: ${region}`);
    const monthlyPrice = throughputMonthly + storageMonthly;
    return {
      provider: 'azure',
      service: 'Azure Cosmos DB',
      resourceType: 'azure_cosmos_db',
      region,
      sku: provisioned ? 'Autoscale' : 'Serverless',
      pricingModel: 'consumption',
      unit: provisioned ? '100 RU/s-hour' : '1M RUs',
      unitPrice: monthlyPrice / HOURS_PER_MONTH,
      monthlyPrice,
      currency: 'USD',
      description: `Azure Cosmos DB (${label}, ${storageGb} GB)`,
      source: 'azure-retail-api',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions,
    };
  }

  private async _getKeyVaultPrice(_config: Record<string, unknown>, region: string): Promise<NormalizedPrice> {
    const monthlyPrice = 3.0; // Standard operations allowance (~100k ops @ $0.03/10k)
    return {
      provider: 'azure',
      service: 'Key Vault',
      resourceType: 'azure_key_vault',
      region,
      sku: 'Standard',
      pricingModel: 'consumption',
      unit: '10,000 Operations',
      unitPrice: 0.03,
      monthlyPrice,
      currency: 'USD',
      description: 'Azure Key Vault Standard',
      // Not queried from the Retail Prices API (usage-tiered / flat baseline).
      source: 'azure-static-estimate',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        'Standard secrets and software-protected keys',
        'Estimated 100,000 operations/month: ~$3.00/mo',
        `Region: ${region}`,
      ],
    };
  }
}

export const azurePricingProvider = new AzurePricingProvider();
