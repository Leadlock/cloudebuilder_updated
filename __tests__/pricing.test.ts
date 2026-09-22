/**
 * Tests for Real Cloud Pricing, Normalized Pricing Service, Caching, and Authoritative Regions.
 */
import {
  cloudRegionService,
  AUTHORITATIVE_AWS_REGIONS,
  AUTHORITATIVE_AZURE_REGIONS,
} from '@/lib/cloud/regions/CloudRegionService';
import { AwsPricingProvider } from '@/lib/cloud/pricing/AwsPricingProvider';
import { AzurePricingProvider } from '@/lib/cloud/pricing/AzurePricingProvider';
import { PricingCache } from '@/lib/cloud/pricing/PricingCache';
import { CloudProviderPricingService } from '@/lib/cloud/pricing/CloudProviderPricingService';
import { CostEstimator } from '@/lib/engines/cost/CostEstimator';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

function makeResource(overrides: Partial<DbArchitectureResource>): DbArchitectureResource {
  return {
    id: 'res-test-1',
    resourceType: 'aws_ec2',
    provider: 'aws',
    label: 'Test Instance',
    positionX: 100,
    positionY: 100,
    configJson: '{}',
    region: 'us-east-1',
    groupId: null,
    locked: false,
    architectureId: 'arch-test',
    ...overrides,
  };
}

describe('Authoritative Cloud Regions', () => {
  test('AWS authoritative regions include major commercial regions', () => {
    const ids = AUTHORITATIVE_AWS_REGIONS.map((r) => r.id);
    expect(ids).toContain('us-east-1');
    expect(ids).toContain('us-west-2');
    expect(ids).toContain('eu-west-1');
    expect(ids).toContain('ap-south-1');
    expect(ids).toContain('af-south-1');
    expect(AUTHORITATIVE_AWS_REGIONS.length).toBeGreaterThanOrEqual(25);
  });

  test('Azure authoritative regions include major commercial regions', () => {
    const ids = AUTHORITATIVE_AZURE_REGIONS.map((r) => r.id);
    expect(ids).toContain('eastus');
    expect(ids).toContain('westeurope');
    expect(ids).toContain('centralindia');
    expect(ids).toContain('southeastasia');
    expect(ids).toContain('brazilsouth');
    expect(AUTHORITATIVE_AZURE_REGIONS.length).toBeGreaterThanOrEqual(30);
  });

  test('CloudRegionService retrieves and validates regions', () => {
    expect(cloudRegionService.isValidRegion('aws', 'us-east-1')).toBe(true);
    expect(cloudRegionService.isValidRegion('aws', 'ap-south-1')).toBe(true);
    expect(cloudRegionService.isValidRegion('azure', 'eastus')).toBe(true);
    expect(cloudRegionService.isValidRegion('azure', 'centralindia')).toBe(true);
    expect(cloudRegionService.isValidRegion('aws', 'non-existent-region-99')).toBe(false);

    const region = cloudRegionService.getRegion('aws', 'ap-south-1');
    expect(region).toBeDefined();
    expect(region!.displayName).toContain('Mumbai');
    expect(region!.geography).toBe('Asia Pacific');

    const label = cloudRegionService.getRegionLabel('azure', 'centralindia');
    expect(label).toContain('India');
  });

  test('CloudRegionService provides default regions', () => {
    expect(cloudRegionService.getDefaultRegion('aws')).toBe('us-east-1');
    expect(cloudRegionService.getDefaultRegion('azure')).toBe('eastus');
  });
});

describe('AwsPricingProvider (Real Data & Configuration Awareness)', () => {
  const provider = new AwsPricingProvider();

  test('EC2 configuration-aware pricing for t3.micro vs m5.large', async () => {
    const t3Price = await provider.getPrice({
      provider: 'aws',
      resourceType: 'aws_ec2',
      region: 'us-east-1',
      configuration: { instanceType: 't3.micro', storageGb: 20 },
    });
    expect(t3Price).not.toBeNull();
    expect(t3Price!.unitPrice).toBeCloseTo(0.0104, 3);
    expect(t3Price!.monthlyPrice).toBeGreaterThan(0);
    expect(t3Price!.currency).toBe('USD');
    expect(t3Price!.source).toContain('aws');

    const m5Price = await provider.getPrice({
      provider: 'aws',
      resourceType: 'aws_ec2',
      region: 'us-east-1',
      configuration: { instanceType: 'm5.large', storageGb: 50 },
    });
    expect(m5Price).not.toBeNull();
    expect(m5Price!.monthlyPrice).toBeGreaterThan(t3Price!.monthlyPrice);
  });

  test('RDS Multi-AZ doubles instance rate', async () => {
    const singleAz = await provider.getPrice({
      provider: 'aws',
      resourceType: 'aws_rds',
      region: 'us-east-1',
      configuration: { instanceClass: 'db.t3.micro', multiAz: false, allocatedStorage: 20 },
    });
    const multiAz = await provider.getPrice({
      provider: 'aws',
      resourceType: 'aws_rds',
      region: 'us-east-1',
      configuration: { instanceClass: 'db.t3.micro', multiAz: true, allocatedStorage: 20 },
    });
    expect(singleAz).not.toBeNull();
    expect(multiAz).not.toBeNull();
    expect(multiAz!.unitPrice).toBeCloseTo(singleAz!.unitPrice * 2, 2);
    expect(multiAz!.monthlyPrice).toBeGreaterThan(singleAz!.monthlyPrice);
  });

  test('S3 standard tier storage pricing', async () => {
    const s3Price = await provider.getPrice({
      provider: 'aws',
      resourceType: 'aws_s3',
      region: 'us-east-1',
      configuration: { estimatedStorageGb: 100 },
    });
    expect(s3Price).not.toBeNull();
    expect(s3Price!.monthlyPrice).toBeGreaterThan(2.0);
    expect(s3Price!.assumptions.length).toBeGreaterThan(0);
  });

  test('Free tier network containers return zero price', async () => {
    const vpcPrice = await provider.getPrice({
      provider: 'aws',
      resourceType: 'aws_vpc',
      region: 'us-east-1',
      configuration: {},
    });
    expect(vpcPrice).not.toBeNull();
    expect(vpcPrice!.monthlyPrice).toBe(0);
  });
});

describe('AzurePricingProvider (Retail Prices Normalization)', () => {
  const provider = new AzurePricingProvider();

  test('Azure VM pricing normalization', async () => {
    const vmPrice = await provider.getPrice({
      provider: 'azure',
      resourceType: 'azure_vm',
      region: 'eastus',
      configuration: { size: 'Standard_B2s', osDiskGb: 128 },
    });
    expect(vmPrice).not.toBeNull();
    expect(vmPrice!.unitPrice).toBeGreaterThan(0);
    expect(vmPrice!.monthlyPrice).toBeGreaterThan(vmPrice!.unitPrice * 700);
    expect(vmPrice!.currency).toBe('USD');
  });

  test('Azure SQL pricing normalization with storage', async () => {
    const sqlPrice = await provider.getPrice({
      provider: 'azure',
      resourceType: 'azure_sql',
      region: 'eastus',
      configuration: { tier: 'S0', maxSizeGb: 250 },
    });
    expect(sqlPrice).not.toBeNull();
    expect(sqlPrice!.monthlyPrice).toBeGreaterThan(0);
    expect(sqlPrice!.assumptions.some((a) => a.includes('storage') || a.includes('price'))).toBe(true);
  });

  test('Azure networking containers return zero price', async () => {
    const vnetPrice = await provider.getPrice({
      provider: 'azure',
      resourceType: 'azure_vnet',
      region: 'eastus',
      configuration: {},
    });
    expect(vnetPrice).not.toBeNull();
    expect(vnetPrice!.monthlyPrice).toBe(0);
  });
});

describe('PricingCache', () => {
  test('Generates deterministic cache keys', () => {
    const cache = new PricingCache();
    const key1 = cache.makeCacheKey({
      provider: 'aws',
      resourceType: 'aws_ec2',
      region: 'us-east-1',
      configuration: { instanceType: 't3.micro' },
    });
    const key2 = cache.makeCacheKey({
      provider: 'aws',
      resourceType: 'aws_ec2',
      region: 'us-east-1',
      configuration: { instanceType: 't3.micro' },
    });
    expect(key1).toBe(key2);
    expect(key1).toContain('aws:aws_ec2:us-east-1:t3.micro');
  });

  test('Caches and retrieves normalized prices', () => {
    const cache = new PricingCache();
    const key = 'test:aws:ec2:t3.micro';
    const mockPrice = {
      provider: 'aws' as const,
      service: 'AmazonEC2',
      resourceType: 'aws_ec2',
      region: 'us-east-1',
      sku: 't3.micro',
      pricingModel: 'on-demand' as const,
      unit: '1 Hour',
      unitPrice: 0.0104,
      monthlyPrice: 7.59,
      currency: 'USD',
      description: 'Test EC2',
      source: 'test-source',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      assumptions: [],
    };

    cache.set(key, mockPrice);
    expect(cache.has(key)).toBe(true);
    const retrieved = cache.get(key);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.unitPrice).toBe(0.0104);
  });

  test('Handles expired items gracefully as stale fallback', () => {
    const cache = new PricingCache();
    const key = 'test:expired:item';
    const expiredPrice = {
      provider: 'aws' as const,
      service: 'AmazonEC2',
      resourceType: 'aws_ec2',
      region: 'us-east-1',
      sku: 't3.micro',
      pricingModel: 'on-demand' as const,
      unit: '1 Hour',
      unitPrice: 0.0104,
      monthlyPrice: 7.59,
      currency: 'USD',
      description: 'Test EC2',
      source: 'test-source',
      retrievedAt: new Date(Date.now() - 100000).toISOString(),
      expiresAt: new Date(Date.now() - 50000).toISOString(),
      assumptions: [],
    };

    cache.set(key, expiredPrice);
    // Disallow stale: returns null
    expect(cache.get(key, false)).toBeNull();
    // Allow stale: returns marked stale item
    const stale = cache.get(key, true);
    expect(stale).not.toBeNull();
    expect(stale!.source).toContain('cached (stale');
  });
});

describe('CloudProviderPricingService & CostEstimator Integration', () => {
  const pricingService = new CloudProviderPricingService();
  const estimator = new CostEstimator();

  test('CloudProviderPricingService resolves real pricing queries', async () => {
    const price = await pricingService.getPrice({
      provider: 'aws',
      resourceType: 'aws_ec2',
      region: 'us-east-1',
      configuration: { instanceType: 't3.medium' },
    });
    expect(price).toBeDefined();
    expect(price.monthlyPrice).toBeGreaterThan(0);
    expect(price.currency).toBe('USD');
  });

  test('CostEstimator.estimateAsync runs with REAL mode', async () => {
    const r1 = makeResource({
      id: 'res-ec2',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'App Server',
      configJson: JSON.stringify({ instanceType: 't3.small' }),
      region: 'us-east-1',
    });
    const r2 = makeResource({
      id: 'res-rds',
      resourceType: 'aws_rds',
      provider: 'aws',
      label: 'App Database',
      configJson: JSON.stringify({ instanceClass: 'db.t3.small', multiAz: false }),
      region: 'us-east-1',
    });

    const result = await estimator.estimateAsync({
      architectureId: 'arch-1',
      projectId: 'proj-1',
      resources: [r1, r2],
      defaultRegion: 'us-east-1',
    }, 'REAL');

    expect(result.items.length).toBe(2);
    expect(result.totalMonthlyUsd).toBeGreaterThan(0);
    expect(result.totalHourlyUsd).toBeGreaterThan(0);
    expect(result.currency).toBe('USD');
    expect(result.pricingSource).toBeTruthy();
  });

  test('CostEstimator.estimate synchronous backward compatibility in TEST mode', () => {
    const r = makeResource({
      resourceType: 'aws_ec2',
      provider: 'aws',
      configJson: JSON.stringify({ instanceType: 't3.micro' }),
    });
    const result = estimator.estimate({
      architectureId: 'arch-1',
      projectId: 'proj-1',
      resources: [r],
    }, 'TEST');

    expect(result.items.length).toBe(1);
    expect(result.items[0].monthlyUsd).toBeGreaterThan(0);
  });

  test('RDS io2 provisioned IOPS costs more than gp3 baseline storage', () => {
    const gp3 = makeResource({
      resourceType: 'aws_rds', provider: 'aws',
      configJson: JSON.stringify({ instanceClass: 'db.t3.small', multiAz: false, allocatedStorage: 100, storageType: 'gp3' }),
    });
    const io2 = makeResource({
      resourceType: 'aws_rds', provider: 'aws',
      configJson: JSON.stringify({ instanceClass: 'db.t3.small', multiAz: false, allocatedStorage: 100, storageType: 'io2', iops: 10000 }),
    });
    const gp3Result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [gp3] }, 'TEST');
    const io2Result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [io2] }, 'TEST');
    expect(io2Result.items[0].monthlyUsd).toBeGreaterThan(gp3Result.items[0].monthlyUsd);
  });

  test('RDS read replicas increase monthly cost proportionally', () => {
    const noReplicas = makeResource({
      resourceType: 'aws_rds', provider: 'aws',
      configJson: JSON.stringify({ instanceClass: 'db.t3.small', multiAz: false, readReplicas: 0 }),
    });
    const twoReplicas = makeResource({
      resourceType: 'aws_rds', provider: 'aws',
      configJson: JSON.stringify({ instanceClass: 'db.t3.small', multiAz: false, readReplicas: 2 }),
    });
    const base = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [noReplicas] }, 'TEST');
    const withReplicas = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [twoReplicas] }, 'TEST');
    expect(withReplicas.items[0].monthlyUsd).toBeGreaterThan(base.items[0].monthlyUsd);
    expect(withReplicas.items[0].breakdown.some((b) => b.label.includes('read replica'))).toBe(true);
  });
});
