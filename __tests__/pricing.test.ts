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

  test('EC2 io2 provisioned IOPS costs more than gp3 baseline storage', () => {
    const gp3 = makeResource({
      resourceType: 'aws_ec2', provider: 'aws',
      configJson: JSON.stringify({ instanceType: 't3.small', storageGb: 100, storageType: 'gp3' }),
    });
    const io2 = makeResource({
      resourceType: 'aws_ec2', provider: 'aws',
      configJson: JSON.stringify({ instanceType: 't3.small', storageGb: 100, storageType: 'io2', storageIops: 8000 }),
    });
    const gp3Result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [gp3] }, 'TEST');
    const io2Result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [io2] }, 'TEST');
    expect(io2Result.items[0].monthlyUsd).toBeGreaterThan(gp3Result.items[0].monthlyUsd);
  });

  test('EC2 gp3 storage is cheaper per-GB than gp2 (matches AWS list price ordering)', () => {
    const gp2 = makeResource({
      resourceType: 'aws_ec2', provider: 'aws',
      configJson: JSON.stringify({ instanceType: 't3.small', storageGb: 200, storageType: 'gp2' }),
    });
    const gp3 = makeResource({
      resourceType: 'aws_ec2', provider: 'aws',
      configJson: JSON.stringify({ instanceType: 't3.small', storageGb: 200, storageType: 'gp3' }),
    });
    const gp2Result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [gp2] }, 'TEST');
    const gp3Result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [gp3] }, 'TEST');
    expect(gp3Result.items[0].monthlyUsd).toBeLessThan(gp2Result.items[0].monthlyUsd);
  });

  test('Lambda cost scales with invocations and memory (previously a flat $3.50 regardless of config)', () => {
    const light = makeResource({
      resourceType: 'aws_lambda', provider: 'aws',
      configJson: JSON.stringify({ memorySize: 128, estimatedInvocationsPerMonth: 1_000_000, estimatedAvgDurationMs: 50 }),
    });
    const heavy = makeResource({
      resourceType: 'aws_lambda', provider: 'aws',
      configJson: JSON.stringify({ memorySize: 3008, estimatedInvocationsPerMonth: 50_000_000, estimatedAvgDurationMs: 800 }),
    });
    const lightResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [light] }, 'TEST');
    const heavyResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [heavy] }, 'TEST');
    expect(heavyResult.items[0].monthlyUsd).toBeGreaterThan(lightResult.items[0].monthlyUsd);
  });

  test('Lambda usage within the free tier costs $0', () => {
    const freeTier = makeResource({
      resourceType: 'aws_lambda', provider: 'aws',
      configJson: JSON.stringify({ memorySize: 128, estimatedInvocationsPerMonth: 500_000, estimatedAvgDurationMs: 100 }),
    });
    const result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [freeTier] }, 'TEST');
    expect(result.items[0].monthlyUsd).toBeCloseTo(0, 5);
  });

  test('Lambda provisioned concurrency adds its own always-on cost', () => {
    const noProvisioned = makeResource({ resourceType: 'aws_lambda', provider: 'aws', configJson: JSON.stringify({ memorySize: 512, provisionedConcurrency: 0 }) });
    const withProvisioned = makeResource({ resourceType: 'aws_lambda', provider: 'aws', configJson: JSON.stringify({ memorySize: 512, provisionedConcurrency: 10 }) });
    const base = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [noProvisioned] }, 'TEST');
    const withPc = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [withProvisioned] }, 'TEST');
    expect(withPc.items[0].monthlyUsd).toBeGreaterThan(base.items[0].monthlyUsd);
    expect(withPc.items[0].breakdown.some((b) => b.label.includes('Provisioned concurrency'))).toBe(true);
  });

  test('DynamoDB cost scales with configured capacity/usage (previously a flat $5 regardless of config)', () => {
    const light = makeResource({ resourceType: 'aws_dynamodb', provider: 'aws', configJson: JSON.stringify({ billingMode: 'PAY_PER_REQUEST', estimatedReadRequestUnitsPerMonth: 100_000, estimatedWriteRequestUnitsPerMonth: 50_000, estimatedStorageGb: 1 }) });
    const heavy = makeResource({ resourceType: 'aws_dynamodb', provider: 'aws', configJson: JSON.stringify({ billingMode: 'PAY_PER_REQUEST', estimatedReadRequestUnitsPerMonth: 100_000_000, estimatedWriteRequestUnitsPerMonth: 50_000_000, estimatedStorageGb: 500 }) });
    const lightResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [light] }, 'TEST');
    const heavyResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [heavy] }, 'TEST');
    expect(heavyResult.items[0].monthlyUsd).toBeGreaterThan(lightResult.items[0].monthlyUsd);
  });

  test('DynamoDB PROVISIONED mode prices off read/write capacity units', () => {
    const small = makeResource({ resourceType: 'aws_dynamodb', provider: 'aws', configJson: JSON.stringify({ billingMode: 'PROVISIONED', readCapacity: 5, writeCapacity: 5 }) });
    const large = makeResource({ resourceType: 'aws_dynamodb', provider: 'aws', configJson: JSON.stringify({ billingMode: 'PROVISIONED', readCapacity: 500, writeCapacity: 500 }) });
    const smallResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [small] }, 'TEST');
    const largeResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [large] }, 'TEST');
    expect(largeResult.items[0].monthlyUsd).toBeGreaterThan(smallResult.items[0].monthlyUsd);
  });

  test('ElastiCache cost scales with node type and count', () => {
    const small = makeResource({ resourceType: 'aws_elasticache', provider: 'aws', configJson: JSON.stringify({ nodeType: 'cache.t3.micro', numNodes: 1 }) });
    const large = makeResource({ resourceType: 'aws_elasticache', provider: 'aws', configJson: JSON.stringify({ nodeType: 'cache.r6g.xlarge', numNodes: 3 }) });
    const smallResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [small] }, 'TEST');
    const largeResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [large] }, 'TEST');
    expect(largeResult.items[0].monthlyUsd).toBeGreaterThan(smallResult.items[0].monthlyUsd);
  });

  test('SQS usage within the free tier costs $0; usage above it does not', () => {
    const freeTier = makeResource({ resourceType: 'aws_sqs', provider: 'aws', configJson: JSON.stringify({ estimatedRequestsPerMonth: 500_000 }) });
    const heavy = makeResource({ resourceType: 'aws_sqs', provider: 'aws', configJson: JSON.stringify({ estimatedRequestsPerMonth: 100_000_000 }) });
    const freeResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [freeTier] }, 'TEST');
    const heavyResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [heavy] }, 'TEST');
    expect(freeResult.items[0].monthlyUsd).toBeCloseTo(0, 5);
    expect(heavyResult.items[0].monthlyUsd).toBeGreaterThan(0);
  });

  test('ECS Fargate cost scales with task CPU/memory and desired count', () => {
    const small = makeResource({ resourceType: 'aws_ecs', provider: 'aws', configJson: JSON.stringify({ launchType: 'FARGATE', cpu: 256, memory: 512, desiredCount: 1 }) });
    const large = makeResource({ resourceType: 'aws_ecs', provider: 'aws', configJson: JSON.stringify({ launchType: 'FARGATE', cpu: 2048, memory: 4096, desiredCount: 5 }) });
    const smallResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [small] }, 'TEST');
    const largeResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [large] }, 'TEST');
    expect(largeResult.items[0].monthlyUsd).toBeGreaterThan(smallResult.items[0].monthlyUsd);
  });

  test('ECS EC2 launch type has no separate charge (billed via the underlying instances)', () => {
    const ec2Launch = makeResource({ resourceType: 'aws_ecs', provider: 'aws', configJson: JSON.stringify({ launchType: 'EC2', cpu: 1024, memory: 2048, desiredCount: 3 }) });
    const result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [ec2Launch] }, 'TEST');
    expect(result.items[0].monthlyUsd).toBe(0);
  });

  test('Azure Functions Premium/Dedicated plans price as a fixed hourly SKU regardless of executions', () => {
    const light = makeResource({ resourceType: 'azure_functions', provider: 'azure', configJson: JSON.stringify({ planType: 'B1', estimatedInvocationsPerMonth: 1 }) });
    const heavy = makeResource({ resourceType: 'azure_functions', provider: 'azure', configJson: JSON.stringify({ planType: 'B1', estimatedInvocationsPerMonth: 999_999_999 }) });
    const lightResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [light] }, 'TEST');
    const heavyResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [heavy] }, 'TEST');
    expect(lightResult.items[0].monthlyUsd).toBeCloseTo(heavyResult.items[0].monthlyUsd, 5);
    expect(lightResult.items[0].monthlyUsd).toBeGreaterThan(0);
  });

  test('Azure Functions Consumption plan scales with invocations (previously a flat $5 regardless of config)', () => {
    const light = makeResource({ resourceType: 'azure_functions', provider: 'azure', configJson: JSON.stringify({ planType: 'Y1', memoryMb: 128, estimatedInvocationsPerMonth: 1_000_000, estimatedAvgDurationMs: 50 }) });
    const heavy = makeResource({ resourceType: 'azure_functions', provider: 'azure', configJson: JSON.stringify({ planType: 'Y1', memoryMb: 1536, estimatedInvocationsPerMonth: 50_000_000, estimatedAvgDurationMs: 800 }) });
    const lightResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [light] }, 'TEST');
    const heavyResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [heavy] }, 'TEST');
    expect(heavyResult.items[0].monthlyUsd).toBeGreaterThan(lightResult.items[0].monthlyUsd);
  });

  test('EKS cost includes worker node compute, not just the control plane (previously a flat $0.10/hr ignoring node config)', () => {
    const small = makeResource({ resourceType: 'aws_eks', provider: 'aws', configJson: JSON.stringify({ nodeInstanceType: 't3.medium', nodeCount: 1 }) });
    const large = makeResource({ resourceType: 'aws_eks', provider: 'aws', configJson: JSON.stringify({ nodeInstanceType: 'm5.xlarge', nodeCount: 10 }) });
    const smallResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [small] }, 'TEST');
    const largeResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [large] }, 'TEST');
    expect(largeResult.items[0].monthlyUsd).toBeGreaterThan(smallResult.items[0].monthlyUsd);
  });

  test('EKS Spot capacity type costs less than On-Demand for the same nodes', () => {
    const onDemand = makeResource({ resourceType: 'aws_eks', provider: 'aws', configJson: JSON.stringify({ capacityType: 'ON_DEMAND', nodeCount: 3 }) });
    const spot = makeResource({ resourceType: 'aws_eks', provider: 'aws', configJson: JSON.stringify({ capacityType: 'SPOT', nodeCount: 3 }) });
    const onDemandResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [onDemand] }, 'TEST');
    const spotResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [spot] }, 'TEST');
    expect(spotResult.items[0].monthlyUsd).toBeLessThan(onDemandResult.items[0].monthlyUsd);
  });

  test('AKS Free tier has no control plane charge; Standard tier does (previously always charged $0.10/hr)', () => {
    const free = makeResource({ resourceType: 'azure_aks', provider: 'azure', configJson: JSON.stringify({ skuTier: 'Free', nodeCount: 1 }) });
    const standard = makeResource({ resourceType: 'azure_aks', provider: 'azure', configJson: JSON.stringify({ skuTier: 'Standard', nodeCount: 1 }) });
    const freeResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [free] }, 'TEST');
    const standardResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [standard] }, 'TEST');
    expect(standardResult.items[0].monthlyUsd).toBeGreaterThan(freeResult.items[0].monthlyUsd);
  });

  test('AKS cost scales with node VM size and count', () => {
    const small = makeResource({ resourceType: 'azure_aks', provider: 'azure', configJson: JSON.stringify({ nodeVmSize: 'Standard_B2s', nodeCount: 1 }) });
    const large = makeResource({ resourceType: 'azure_aks', provider: 'azure', configJson: JSON.stringify({ nodeVmSize: 'Standard_D4s_v3', nodeCount: 10 }) });
    const smallResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [small] }, 'TEST');
    const largeResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [large] }, 'TEST');
    expect(largeResult.items[0].monthlyUsd).toBeGreaterThan(smallResult.items[0].monthlyUsd);
  });

  test('App Service Free (F1) tier costs $0; paid tiers scale with SKU', () => {
    const free = makeResource({ resourceType: 'azure_app_service', provider: 'azure', configJson: JSON.stringify({ skuName: 'F1' }) });
    const basic = makeResource({ resourceType: 'azure_app_service', provider: 'azure', configJson: JSON.stringify({ skuName: 'B1' }) });
    const premium = makeResource({ resourceType: 'azure_app_service', provider: 'azure', configJson: JSON.stringify({ skuName: 'P2v3' }) });
    const freeResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [free] }, 'TEST');
    const basicResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [basic] }, 'TEST');
    const premiumResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [premium] }, 'TEST');
    expect(freeResult.items[0].monthlyUsd).toBe(0);
    expect(basicResult.items[0].monthlyUsd).toBeGreaterThan(0);
    expect(premiumResult.items[0].monthlyUsd).toBeGreaterThan(basicResult.items[0].monthlyUsd);
  });

  test('Route 53 private hosted zones cost more than public (previously entirely unsupported)', () => {
    const publicZone = makeResource({ resourceType: 'aws_route53', provider: 'aws', configJson: JSON.stringify({ hostedZoneType: 'Public' }) });
    const privateZone = makeResource({ resourceType: 'aws_route53', provider: 'aws', configJson: JSON.stringify({ hostedZoneType: 'Private' }) });
    const publicResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [publicZone] }, 'TEST');
    const privateResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [privateZone] }, 'TEST');
    expect(privateResult.items[0].monthlyUsd).toBeGreaterThan(publicResult.items[0].monthlyUsd);
  });

  test('WAF cost scales with rule count (previously entirely unsupported)', () => {
    const minimal = makeResource({ resourceType: 'aws_waf', provider: 'aws', configJson: JSON.stringify({ managedRuleGroups: [] }) });
    const loaded = makeResource({ resourceType: 'aws_waf', provider: 'aws', configJson: JSON.stringify({ managedRuleGroups: ['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesSQLiRuleSet', 'AWSManagedRulesLinuxRuleSet'], rateLimitEnabled: true }) });
    const minimalResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [minimal] }, 'TEST');
    const loadedResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [loaded] }, 'TEST');
    expect(loadedResult.items[0].monthlyUsd).toBeGreaterThan(minimalResult.items[0].monthlyUsd);
  });

  test('KMS keys cost real money (previously marked as having no direct charges)', () => {
    const key = makeResource({ resourceType: 'aws_kms', provider: 'aws', configJson: '{}' });
    const result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [key] }, 'TEST');
    expect(result.items[0].monthlyUsd).toBeGreaterThan(0);
  });

  test('CloudWatch alarms cost real money (previously marked as having no direct charges)', () => {
    const alarm = makeResource({ resourceType: 'aws_cloudwatch', provider: 'aws', configJson: '{}' });
    const result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [alarm] }, 'TEST');
    expect(result.items[0].monthlyUsd).toBeGreaterThan(0);
  });

  test('Network ACLs and Auto Scaling groups have no direct charge (correctly $0, not "unsupported")', () => {
    const nacl = makeResource({ resourceType: 'aws_nacl', provider: 'aws', configJson: '{}' });
    const asg = makeResource({ resourceType: 'aws_auto_scaling', provider: 'aws', configJson: '{}' });
    const result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [nacl, asg] }, 'TEST');
    expect(result.items.length).toBe(0); // both resolve to null (no direct charge), not a line item
  });

  test('EBS io2 volumes cost more than gp3 for the same size (previously always priced as gp3)', () => {
    const gp3 = makeResource({ resourceType: 'aws_ebs', provider: 'aws', configJson: JSON.stringify({ sizeGb: 200, volumeType: 'gp3' }) });
    const io2 = makeResource({ resourceType: 'aws_ebs', provider: 'aws', configJson: JSON.stringify({ sizeGb: 200, volumeType: 'io2', iops: 10000 }) });
    const gp3Result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [gp3] }, 'TEST');
    const io2Result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [io2] }, 'TEST');
    expect(io2Result.items[0].monthlyUsd).toBeGreaterThan(gp3Result.items[0].monthlyUsd);
  });

  test('Azure Standard Public IPs cost real money (previously marked as having no direct charges)', () => {
    const standard = makeResource({ resourceType: 'azure_public_ip', provider: 'azure', configJson: JSON.stringify({ sku: 'Standard' }) });
    const result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [standard] }, 'TEST');
    expect(result.items[0].monthlyUsd).toBeGreaterThan(0);
  });

  test('Azure Route Tables and NICs correctly have no direct charge', () => {
    const rt = makeResource({ resourceType: 'azure_route_table', provider: 'azure', configJson: '{}' });
    const nic = makeResource({ resourceType: 'azure_nic', provider: 'azure', configJson: '{}' });
    const result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [rt, nic] }, 'TEST');
    expect(result.items.length).toBe(0);
  });

  test('Azure Redis cost scales with SKU and capacity (previously entirely unsupported)', () => {
    const small = makeResource({ resourceType: 'azure_redis', provider: 'azure', configJson: JSON.stringify({ sku: 'Basic', capacity: 0 }) });
    const large = makeResource({ resourceType: 'azure_redis', provider: 'azure', configJson: JSON.stringify({ sku: 'Premium', capacity: 3 }) });
    const smallResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [small] }, 'TEST');
    const largeResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [large] }, 'TEST');
    expect(largeResult.items[0].monthlyUsd).toBeGreaterThan(smallResult.items[0].monthlyUsd);
  });

  test('Azure Bastion Standard costs more than Basic and scales with scale units (previously entirely unsupported)', () => {
    const basic = makeResource({ resourceType: 'azure_bastion', provider: 'azure', configJson: JSON.stringify({ sku: 'Basic' }) });
    const standard = makeResource({ resourceType: 'azure_bastion', provider: 'azure', configJson: JSON.stringify({ sku: 'Standard', scaleUnits: 8 }) });
    const basicResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [basic] }, 'TEST');
    const standardResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [standard] }, 'TEST');
    expect(standardResult.items[0].monthlyUsd).toBeGreaterThan(basicResult.items[0].monthlyUsd);
  });

  test('Front Door Premium costs more than Standard (previously entirely unsupported)', () => {
    const standard = makeResource({ resourceType: 'azure_front_door', provider: 'azure', configJson: JSON.stringify({ sku: 'Standard_AzureFrontDoor' }) });
    const premium = makeResource({ resourceType: 'azure_front_door', provider: 'azure', configJson: JSON.stringify({ sku: 'Premium_AzureFrontDoor' }) });
    const standardResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [standard] }, 'TEST');
    const premiumResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [premium] }, 'TEST');
    expect(premiumResult.items[0].monthlyUsd).toBeGreaterThan(standardResult.items[0].monthlyUsd);
  });

  test('Azure WAF policy has a real cost (previously entirely unsupported)', () => {
    const waf = makeResource({ resourceType: 'azure_waf', provider: 'azure', configJson: '{}' });
    const result = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [waf] }, 'TEST');
    expect(result.items[0].monthlyUsd).toBeGreaterThan(0);
  });

  test('VMSS cost scales with SKU and instance count (previously entirely unsupported)', () => {
    const small = makeResource({ resourceType: 'azure_vmss', provider: 'azure', configJson: JSON.stringify({ sku: 'Standard_B2s', capacity: 1 }) });
    const large = makeResource({ resourceType: 'azure_vmss', provider: 'azure', configJson: JSON.stringify({ sku: 'Standard_D8s_v5', capacity: 10 }) });
    const smallResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [small] }, 'TEST');
    const largeResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [large] }, 'TEST');
    expect(largeResult.items[0].monthlyUsd).toBeGreaterThan(smallResult.items[0].monthlyUsd);
  });

  test('Cosmos DB Provisioned throughput scales with max RU/s; both modes have real cost (previously entirely unsupported)', () => {
    const serverless = makeResource({ resourceType: 'azure_cosmos_db', provider: 'azure', configJson: JSON.stringify({ throughputMode: 'Serverless' }) });
    const provisionedLow = makeResource({ resourceType: 'azure_cosmos_db', provider: 'azure', configJson: JSON.stringify({ throughputMode: 'Provisioned', maxThroughputRu: 1000 }) });
    const provisionedHigh = makeResource({ resourceType: 'azure_cosmos_db', provider: 'azure', configJson: JSON.stringify({ throughputMode: 'Provisioned', maxThroughputRu: 100000 }) });
    const serverlessResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [serverless] }, 'TEST');
    const lowResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [provisionedLow] }, 'TEST');
    const highResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [provisionedHigh] }, 'TEST');
    expect(serverlessResult.items[0].monthlyUsd).toBeGreaterThan(0);
    expect(highResult.items[0].monthlyUsd).toBeGreaterThan(lowResult.items[0].monthlyUsd);
  });

  test('App Gateway cost scales with capacity units (previously ignored config entirely)', () => {
    const small = makeResource({ resourceType: 'azure_app_gateway', provider: 'azure', configJson: JSON.stringify({ autoscaleEnabled: false, capacity: 1 }) });
    const large = makeResource({ resourceType: 'azure_app_gateway', provider: 'azure', configJson: JSON.stringify({ autoscaleEnabled: false, capacity: 20 }) });
    const smallResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [small] }, 'TEST');
    const largeResult = estimator.estimate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [large] }, 'TEST');
    expect(largeResult.items[0].monthlyUsd).toBeGreaterThan(smallResult.items[0].monthlyUsd);
  });
});
