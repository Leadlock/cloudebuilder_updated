/**
 * Regression tests for wrong Azure prices in the cost estimate and the AWS-vs-Azure comparison.
 * Fixtures are real Retail Prices API rows (eastus, captured 2026-10-05). No network: global.fetch is replaced per test.
 *
 * Bug being pinned: the SQL lookup used contains(skuName,'S1'), which also matched 'S12' ($145.17 per DAY), and treated the per-day price as
 * per-hour, so a small Azure SQL database showed about $105,980/month.
 */
import { AzurePricingProvider, monthlyFromRetailItem, type AzureRetailPriceItem } from '@/lib/cloud/pricing/AzurePricingProvider';
import { azurePricingProvider as staticAzure } from '@/lib/engines/cost/azurePricing';
import { CostEstimator } from '@/lib/engines/cost/CostEstimator';
import { CloudCostComparisonService } from '@/lib/engines/comparison/CloudCostComparisonService';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

const guardedFetch = global.fetch;
afterEach(() => { global.fetch = guardedFetch; jest.restoreAllMocks(); });

const row = (o: Partial<AzureRetailPriceItem>): AzureRetailPriceItem => ({
  currencyCode: 'USD', tierMinimumUnits: 0, retailPrice: 0, unitPrice: 0, armRegionName: 'eastus', location: 'US East', effectiveStartDate: '',
  meterId: '', meterName: '', productId: '', skuId: '', productName: '', skuName: '', serviceName: '', serviceId: '', serviceFamily: '', unitOfMeasure: '1 Hour', type: 'Consumption', ...o,
});
const serve = (items: AzureRetailPriceItem[]) => {
  global.fetch = jest.fn(() => Promise.resolve(new Response(JSON.stringify({ Items: items, Count: items.length }), { status: 200 }))) as unknown as typeof fetch;
};
const prov = new AzurePricingProvider();
const sqlQuery = (tier: string, maxSizeGb = 250) => ({ provider: 'azure' as const, resourceType: 'azure_sql', region: 'eastus', configuration: { tier, maxSizeGb } });

const SQL_ROWS = [
  row({ skuName: 'PRS1', meterName: 'PRS1 DTU', unitOfMeasure: '1/Day', retailPrice: 3.75 }),
  row({ skuName: 'S12', meterName: '10 DTUs', unitOfMeasure: '1/Day', retailPrice: 145.17 }),
  row({ skuName: 'S1 Secondary', meterName: 'S1 Secondary DTUs', unitOfMeasure: '1/Day', retailPrice: 0.73 }),
  row({ skuName: 'S1', meterName: 'S1 DTUs', unitOfMeasure: '1/Day', retailPrice: 0.9677 }),
];

describe('unit conversion', () => {
  test.each([
    ['1 Hour', 0.2, 146],
    ['1/Hour', 0.2, 146],
    ['1/Day', 1, 730 / 24],
    ['1/Month', 35, 35],
  ])('%s', (unitOfMeasure, retailPrice, expected) => {
    expect(monthlyFromRetailItem({ unitOfMeasure, retailPrice })).toBeCloseTo(expected, 6);
  });
  test.each(['1 GB', '1 GB/Month', '1K', '10K'])('%s is not a time-based charge', (unitOfMeasure) => {
    expect(monthlyFromRetailItem({ unitOfMeasure, retailPrice: 0.01 })).toBeNull();
  });
});

/** Real vCore rows (eastus, captured 2026-10-07): the compute price is for all n vCores, zone redundancy is its own row, storage is per GB. */
const GP = 'SQL Database Single/Elastic Pool General Purpose - Compute Gen5';
const VCORE_ROWS = [
  row({ serviceName: 'SQL Database', productName: GP, skuName: '2 vCore', meterName: 'vCore', retailPrice: 0.304434 }),
  row({ serviceName: 'SQL Database', productName: GP, skuName: '4 vCore', meterName: 'vCore', retailPrice: 0.608868 }),
  row({ serviceName: 'SQL Database', productName: GP, skuName: '2 vCore Zone Redundancy', meterName: 'Zone Redundancy vCore', retailPrice: 0.18266 }),
  row({ serviceName: 'SQL Database', productName: 'SQL Database Single/Elastic Pool General Purpose - Storage', skuName: 'General Purpose', meterName: 'General Purpose Data Stored', unitOfMeasure: '1 GB/Month', retailPrice: 0.115 }),
  row({ serviceName: 'SQL Database', productName: 'SQL Database Single/Elastic Pool General Purpose - Storage', skuName: 'General Purpose', meterName: 'General Purpose Data Stored - Free', unitOfMeasure: '1 GB/Month', retailPrice: 0 }),
  row({ serviceName: 'SQL Database', productName: 'SQL Database Single/Elastic Pool General Purpose - Storage', skuName: 'General Purpose Zone Redundancy', meterName: 'General Purpose Zone Redundancy Data Stored', unitOfMeasure: '1 GB/Month', retailPrice: 0.23 }),
];

describe('Azure SQL Database, vCore model (live)', () => {
  const vq = (zoneRedundant: boolean, maxSizeGb = 200) => ({ provider: 'azure' as const, resourceType: 'azure_sql', region: 'eastus', configuration: { tier: 'GP_Gen5_2', maxSizeGb, zoneRedundant } });

  test('2 vCores, zone redundant, 200 GB: compute + zone redundancy + storage at the zone-redundant rate (hand-checked $401.60)', async () => {
    serve(VCORE_ROWS);
    const p = await prov.getPrice(vq(true));
    expect(p!.source).toBe('azure-retail-api');
    expect(p!.monthlyPrice).toBeCloseTo((0.304434 + 0.18266) * 730 + 200 * 0.23, 2);
    expect(p!.assumptions.join(' ')).toMatch(/license/);
  });

  test('not zone redundant: no zone-redundancy row and the ordinary storage rate (hand-checked $245.23)', async () => {
    serve(VCORE_ROWS);
    const p = await prov.getPrice(vq(false));
    expect(p!.monthlyPrice).toBeCloseTo(0.304434 * 730 + 200 * 0.115, 2);
  });

  test('a missing row is not guessed from another size (null, so the static table prices it)', async () => {
    serve(VCORE_ROWS.filter((r) => r.skuName !== '2 vCore Zone Redundancy'));
    expect(await prov.getPrice(vq(true))).toBeNull();
  });
});
describe('Azure SQL Database (live)', () => {
  test('S1 matches only the S1 meter and converts per-day to per-month (about $29, not $100,000)', async () => {
    serve(SQL_ROWS);
    const p = await prov.getPrice(sqlQuery('S1'));
    expect(p!.source).toBe('azure-retail-api');
    expect(p!.monthlyPrice).toBeCloseTo(0.9677 * (730 / 24), 2); // 29.43
    expect(p!.monthlyPrice).toBeLessThan(40);
  });

  test('a tier with no exact meter is not priced from a lookalike (null, so the static table is used)', async () => {
    serve(SQL_ROWS.filter((r) => r.skuName !== 'S1'));
    expect(await prov.getPrice(sqlQuery('S1'))).toBeNull();
  });

  test('vCore tiers are left to the static table, never matched to a DTU meter', async () => {
    serve(SQL_ROWS);
    expect(await prov.getPrice(sqlQuery('GP_Gen5_2'))).toBeNull();
    expect(await prov.getPrice(sqlQuery('GeneralPurpose'))).toBeNull();
  });
});

describe('Azure Blob storage (live)', () => {
  test('uses the first Hot LRS block-blob tier, not Cold, Files or Queue meters', async () => {
    serve([
      row({ skuName: 'Hot LRS', meterName: 'Hot LRS Data Stored', productName: 'Blob Storage', unitOfMeasure: '1 GB/Month', retailPrice: 0.019136, tierMinimumUnits: 500000 }),
      row({ skuName: 'Hot LRS', meterName: 'Hot LRS Data Stored', productName: 'Blob Storage', unitOfMeasure: '1 GB/Month', retailPrice: 0.0208, tierMinimumUnits: 0 }),
      row({ skuName: 'Hot LRS', meterName: 'Hot LRS Data Stored', productName: 'Files', unitOfMeasure: '1 GB/Month', retailPrice: 0.06 }),
    ]);
    const p = await prov.getPrice({ provider: 'azure', resourceType: 'azure_storage', region: 'eastus', configuration: { sku: 'Standard_LRS', estimatedCapacityGb: 100 } });
    expect(p!.monthlyPrice).toBeCloseTo(2.08, 2);
  });
});

describe('Azure Load Balancer and Application Gateway (live)', () => {
  test('Standard LB is $0.025/hr (about $18.25/mo)', async () => {
    serve([
      row({ skuName: 'Standard', meterName: 'Standard Data Processed', unitOfMeasure: '1 GB', retailPrice: 0.005 }),
      row({ skuName: 'Standard', meterName: 'Standard Included LB Rules and Outbound Rules', retailPrice: 0.025 }),
    ]);
    const p = await prov.getPrice({ provider: 'azure', resourceType: 'azure_lb', region: 'eastus', configuration: { sku: 'Standard' } });
    expect(p!.monthlyPrice).toBeCloseTo(18.25, 2);
  });

  test('Application Gateway = fixed charge + capacity units of the right SKU family', async () => {
    serve([
      row({ productName: 'Application Gateway Standard v2', meterName: 'Standard Fixed Cost', retailPrice: 0.2 }),
      row({ productName: 'Application Gateway Standard v2', meterName: 'Standard Capacity Units', retailPrice: 0.008 }),
    ]);
    const p = await prov.getPrice({ provider: 'azure', resourceType: 'azure_app_gateway', region: 'eastus', configuration: { sku: 'Standard_v2', minCapacity: 2 } });
    expect(p!.monthlyPrice).toBeCloseTo((0.2 + 2 * 0.008) * 730, 2); // 157.68
  });
});

describe('static fallback table', () => {
  const res = (resourceType: string): DbArchitectureResource => ({ id: 'r1', label: 'r', resourceType, provider: 'azure' } as unknown as DbArchitectureResource);
  const monthly = (type: string, config: Record<string, unknown>) => staticAzure.estimateResource(res(type), config, 'eastus')!.monthlyUsd;

  test('Azure SQL DTU tiers match the published monthly prices', () => {
    expect(monthly('azure_sql', { tier: 'S0', maxSizeGb: 0 })).toBeCloseTo(14.6, 0);   // list $14.52
    expect(Math.abs(monthly('azure_sql', { tier: 'S3', maxSizeGb: 0 }) - 147.2)).toBeLessThan(3); // list $147.2
    expect(monthly('azure_sql', { tier: 'P1', maxSizeGb: 0 })).toBeGreaterThan(400);   // list ~$456; was $1,140
    expect(monthly('azure_sql', { tier: 'P1', maxSizeGb: 0 })).toBeLessThan(500);
  });
  test('Standard Load Balancer is about $18/mo, Basic is free', () => {
    expect(monthly('azure_lb', { sku: 'Standard' })).toBeCloseTo(18.25, 2);
    expect(monthly('azure_lb', { sku: 'Basic' })).toBe(0);
  });
  test('Application Gateway v2 fixed charges', () => {
    expect(monthly('azure_app_gateway', { sku: 'Standard_v2', minCapacity: 2 })).toBeCloseTo((0.2 + 0.016) * 730, 1);
    expect(monthly('azure_app_gateway', { sku: 'WAF_v2', minCapacity: 2 })).toBeCloseTo((0.36 + 0.0288) * 730, 1);
  });
});

describe('end to end: a small three-service stack never prices a database in the thousands', () => {
  test('AWS RDS translated to Azure SQL, priced through the live path with the real S-tier rows', async () => {
    serve(SQL_ROWS);
    const [db] = CloudCostComparisonService.translateResources(
      [{ id: 'db', label: 'Orders DB (PostgreSQL)', resourceType: 'aws_rds', provider: 'aws', region: 'us-east-1', configJson: JSON.stringify({ instanceClass: 'db.t3.small', engine: 'postgres', allocatedStorage: 50 }) }],
      'azure',
    );
    const est = await new CostEstimator({
      pricing: { getPrice: (q) => prov.getPrice(q).then((p) => p ?? ({ source: 'unavailable' } as never)) },
    }).estimateAsync({ architectureId: 'a', projectId: 'p', resources: [db as unknown as DbArchitectureResource] });
    expect(est.totalMonthlyUsd).toBeGreaterThan(5);
    // A 2-vCPU database maps to GP_Gen5_2 (2 vCores). The fixture has no vCore rows, so the static table prices it.
    expect(est.totalMonthlyUsd).toBeLessThan(400);
  });
});
