/**
 * Cost accuracy regressions found by checking an AI-generated e-commerce design against the providers' own price lists:
 *  - an Auto Scaling group was free, so the AWS total left out the whole application tier;
 *  - calculateCosts (dashboard cards, template totals, autofix) was a third, cruder calculator that priced every RDS instance at $48.60;
 *  - an Azure Public IP was priced by the AI adding an address meter to an unrelated Public IP Prefix meter ($8.03 instead of $3.65);
 *  - Azure NAT Gateway got an "official" price from the AI picker although the price list has no NAT rows.
 */
import { calculateCosts } from '@/lib/analysis';
import { AzurePricingProvider } from '@/lib/cloud/pricing/AzurePricingProvider';
import { AZURE_METER_SOURCES } from '@/lib/cost/ai/meterPicker';
import { autoScalingAsInstances } from '@/lib/engines/cost/autoScaling';
import { estimateCloudFront } from '@/lib/engines/cost/cloudfrontEstimate';
import { AwsPricingProvider } from '@/lib/cloud/pricing/AwsPricingProvider';
import { CloudCostComparisonService } from '@/lib/engines/comparison/CloudCostComparisonService';
import { pickAzureMeters } from '@/lib/cost/ai/meterPicker';
import { awsPricingProvider } from '@/lib/engines/cost/awsPricing';
import type { CanvasNode } from '@/types';

function node(id: string, resourceType: string, provider: 'aws' | 'azure', config: Record<string, unknown>, label = id): CanvasNode {
  return { id, type: 'cloudNode', resourceType, provider, label, position: { x: 0, y: 0 }, config } as CanvasNode;
}
const total = (nodes: CanvasNode[]) => calculateCosts(nodes).reduce((s, c) => s + c.monthlyCost, 0);

describe('autoScalingAsInstances', () => {
  test('uses the desired capacity, then the minimum, then the resource default of 2', () => {
    expect(autoScalingAsInstances({ instanceType: 'm5.large', desiredCapacity: 5, minSize: 2 }).quantity).toBe(5);
    expect(autoScalingAsInstances({ instanceType: 'm5.large', minSize: 3 }).quantity).toBe(3);
    expect(autoScalingAsInstances({}).quantity).toBe(2);
    expect(autoScalingAsInstances({}).instanceType).toBe('t3.medium');
  });

  test('ignores nonsense capacity values instead of pricing them', () => {
    expect(autoScalingAsInstances({ desiredCapacity: -4, minSize: 'abc' }).quantity).toBe(2);
    expect(autoScalingAsInstances({ desiredCapacity: '3' }).quantity).toBe(3);
  });

  test('a desired capacity of 0 is respected, not replaced by a default', () => {
    expect(autoScalingAsInstances({ desiredCapacity: 0, minSize: 2 }).quantity).toBe(0);
  });
});

describe('calculateCosts uses the same built-in prices as the Cost Estimate screen', () => {
  test('an Auto Scaling group is no longer free', () => {
    const items = calculateCosts([node('asg', 'aws_auto_scaling', 'aws', { instanceType: 't3.medium', desiredCapacity: 2 })]);
    expect(items).toHaveLength(1);
    expect(items[0].monthlyCost).toBeGreaterThan(60);
    expect(items[0].breakdown[0].label).toMatch(/^2 × /);
  });

  test('an AWS design made only of Auto Scaling groups has a compute cost', () => {
    expect(total([node('a', 'aws_auto_scaling', 'aws', {}), node('b', 'aws_auto_scaling', 'aws', {})])).toBeGreaterThan(120);
  });

  test('RDS price depends on the instance class and Multi-AZ (it was a flat $48.60 + $23)', () => {
    const rds = (cfg: Record<string, unknown>) => total([node('db', 'aws_rds', 'aws', { engine: 'postgres', allocatedStorage: 100, ...cfg })]);
    expect(rds({ instanceClass: 'db.r5.xlarge' })).toBeGreaterThan(rds({ instanceClass: 'db.t3.medium' }));
    expect(rds({ instanceClass: 'db.m5.large', multiAz: true })).toBeGreaterThan(rds({ instanceClass: 'db.m5.large' }) * 1.9);
  });

  test('matches the estimator for the same resource', () => {
    const alb = calculateCosts([node('lb', 'aws_alb', 'aws', {})])[0];
    expect(alb.monthlyCost).toBeCloseTo(0.0225 * 730 + 0.008 * 730, 2);
    const direct = awsPricingProvider.estimateResource(
      { id: 'lb', resourceType: 'aws_alb', provider: 'aws', label: 'lb', positionX: 0, positionY: 0, configJson: '{}', region: 'us-east-1', groupId: null, locked: false, architectureId: '' },
      {}, 'us-east-1',
    );
    expect(alb.monthlyCost).toBeCloseTo(direct!.monthlyUsd, 6);
  });

  test('free resources are still left out, and Azure resources are priced too', () => {
    expect(calculateCosts([node('v', 'aws_vpc', 'aws', {}), node('s', 'aws_subnet', 'aws', {})])).toEqual([]);
    expect(total([node('ip', 'azure_public_ip', 'azure', { sku: 'Standard' })])).toBeCloseTo(0.005 * 730, 2);
  });
});

describe('Azure Public IP and NAT Gateway', () => {
  const row = (meterName: string, retailPrice: number, productName = 'IP Addresses', skuName = 'Standard') => ({
    currencyCode: 'USD', tierMinimumUnits: 0, retailPrice, unitPrice: retailPrice, armRegionName: 'eastus', location: 'US East', effectiveStartDate: '',
    meterId: meterName, meterName, productId: '', skuId: '', productName, skuName, serviceName: 'Virtual Network', serviceId: '', serviceFamily: 'Networking',
    unitOfMeasure: '1 Hour', type: 'Consumption',
  });
  const rows = [
    row('Standard IPv4 Static Public IP', 0.005),
    row('Basic IPv4 Static Public IP', 0.0036, 'IP Addresses', 'Basic'),
    row('Basic IPv4 Dynamic Public IP', 0.004, 'IP Addresses', 'Basic'),
    row('Global IPv4 Static Public IP', 0.01, 'IP Addresses', 'Global'),
  ];
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((async () => ({ ok: true, json: async () => ({ Items: rows }) })) as never);
  });
  afterEach(() => fetchSpy.mockRestore());

  test('a Standard public IP is the one address meter, $3.65 a month, with no AI involved', async () => {
    const provider = new AzurePricingProvider({ aiMeterMatching: false });
    const p = await provider.getPrice({ provider: 'azure', resourceType: 'azure_public_ip', region: 'eastus', configuration: { sku: 'Standard' } });
    expect(p?.source).toBe('azure-retail-api');
    expect(p?.monthlyPrice).toBeCloseTo(3.65, 2);
  });

  test('a Basic IP uses its static or dynamic meter', async () => {
    const provider = new AzurePricingProvider({ aiMeterMatching: false });
    const stat = await provider.getPrice({ provider: 'azure', resourceType: 'azure_public_ip', region: 'eastus', configuration: { sku: 'Basic', allocationMethod: 'Static' } });
    const dyn = await provider.getPrice({ provider: 'azure', resourceType: 'azure_public_ip', region: 'eastus', configuration: { sku: 'Basic', allocationMethod: 'Dynamic' } });
    expect(stat?.monthlyPrice).toBeCloseTo(0.0036 * 730, 2);
    expect(dyn?.monthlyPrice).toBeCloseTo(0.004 * 730, 2);
  });

  test('no price is invented when the meter is missing', async () => {
    fetchSpy.mockImplementation((async () => ({ ok: true, json: async () => ({ Items: [row('Public IP Prefix thing', 0.006, 'Public IP Prefix')] }) })) as never);
    const p = await new AzurePricingProvider({ aiMeterMatching: false }).getPrice({ provider: 'azure', resourceType: 'azure_public_ip', region: 'eastus', configuration: {} });
    expect(p).toBeNull();
  });

  test('neither type is left to the AI meter picker any more', () => {
    expect(AZURE_METER_SOURCES['azure_public_ip']).toBeUndefined();
    expect(AZURE_METER_SOURCES['azure_nat']).toBeUndefined();
  });

  test('NAT Gateway falls back to the built-in estimate instead of an AI-picked "official" price', async () => {
    const asked = jest.fn();
    const provider = new AzurePricingProvider({ aiMeterMatching: true, ask: asked as never });
    const p = await provider.getPrice({ provider: 'azure', resourceType: 'azure_nat', region: 'eastus', configuration: {} });
    expect(p).toBeNull(); // the caller then uses the built-in table, labelled as an estimate
    expect(asked).not.toHaveBeenCalled();
    expect(total([node('n', 'azure_nat', 'azure', {})])).toBeCloseTo(0.045 * 730 + 4.5, 2);
  });
});

describe('CloudFront: one estimate, both built-in fallbacks agree', () => {
  const resource = (config: Record<string, unknown>) => ({
    id: 'cf', resourceType: 'aws_cloudfront', provider: 'aws', label: 'cf', positionX: 0, positionY: 0, configJson: JSON.stringify(config),
    region: 'us-east-1', groupId: null, locked: false, architectureId: '',
  });

  test('default traffic is 1,000 GB and 10M requests, and the free tier is not applied', () => {
    const e = estimateCloudFront({ managedWaf: false });
    expect(e.dataGb).toBe(1000);
    expect(e.requests).toBe(10_000_000);
    expect(e.monthlyUsd).toBeCloseTo(85 + 10, 2);
    // by default the generated Terraform also adds a managed web ACL: $5 + 2 x $1 + $0.60 per million requests
    expect(estimateCloudFront({}).monthlyUsd).toBeCloseTo(85 + 10 + 13, 2);
    expect(e.assumptions.join(' ')).toMatch(/not applied/);
  });

  test('the two static tables return the same figure for the same settings (they used to be $12 flat in one and $12-$22 in the other)', async () => {
    for (const cfg of [{}, { priceClass: 'PriceClass_200', estimatedDataTransferGb: 4000 }, { webAclId: 'arn:x', estimatedRequests: 50_000_000 }]) {
      const engine = awsPricingProvider.estimateResource(resource(cfg), cfg, 'us-east-1')!.monthlyUsd;
      const provider = await new AwsPricingProvider().getPrice({ provider: 'aws', resourceType: 'aws_cloudfront', region: 'us-east-1', configuration: cfg });
      expect(provider!.monthlyPrice).toBeCloseTo(engine, 6);
    }
  });

  test('bad traffic values fall back to the defaults instead of producing NaN', () => {
    const e = estimateCloudFront({ estimatedDataTransferGb: 'lots', estimatedRequests: -5 });
    expect(Number.isFinite(e.monthlyUsd)).toBe(true);
    expect(e.dataGb).toBe(1000);
    expect(e.requests).toBe(10_000_000);
  });
});

describe('Auto Scaling group <-> VM scale set comparison', () => {
  const asg = (config: Record<string, unknown>) => ({ id: 'a', type: 'cloudNode', resourceType: 'aws_auto_scaling', provider: 'aws', label: 'a', position: { x: 0, y: 0 }, config }) as CanvasNode;

  test('translates to azure_vmss with the size matched by vCPU and RAM and the capacity carried over', () => {
    const [t] = CloudCostComparisonService.translateNodes([asg({ instanceType: 't3.large', desiredCapacity: 4, minSize: 2 })], 'azure');
    expect(t.resourceType).toBe('azure_vmss');
    expect(t.provider).toBe('azure');
    expect(t.config['sku']).toBe('Standard_D2s_v3'); // 2 vCPU / 8 GB, not the old default 2 vCPU / 4 GB Standard_B2s
    expect(t.config['capacity']).toBe(4);
    expect(t.config['instanceType']).toBeUndefined();
  });

  test('a bigger instance maps to a bigger size, and a missing capacity falls back to the minimum then 2', () => {
    const [big] = CloudCostComparisonService.translateNodes([asg({ instanceType: 'c6g.2xlarge', minSize: 3 })], 'azure');
    expect(big.config['capacity']).toBe(3);
    expect(String(big.config['sku'])).not.toBe('Standard_B2s');
    const [none] = CloudCostComparisonService.translateNodes([asg({})], 'azure');
    expect(none.config['capacity']).toBe(2);
  });

  test('round-trips back to an Auto Scaling group', () => {
    const [vmss] = CloudCostComparisonService.translateNodes([asg({ instanceType: 'm5.large', desiredCapacity: 5 })], 'azure');
    const [back] = CloudCostComparisonService.translateNodes([vmss], 'aws');
    expect(back.resourceType).toBe('aws_auto_scaling');
    expect(back.config['desiredCapacity']).toBe(5);
    // m5.large and t3.large are both 2 vCPU / 8 GB, so the round trip returns an equivalent instance rather than the identical type
    expect(['t3.large', 'm5.large']).toContain(back.config['instanceType']);
  });

  test('the translated scale set is priced at that size and capacity, so both clouds count the same instances', () => {
    const aws = total([node('g', 'aws_auto_scaling', 'aws', { instanceType: 't3.large', desiredCapacity: 2 })]);
    const [t] = CloudCostComparisonService.translateNodes([asg({ instanceType: 't3.large', desiredCapacity: 2 })], 'azure');
    const azure = total([t]);
    expect(azure).toBeGreaterThan(aws * 0.8);
    expect(azure).toBeLessThan(aws * 1.3);
  });
});

describe('AI meter matching tolerance', () => {
  test('an AI-picked price more than 3x away from the built-in estimate is rejected (it used to allow 8x)', async () => {
    const row = (meterName: string, retailPrice: number) => ({
      currencyCode: 'USD', tierMinimumUnits: 0, retailPrice, unitPrice: retailPrice, armRegionName: 'eastus', location: 'US East', effectiveStartDate: '',
      meterId: meterName, meterName, productId: '', skuId: '', productName: 'Redis Cache', skuName: 'Standard', serviceName: 'Redis Cache', serviceId: '',
      serviceFamily: 'Databases', unitOfMeasure: '1 Hour', type: 'Consumption',
    });
    const rows = [row('C1 Cache', 0.0116)]; // $8.47/mo, about 4.4x below an anchor of $37.35
    const ask = (async () => ({ picks: [{ i: 0, quantity: 1 }] })) as never;
    const base = { resourceType: 'azure_redis', region: 'eastus', config: { sku: 'Standard' }, rows: rows as never, ask };
    expect(await pickAzureMeters({ ...base, anchorMonthlyUsd: 37.35 })).toBeNull();
    expect(await pickAzureMeters({ ...base, anchorMonthlyUsd: 8.5 })).not.toBeNull();
  });
});
