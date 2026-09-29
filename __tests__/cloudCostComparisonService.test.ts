/**
 * Tests for lib/engines/comparison/CloudCostComparisonService.ts.
 *
 * These exist specifically to catch the root-cause bug found in this
 * session's audit: AWS<->Azure comparison translated a resource's
 * resourceType/provider without translating its actual configuration, so
 * every translated resource silently collapsed to the SAME hardcoded
 * default (Standard_B2s VM, m5.large EC2, etc.) regardless of what the
 * source resource actually specified. These tests assert the translated
 * config genuinely VARIES with the source config — not that AWS and Azure
 * must always differ in price (they may legitimately be close), but that
 * the translation step itself is config-aware.
 */
import { CloudCostComparisonService } from '@/lib/engines/comparison/CloudCostComparisonService';
import type { CanvasNode } from '@/types';

function makeNode(overrides: Partial<CanvasNode>): CanvasNode {
  return {
    id: 'n1',
    type: 'cloudNode',
    resourceType: 'aws_ec2',
    provider: 'aws',
    label: 'Test',
    position: { x: 0, y: 0 },
    config: {},
    ...overrides,
  } as CanvasNode;
}

describe('CloudCostComparisonService — resourceType translation', () => {
  it('translates aws_alb to azure_app_gateway (the real resource type, not the old azure_app_gw typo)', () => {
    const [translated] = CloudCostComparisonService.translateNodes([makeNode({ resourceType: 'aws_alb' })], 'azure');
    expect(translated.resourceType).toBe('azure_app_gateway');
  });

  it('round-trips azure_app_gateway back to aws_alb', () => {
    const [translated] = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'azure_app_gateway', provider: 'azure' })], 'aws',
    );
    expect(translated.resourceType).toBe('aws_alb');
  });

  it('leaves an unmapped resourceType unchanged rather than inventing a fake equivalent', () => {
    const [translated] = CloudCostComparisonService.translateNodes([makeNode({ resourceType: 'aws_ecs' })], 'azure');
    expect(translated.resourceType).toBe('aws_ecs');
    expect(translated.provider).toBe('azure'); // provider still flips — CostEstimator will correctly report this as unsupported
  });

  it('translates aws_waf to azure_waf (both exist and were previously left unmapped, silently unsupported)', () => {
    const [translated] = CloudCostComparisonService.translateNodes([makeNode({ resourceType: 'aws_waf' })], 'azure');
    expect(translated.resourceType).toBe('azure_waf');
  });

  it('round-trips azure_waf back to aws_waf', () => {
    const [translated] = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'azure_waf', provider: 'azure' })], 'aws',
    );
    expect(translated.resourceType).toBe('aws_waf');
  });

  it('leaves aws_route53 unmapped — Azure has no equivalent DNS zone resource type in this catalog', () => {
    const [translated] = CloudCostComparisonService.translateNodes([makeNode({ resourceType: 'aws_route53' })], 'azure');
    expect(translated.resourceType).toBe('aws_route53');
  });
});

describe('CloudCostComparisonService — EC2 <-> VM config translation', () => {
  it('translates different EC2 instance types to genuinely different Azure VM sizes (not one constant default)', () => {
    const small = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_ec2', config: { instanceType: 't3.micro' } })], 'azure',
    )[0];
    const large = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_ec2', config: { instanceType: 'c6g.4xlarge' } })], 'azure',
    )[0];

    expect(small.config.size).toBeDefined();
    expect(large.config.size).toBeDefined();
    expect(small.config.size).not.toBe(large.config.size);
    // t3.micro (2 vCPU/1GB) should land on a small B/D-series burstable size, not the 16-vCPU tier.
    expect(String(large.config.size)).not.toBe(String(small.config.size));
  });

  it('does not leave AWS-only config keys (instanceType) on the translated Azure node', () => {
    const [translated] = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_ec2', config: { instanceType: 't3.large', storageGb: 100 } })], 'azure',
    );
    expect(translated.config.instanceType).toBeUndefined();
    expect(translated.config.size).toBeDefined();
    expect(translated.config.osDiskSizeGb).toBe(100);
  });

  it('translates Azure VM sizes back to differently-sized EC2 instance types', () => {
    const small = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'azure_vm', provider: 'azure', config: { size: 'Standard_B1s' } })], 'aws',
    )[0];
    const large = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'azure_vm', provider: 'azure', config: { size: 'Standard_D8s_v5' } })], 'aws',
    )[0];

    expect(small.config.instanceType).toBeDefined();
    expect(large.config.instanceType).toBeDefined();
    expect(small.config.instanceType).not.toBe(large.config.instanceType);
    expect(small.config.size).toBeUndefined();
  });
});

describe('CloudCostComparisonService — RDS <-> Azure SQL config translation', () => {
  it('translates a small and a large RDS instance class to different Azure SQL tiers', () => {
    const small = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_rds', config: { instanceClass: 'db.t3.micro', allocatedStorage: 20 } })], 'azure',
    )[0];
    const large = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_rds', config: { instanceClass: 'db.r6g.4xlarge', allocatedStorage: 20 } })], 'azure',
    )[0];

    expect(small.config.tier).toBeDefined();
    expect(large.config.tier).toBeDefined();
    expect(small.config.tier).not.toBe(large.config.tier);
    // The static (fallback) Azure SQL pricing engine only understands S0-S4 DTU tier
    // names (lib/engines/cost/azurePricing.ts _dtuFromTier) — translating to anything
    // else would silently re-introduce the "always collapses to one default" bug.
    expect(['S0', 'S1', 'S2', 'S3', 'S4']).toContain(small.config.tier);
    expect(['S0', 'S1', 'S2', 'S3', 'S4']).toContain(large.config.tier);
  });

  it('carries allocatedStorage through to maxSizeGb', () => {
    const [translated] = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_rds', config: { instanceClass: 'db.t3.medium', allocatedStorage: 500 } })], 'azure',
    );
    expect(translated.config.maxSizeGb).toBe(500);
  });

  it('maps multiAz to zoneRedundant and back', () => {
    const toAzure = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_rds', config: { instanceClass: 'db.t3.medium', multiAz: true } })], 'azure',
    )[0];
    expect(toAzure.config.zoneRedundant).toBe(true);

    const toAws = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'azure_sql', provider: 'azure', config: { tier: 'S2', zoneRedundant: true } })], 'aws',
    )[0];
    expect(toAws.config.multiAz).toBe(true);
  });
});

describe('CloudCostComparisonService — S3 <-> Azure Storage capacity translation', () => {
  it('carries estimatedStorageGb to estimatedCapacityGb and back, preserving the actual value', () => {
    const toAzure = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_s3', config: { estimatedStorageGb: 2500 } })], 'azure',
    )[0];
    expect(toAzure.config.estimatedCapacityGb).toBe(2500);
    expect(toAzure.config.estimatedStorageGb).toBeUndefined();

    const toAws = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'azure_storage', provider: 'azure', config: { estimatedCapacityGb: 777 } })], 'aws',
    )[0];
    expect(toAws.config.estimatedStorageGb).toBe(777);
  });
});

describe('CloudCostComparisonService — Lambda <-> Functions config translation', () => {
  it('translates memorySize <-> memoryMb without losing the value', () => {
    const toAzure = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_lambda', config: { memorySize: 3008, estimatedInvocationsPerMonth: 5_000_000 } })], 'azure',
    )[0];
    expect(toAzure.config.memoryMb).toBe(3008);
    expect(toAzure.config.memorySize).toBeUndefined();
    // Shared field name — carried through untouched.
    expect(toAzure.config.estimatedInvocationsPerMonth).toBe(5_000_000);
  });
});

describe('CloudCostComparisonService — DynamoDB <-> Cosmos DB config translation', () => {
  it('translates different read/write capacity into different Cosmos throughput values', () => {
    const small = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_dynamodb', config: { readCapacity: 5, writeCapacity: 5 } })], 'azure',
    )[0];
    const large = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_dynamodb', config: { readCapacity: 500, writeCapacity: 500 } })], 'azure',
    )[0];
    expect(Number(large.config.maxThroughputRu)).toBeGreaterThan(Number(small.config.maxThroughputRu));
  });
});

describe('CloudCostComparisonService — ElastiCache <-> Azure Redis config translation', () => {
  it('translates a small and large node type to different Azure Redis capacity/family', () => {
    const small = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_elasticache', config: { nodeType: 'cache.t3.micro' } })], 'azure',
    )[0];
    const large = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_elasticache', config: { nodeType: 'cache.r6g.xlarge' } })], 'azure',
    )[0];
    expect(small.config.family).toBe('C');
    expect(large.config.family).toBe('P');
    expect(small.config.capacity).not.toBe(large.config.capacity);
  });
});

describe('CloudCostComparisonService.translateResources (server path)', () => {
  it('translates configJson the same way translateNodes translates config — the server path previously did NOT translate config at all', () => {
    const resources = [{
      id: 'r1',
      resourceType: 'aws_ec2',
      provider: 'aws',
      configJson: JSON.stringify({ instanceType: 'c6g.4xlarge', storageGb: 200 }),
    }];
    const [translated] = CloudCostComparisonService.translateResources(resources, 'azure');
    expect(translated.resourceType).toBe('azure_vm');
    expect(translated.provider).toBe('azure');
    const config = JSON.parse(translated.configJson!) as Record<string, unknown>;
    expect(config.size).toBeDefined();
    expect(config.size).not.toBe('Standard_B2s'); // must not collapse to the old hardcoded default
    expect(config.instanceType).toBeUndefined();
    expect(config.osDiskSizeGb).toBe(200);
  });

  it('leaves configJson untouched (rather than throwing) when it is malformed', () => {
    const resources = [{ id: 'r1', resourceType: 'aws_ec2', provider: 'aws', configJson: '{not valid json' }];
    const [translated] = CloudCostComparisonService.translateResources(resources, 'azure');
    expect(translated.resourceType).toBe('azure_vm');
    expect(translated.configJson).toBe('{not valid json');
  });

  it('translates two differently-sized resources of the same type to two different configs (not the same result for every resource)', () => {
    const resources = [
      { id: 'r1', resourceType: 'aws_ec2', provider: 'aws', configJson: JSON.stringify({ instanceType: 't3.micro' }) },
      { id: 'r2', resourceType: 'aws_ec2', provider: 'aws', configJson: JSON.stringify({ instanceType: 'c6g.4xlarge' }) },
    ];
    const translated = CloudCostComparisonService.translateResources(resources, 'azure');
    const size1 = (JSON.parse(translated[0]!.configJson!) as Record<string, unknown>).size;
    const size2 = (JSON.parse(translated[1]!.configJson!) as Record<string, unknown>).size;
    expect(size1).not.toBe(size2);
  });

  it('translates the region to a real Azure region instead of leaving the AWS region string unchanged', () => {
    const resources = [{ id: 'r1', resourceType: 'aws_ec2', provider: 'aws', region: 'us-east-1', configJson: '{}' }];
    const [translated] = CloudCostComparisonService.translateResources(resources, 'azure');
    expect(translated.region).toBe('eastus');
    expect(translated.region).not.toBe('us-east-1');
  });

  it('translates the region back from Azure to a real AWS region', () => {
    // "North Europe" is Azure's Dublin datacenter — the real-world reverse
    // pairing for AWS eu-west-1 (Ireland).
    const resources = [{ id: 'r1', resourceType: 'azure_vm', provider: 'azure', region: 'northeurope', configJson: '{}' }];
    const [translated] = CloudCostComparisonService.translateResources(resources, 'aws');
    expect(translated.region).toBe('eu-west-1');
  });

  it('falls back to the target provider default region for an unrecognized source region, rather than an invalid string', () => {
    const resources = [{ id: 'r1', resourceType: 'aws_ec2', provider: 'aws', region: 'not-a-real-region', configJson: '{}' }];
    const [translated] = CloudCostComparisonService.translateResources(resources, 'azure');
    expect(translated.region).toBe('eastus');
  });
});

describe('CloudCostComparisonService — label translation (no AWS brand names leaking into Azure-side labels, or vice versa)', () => {
  it('replaces "AWS WAF" with "Azure WAF" in a translated label', () => {
    const [translated] = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_waf', label: 'AWS WAF WebACL' })], 'azure',
    );
    expect(translated.label).not.toContain('AWS WAF');
    expect(translated.label).toBe('Azure WAF');
  });

  it('replaces "RDS" with "Azure SQL" in a translated label', () => {
    const [translated] = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_rds', label: 'RDS PostgreSQL (Multi-AZ)' })], 'azure',
    );
    expect(translated.label).not.toMatch(/\bRDS\b/);
    expect(translated.label).toContain('Azure SQL');
  });

  it('replaces "ElastiCache" with "Azure Redis" in a translated label', () => {
    const [translated] = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_elasticache', label: 'ElastiCache Redis HA' })], 'azure',
    );
    expect(translated.label).not.toContain('ElastiCache');
    expect(translated.label).toContain('Azure Redis');
  });

  it('replaces "CloudFront" with "Front Door" in a translated label', () => {
    const [translated] = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_cloudfront', label: 'CloudFront CDN' })], 'azure',
    );
    expect(translated.label).not.toContain('CloudFront');
    expect(translated.label).toContain('Front Door');
  });

  it('round-trips Azure -> AWS: "Azure SQL" becomes "RDS"', () => {
    const [translated] = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'azure_sql', provider: 'azure', label: 'Azure SQL Primary' })], 'aws',
    );
    expect(translated.label).not.toContain('Azure SQL');
    expect(translated.label).toContain('RDS');
  });

  it('leaves a fully generic label (no brand term) unchanged', () => {
    const [translated] = CloudCostComparisonService.translateNodes(
      [makeNode({ resourceType: 'aws_ec2', label: 'App Server AZ-A' })], 'azure',
    );
    expect(translated.label).toBe('App Server AZ-A');
  });

  it('applies the same label translation on the server (translateResources) path', () => {
    const resources = [{ id: 'r1', resourceType: 'aws_waf', provider: 'aws', label: 'AWS WAF WebACL', configJson: '{}' }];
    const [translated] = CloudCostComparisonService.translateResources(resources, 'azure');
    expect(translated.label).toBe('Azure WAF');
  });
});
