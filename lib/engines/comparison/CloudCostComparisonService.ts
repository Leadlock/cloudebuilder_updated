import { CanvasNode } from '@/types';
import { translateRegion } from '@/lib/cloud/regions/regionEquivalence';

type Provider = 'aws' | 'azure';

/**
 * AWS resourceType -> Azure resourceType. The reverse map is derived from
 * this one (Object.fromEntries + swap) rather than hand-duplicated, so the
 * two directions can never drift out of sync the way they previously did
 * (the old azureToAws map had 'azure_app_gw' where every other resource
 * definition, Terraform generator, and pricing provider uses the real type
 * 'azure_app_gateway' — every ALB<->AppGateway comparison silently priced
 * as "unsupported" as a result).
 *
 * Only pairs with a real capacity/config translation below are included.
 * An untranslated resourceType is intentionally left AS-IS with its
 * provider swapped — CostEstimator will then find no matching case for
 * e.g. an 'aws_ecs' resource tagged provider:'azure' and correctly report
 * it unsupported/unpriced, rather than this service silently inventing an
 * Azure equivalent it has no real mapping for.
 */
const AWS_TO_AZURE_TYPE: Record<string, string> = {
  aws_ec2: 'azure_vm',
  aws_auto_scaling: 'azure_vmss',
  aws_vpc: 'azure_vnet',
  aws_subnet: 'azure_subnet',
  aws_rds: 'azure_sql',
  aws_s3: 'azure_storage',
  aws_alb: 'azure_app_gateway',
  aws_nat: 'azure_nat',
  aws_igw: 'azure_public_ip',
  aws_lambda: 'azure_functions',
  aws_dynamodb: 'azure_cosmos_db',
  aws_elasticache: 'azure_redis',
  aws_cloudfront: 'azure_front_door',
  aws_cloud_boundary: 'azure_cloud_boundary',
  aws_waf: 'azure_waf',
  aws_route53: 'azure_dns',
  aws_cloudwatch: 'azure_monitor',
  aws_sqs: 'azure_service_bus',
};
const AZURE_TO_AWS_TYPE: Record<string, string> = {
  ...Object.fromEntries(Object.entries(AWS_TO_AZURE_TYPE).map(([aws, azure]) => [azure, aws])),
  // Both flexible servers are RDS (the engine setting says which).
  azure_postgres: 'aws_rds',
  azure_mysql: 'aws_rds',
};

/** An RDS instance is the Azure engine of the same name; only other engines (SQL Server, Oracle…) become Azure SQL. */
const azureRelationalFor = (config: Record<string, unknown>): 'azure_postgres' | 'azure_mysql' | 'azure_sql' => {
  const engine = String(config['engine'] ?? '').toLowerCase();
  return engine.includes('postgres') ? 'azure_postgres' : /mysql|maria/.test(engine) ? 'azure_mysql' : 'azure_sql';
};

/** The type a resource becomes on the other provider. Chosen from the source configuration, so it must be read before the configuration is translated. */
function targetTypeFor(sourceType: string, config: Record<string, unknown>, target: Provider): string {
  if (target === 'azure' && sourceType === 'aws_rds') return azureRelationalFor(config);
  return (target === 'azure' ? AWS_TO_AZURE_TYPE : AZURE_TO_AWS_TYPE)[sourceType] || sourceType;
}

// ─── Compute capacity tables (vCPU / RAM GB) ──────────────────────────────────
// Sourced from the actual <select> option labels in lib/resources/aws.ts
// ('instanceType'/'instanceClass') and lib/resources/azure.ts ('size') —
// i.e. these are exactly the values a user could have picked, not invented
// hardware specs. Translation picks the nearest match by vCPU, then RAM.

interface ComputeSpec { key: string; vcpu: number; ramGb: number; }

const AWS_EC2_SPECS: ComputeSpec[] = [
  { key: 't3.micro', vcpu: 2, ramGb: 1 },
  { key: 't3.small', vcpu: 2, ramGb: 2 },
  { key: 't3.medium', vcpu: 2, ramGb: 4 },
  { key: 't3.large', vcpu: 2, ramGb: 8 },
  { key: 't4g.small', vcpu: 2, ramGb: 2 },
  { key: 't4g.medium', vcpu: 2, ramGb: 4 },
  { key: 'm5.large', vcpu: 2, ramGb: 8 },
  { key: 'c5.large', vcpu: 2, ramGb: 4 },
  { key: 'r5.large', vcpu: 2, ramGb: 16 },
  { key: 'c6g.xlarge', vcpu: 4, ramGb: 8 },
  { key: 'c6g.2xlarge', vcpu: 8, ramGb: 16 },
  { key: 'c6g.4xlarge', vcpu: 16, ramGb: 32 },
];

const AZURE_VM_SPECS: ComputeSpec[] = [
  { key: 'Standard_B1s', vcpu: 1, ramGb: 1 },
  { key: 'Standard_B2s', vcpu: 2, ramGb: 4 },
  { key: 'Standard_B4ms', vcpu: 4, ramGb: 16 },
  { key: 'Standard_D2s_v3', vcpu: 2, ramGb: 8 },
  { key: 'Standard_D4s_v3', vcpu: 4, ramGb: 16 },
  { key: 'Standard_E2s_v3', vcpu: 2, ramGb: 16 },
  { key: 'Standard_D4s_v5', vcpu: 4, ramGb: 16 },
  { key: 'Standard_D8s_v5', vcpu: 8, ramGb: 32 },
  { key: 'Standard_E8s_v5', vcpu: 8, ramGb: 64 },
];

const AWS_RDS_SPECS: ComputeSpec[] = [
  { key: 'db.t3.micro', vcpu: 1, ramGb: 1 },
  { key: 'db.t3.small', vcpu: 2, ramGb: 2 },
  { key: 'db.t3.medium', vcpu: 2, ramGb: 4 },
  { key: 'db.m5.large', vcpu: 2, ramGb: 8 },
  { key: 'db.r5.large', vcpu: 2, ramGb: 16 },
  { key: 'db.t4g.micro', vcpu: 2, ramGb: 1 },
  { key: 'db.t4g.medium', vcpu: 2, ramGb: 4 },
  { key: 'db.r6g.xlarge', vcpu: 4, ramGb: 32 },
  { key: 'db.r6g.2xlarge', vcpu: 8, ramGb: 64 },
  { key: 'db.r6g.4xlarge', vcpu: 16, ramGb: 128 },
];

/**
 * Azure SQL tier -> approximate vCPU equivalent, used only to pick the nearest tier for an RDS instance class.
 *
 * From 2 vCPU up the vCore model (GP_Gen5_N, General Purpose) is used, because a vCore is the same kind of unit as an RDS vCPU. A DTU tier is a blend
 * of CPU, memory and I/O, not a size, so a DTU tier next to an RDS instance is not a like-for-like comparison. The earlier mapping put a 2-vCPU
 * instance at the S4 DTU tier ($294/mo), which the cost screen then had to flag as not the same size. Below 2 vCPU only the small DTU tiers
 * exist, so those remain; they are an approximation. vCore tiers are priced live per vCore by lib/cloud/pricing/AzurePricingProvider.ts.
 */
/** The flexible-server sizes the catalog offers, by vCPU and memory (the same values as the "Compute Size" choices). */
const FLEX_SPECS: Record<'azure_postgres' | 'azure_mysql', ComputeSpec[]> = {
  azure_postgres: [
    { key: 'B_Standard_B1ms', vcpu: 1, ramGb: 2 }, { key: 'B_Standard_B2s', vcpu: 2, ramGb: 4 }, { key: 'GP_Standard_D2ds_v5', vcpu: 2, ramGb: 8 },
    { key: 'GP_Standard_D4ds_v5', vcpu: 4, ramGb: 16 }, { key: 'MO_Standard_E2ds_v5', vcpu: 2, ramGb: 16 }, { key: 'MO_Standard_E4ds_v5', vcpu: 4, ramGb: 32 },
  ],
  azure_mysql: [
    { key: 'B_Standard_B1ms', vcpu: 1, ramGb: 2 }, { key: 'B_Standard_B2s', vcpu: 2, ramGb: 4 }, { key: 'GP_Standard_D2ds_v4', vcpu: 2, ramGb: 8 },
    { key: 'GP_Standard_D4ds_v4', vcpu: 4, ramGb: 16 }, { key: 'MO_Standard_E2ds_v4', vcpu: 2, ramGb: 16 },
  ],
};

const AZURE_SQL_TIERS: Array<{ key: string; vcpuEquivalent: number }> = [
  { key: 'S0', vcpuEquivalent: 0.1 },
  { key: 'S1', vcpuEquivalent: 0.2 },
  { key: 'S2', vcpuEquivalent: 0.5 },
  { key: 'S3', vcpuEquivalent: 1 },
  { key: 'GP_Gen5_2', vcpuEquivalent: 2 },
  { key: 'GP_Gen5_4', vcpuEquivalent: 4 },
  { key: 'GP_Gen5_8', vcpuEquivalent: 8 },
  { key: 'GP_Gen5_16', vcpuEquivalent: 16 },
];

const AWS_CACHE_SPECS: ComputeSpec[] = [
  { key: 'cache.t3.micro', vcpu: 2, ramGb: 0.5 },
  { key: 'cache.t3.small', vcpu: 2, ramGb: 1.4 },
  { key: 'cache.t3.medium', vcpu: 2, ramGb: 3.1 },
  { key: 'cache.r6g.large', vcpu: 2, ramGb: 13 },
  { key: 'cache.r6g.xlarge', vcpu: 4, ramGb: 26 },
];

/** Azure Cache for Redis capacity tiers -> approximate RAM GB, per family. */
const AZURE_REDIS_CAPACITY_RAM_GB: Record<'C' | 'P', number[]> = {
  C: [0.25, 1, 2.5, 6, 13, 26, 53], // capacity 0-6
  P: [6, 13, 26, 53, 120],          // capacity 1-5 (index 0 unused)
};

function nearestByRam(specs: ComputeSpec[], ramGb: number): ComputeSpec {
  return specs.reduce((best, s) => (Math.abs(s.ramGb - ramGb) < Math.abs(best.ramGb - ramGb) ? s : best));
}

function nearestCompute(specs: ComputeSpec[], vcpu: number, ramGb: number): ComputeSpec {
  const byVcpu = specs.filter((s) => s.vcpu === vcpu);
  const pool = byVcpu.length > 0 ? byVcpu : specs;
  return pool.reduce((best, s) => (Math.abs(s.ramGb - ramGb) < Math.abs(best.ramGb - ramGb) ? s : best));
}

function specOf(specs: ComputeSpec[], key: string): ComputeSpec {
  return specs.find((s) => s.key === key) ?? specs[0]!;
}

// ─── Per-resource-type config translation ─────────────────────────────────────

type ConfigTranslator = (config: Record<string, unknown>, targetProvider: Provider) => Record<string, unknown>;

const translateEc2Vm: ConfigTranslator = (config, target) => {
  const next = { ...config };
  if (target === 'azure') {
    const src = specOf(AWS_EC2_SPECS, String(config['instanceType'] ?? 't3.medium'));
    delete next['instanceType'];
    next['size'] = nearestCompute(AZURE_VM_SPECS, src.vcpu, src.ramGb).key;
    if (typeof config['storageGb'] === 'number') next['osDiskSizeGb'] = config['storageGb'];
    next['osType'] = String(config['os'] ?? '').toLowerCase().includes('windows') ? 'Windows' : 'Linux';
  } else {
    const src = specOf(AZURE_VM_SPECS, String(config['size'] ?? 'Standard_B2s'));
    delete next['size'];
    next['instanceType'] = nearestCompute(AWS_EC2_SPECS, src.vcpu, src.ramGb).key;
    if (typeof config['osDiskSizeGb'] === 'number' && config['osDiskSizeGb'] > 0) next['storageGb'] = config['osDiskSizeGb'];
    next['os'] = String(config['osType'] ?? '') === 'Windows' ? 'Windows Server 2022' : 'Ubuntu 24.04 LTS';
  }
  return next;
};

/**
 * An Auto Scaling group and a VM scale set are the same thing in each cloud: a pool of identical VMs. The size is translated like a single
 * VM (nearest vCPU, then RAM) and the capacity carries over. With no mapping the scale set came from the AI matcher with default settings
 * (a 2-instance Standard_B2s group), so a group of 2 x t3.large was compared against a smaller, cheaper Azure pool.
 */
const translateAsgVmss: ConfigTranslator = (config, target) => {
  const next = { ...config };
  if (target === 'azure') {
    const src = specOf(AWS_EC2_SPECS, String(config['instanceType'] ?? 't3.medium'));
    delete next['instanceType'];
    next['sku'] = nearestCompute(AZURE_VM_SPECS, src.vcpu, src.ramGb).key;
    const capacity = [config['desiredCapacity'], config['minSize']].map(Number).find((n) => Number.isFinite(n) && n >= 0);
    next['capacity'] = capacity ?? 2;
    next['osType'] = 'Linux';
  } else {
    const src = specOf(AZURE_VM_SPECS, String(config['sku'] ?? 'Standard_B2s'));
    delete next['sku'];
    next['instanceType'] = nearestCompute(AWS_EC2_SPECS, src.vcpu, src.ramGb).key;
    const capacity = Number(config['capacity']);
    if (Number.isFinite(capacity) && capacity >= 0) next['desiredCapacity'] = capacity;
    delete next['capacity'];
  }
  return next;
};

const translateRdsSql: ConfigTranslator = (config, target) => {
  const next = { ...config };
  const multiAz = config['multiAz'] === true || config['zoneRedundant'] === true;
  if (target === 'azure') {
    const src = specOf(AWS_RDS_SPECS, String(config['instanceClass'] ?? 'db.t3.medium'));
    const kind = azureRelationalFor(config);
    if (kind !== 'azure_sql') {
      // PostgreSQL / MySQL keep their engine: a flexible server of the nearest size, zone-redundant where the source was Multi-AZ.
      const sku = nearestCompute(FLEX_SPECS[kind], src.vcpu, src.ramGb);
      for (const k of ['instanceClass', 'engine', 'multiAz', 'allocatedStorage', 'engineVersion', 'storageEncrypted', 'publiclyAccessible']) delete next[k];
      next['skuName'] = sku.key;
      if (typeof config['allocatedStorage'] === 'number') next['storageGb'] = Math.max(kind === 'azure_postgres' ? 32 : 20, config['allocatedStorage']);
      // Burstable sizes do not offer zone-redundant HA, so a Multi-AZ source gets a General Purpose size.
      if (multiAz && sku.key.startsWith('B_')) next['skuName'] = FLEX_SPECS[kind].find((x) => x.key.startsWith('GP_'))!.key;
      next['highAvailability'] = multiAz ? 'ZoneRedundant' : 'Disabled';
      return next;
    }
    delete next['instanceClass'];
    delete next['engine'];
    delete next['multiAz'];
    next['tier'] = AZURE_SQL_TIERS.reduce((best, t) =>
      Math.abs(t.vcpuEquivalent - src.vcpu) < Math.abs(best.vcpuEquivalent - src.vcpu) ? t : best).key;
    if (typeof config['allocatedStorage'] === 'number') next['maxSizeGb'] = config['allocatedStorage'];
    next['zoneRedundant'] = multiAz;
  } else {
    const tierKey = String(config['tier'] ?? 'S0');
    const tier = AZURE_SQL_TIERS.find((t) => t.key === tierKey) ?? AZURE_SQL_TIERS[0]!;
    delete next['tier'];
    delete next['zoneRedundant'];
    next['instanceClass'] = nearestCompute(AWS_RDS_SPECS, tier.vcpuEquivalent, tier.vcpuEquivalent * 4).key;
    next['engine'] = 'postgres';
    if (typeof config['maxSizeGb'] === 'number') next['allocatedStorage'] = config['maxSizeGb'];
    next['multiAz'] = multiAz;
  }
  return next;
};

/** A PostgreSQL / MySQL flexible server as an RDS instance of the same engine. */
const translateFlexibleToRds = (kind: 'azure_postgres' | 'azure_mysql'): ConfigTranslator => (config, target) => {
  const next = { ...config };
  if (target === 'aws') {
    const src = specOf(FLEX_SPECS[kind], String(config['skuName'] ?? 'B_Standard_B1ms'));
    for (const k of ['skuName', 'storageGb', 'highAvailability', 'version', 'backupRetentionDays', 'geoRedundantBackup', 'publicNetworkAccess', 'allowAzureServices', 'requireSecureTransport', 'minimumTlsVersion', 'databaseName']) delete next[k];
    next['engine'] = kind === 'azure_postgres' ? 'postgres' : 'mysql';
    next['instanceClass'] = nearestCompute(AWS_RDS_SPECS, src.vcpu, src.ramGb).key;
    if (typeof config['storageGb'] === 'number') next['allocatedStorage'] = config['storageGb'];
    next['multiAz'] = config['highAvailability'] === 'ZoneRedundant';
  }
  return next;
};

/** SQS and Service Bus both carry the queue's name; sizing and pricing differ and are estimated from the target's own defaults. */
const translateQueue: ConfigTranslator = (config, target) => (target === 'azure' ? { name: config['name'], sku: 'Standard', queueNames: 'jobs' } : { name: config['name'] });

const translateStorage: ConfigTranslator = (config, target) => {
  const next = { ...config };
  if (target === 'azure') {
    if (typeof config['estimatedStorageGb'] === 'number') {
      next['estimatedCapacityGb'] = config['estimatedStorageGb'];
      delete next['estimatedStorageGb'];
    }
  } else if (typeof config['estimatedCapacityGb'] === 'number') {
    next['estimatedStorageGb'] = config['estimatedCapacityGb'];
    delete next['estimatedCapacityGb'];
  }
  return next;
};

const translateServerless: ConfigTranslator = (config, target) => {
  const next = { ...config };
  if (target === 'azure') {
    if (typeof config['memorySize'] === 'number') { next['memoryMb'] = config['memorySize']; delete next['memorySize']; }
  } else if (typeof config['memoryMb'] === 'number') {
    next['memorySize'] = config['memoryMb'];
    delete next['memoryMb'];
  }
  // estimatedInvocationsPerMonth / estimatedAvgDurationMs share the same
  // field names on both aws_lambda and azure_functions — carried over as-is.
  return next;
};

/**
 * DynamoDB capacity units and Cosmos DB request units are not the same
 * metric, and there is no official 1:1 conversion — AWS's own guidance
 * treats "provisioned RCU/WCU" and Cosmos "RU/s" as similar order-of-
 * magnitude throughput units for a rough sizing comparison, which is the
 * best available honest approximation. readCapacity+writeCapacity (or
 * request-unit-per-month estimates converted to a rough per-second figure)
 * are summed 1:1 into maxThroughputRu, clamped to Cosmos's real minimums.
 */
const translateNoSql: ConfigTranslator = (config, target) => {
  const next = { ...config };
  if (target === 'azure') {
    const readCap = Number(config['readCapacity'] ?? 0);
    const writeCap = Number(config['writeCapacity'] ?? 0);
    const estimatedRu = readCap + writeCap;
    next['throughputMode'] = config['billingMode'] === 'PAY_PER_REQUEST' ? 'Serverless' : 'Provisioned';
    next['maxThroughputRu'] = Math.max(400, Math.round((estimatedRu || 10) * 100 / 10) * 10);
    delete next['readCapacity'];
    delete next['writeCapacity'];
    delete next['billingMode'];
  } else {
    const ru = Number(config['maxThroughputRu'] ?? 4000);
    next['billingMode'] = config['throughputMode'] === 'Serverless' ? 'PAY_PER_REQUEST' : 'PROVISIONED';
    next['readCapacity'] = Math.max(1, Math.round(ru / 200));
    next['writeCapacity'] = Math.max(1, Math.round(ru / 200));
    delete next['throughputMode'];
    delete next['maxThroughputRu'];
  }
  return next;
};

const translateCache: ConfigTranslator = (config, target) => {
  const next = { ...config };
  if (target === 'azure') {
    const src = specOf(AWS_CACHE_SPECS, String(config['nodeType'] ?? 'cache.t3.medium'));
    delete next['nodeType'];
    delete next['numNodes'];
    delete next['engine'];
    const isPremium = src.ramGb > 5;
    next['family'] = isPremium ? 'P' : 'C';
    const tiers = AZURE_REDIS_CAPACITY_RAM_GB[isPremium ? 'P' : 'C'];
    let bestIdx = 0;
    tiers.forEach((ram, i) => { if (Math.abs(ram - src.ramGb) < Math.abs(tiers[bestIdx]! - src.ramGb)) bestIdx = i; });
    next['capacity'] = isPremium ? Math.max(1, bestIdx) : bestIdx;
    next['sku'] = isPremium ? 'Premium' : (config['multiAzEnabled'] === true ? 'Standard' : 'Basic');
  } else {
    const family = String(config['family'] ?? 'C') === 'P' ? 'P' : 'C';
    const capacity = Number(config['capacity'] ?? 1);
    const ramGb = AZURE_REDIS_CAPACITY_RAM_GB[family][capacity] ?? 3.1;
    delete next['family'];
    delete next['capacity'];
    delete next['sku'];
    next['nodeType'] = nearestByRam(AWS_CACHE_SPECS, ramGb).key;
    next['engine'] = 'redis';
    next['numNodes'] = config['sku'] === 'Basic' ? 1 : 2;
  }
  return next;
};

const CONFIG_TRANSLATORS: Partial<Record<string, ConfigTranslator>> = {
  aws_ec2: translateEc2Vm,
  azure_vm: translateEc2Vm,
  aws_auto_scaling: translateAsgVmss,
  azure_vmss: translateAsgVmss,
  aws_rds: translateRdsSql,
  azure_sql: translateRdsSql,
  aws_s3: translateStorage,
  azure_storage: translateStorage,
  aws_lambda: translateServerless,
  azure_functions: translateServerless,
  aws_dynamodb: translateNoSql,
  azure_cosmos_db: translateNoSql,
  aws_elasticache: translateCache,
  azure_redis: translateCache,
  azure_postgres: translateFlexibleToRds('azure_postgres'),
  azure_mysql: translateFlexibleToRds('azure_mysql'),
  aws_sqs: translateQueue,
  azure_service_bus: translateQueue,
};

/**
 * Brand-specific terms that must never leak into a translated resource's
 * display label. Found during live QA: the comparison panel translated
 * resourceType/config correctly, but never touched the user-authored label,
 * so an Azure-side line item priced as Azure WAF / Azure SQL / Front Door
 * still displayed as "AWS WAF WebACL" / "RDS PostgreSQL" / "CloudFront CDN"
 * — i.e. Azure resources visibly wearing AWS product names. `match` is
 * ordered longest-phrase-first so a multi-word brand name is caught before
 * a shorter substring of itself; `replacement` is that resource's real
 * product name, taken from its own resource definition (lib/resources/*.ts),
 * never invented. Only literal cloud-brand terms are listed here — generic,
 * provider-neutral words a user might type ("Load Balancer", "Cache", "DB",
 * "Multi-AZ") are deliberately left out and pass through unchanged, since
 * they aren't misleading about which provider a resource belongs to.
 */
const BRAND_LABEL: Partial<Record<string, { match: string[]; replacement: string }>> = {
  aws_ec2:           { match: ['EC2 Instance', 'EC2'], replacement: 'EC2' },
  azure_vm:          { match: ['Virtual Machine', 'VM'], replacement: 'VM' },
  aws_rds:           { match: ['RDS Instance', 'RDS'], replacement: 'RDS' },
  azure_sql:         { match: ['Azure SQL Database', 'Azure SQL'], replacement: 'Azure SQL' },
  aws_s3:            { match: ['S3 Bucket', 'S3'], replacement: 'S3' },
  azure_storage:     { match: ['Storage Account'], replacement: 'Storage Account' },
  aws_alb:           { match: ['Application Load Balancer', 'ALB'], replacement: 'ALB' },
  azure_app_gateway: { match: ['Application Gateway', 'App Gateway'], replacement: 'App Gateway' },
  aws_nat:           { match: ['NAT Gateway'], replacement: 'NAT Gateway' },
  azure_nat:         { match: ['NAT Gateway'], replacement: 'NAT Gateway' },
  aws_igw:           { match: ['Internet Gateway'], replacement: 'Internet Gateway' },
  azure_public_ip:   { match: ['Public IP'], replacement: 'Public IP' },
  aws_lambda:        { match: ['Lambda'], replacement: 'Lambda' },
  azure_functions:   { match: ['Azure Functions', 'Functions'], replacement: 'Functions' },
  aws_dynamodb:      { match: ['DynamoDB'], replacement: 'DynamoDB' },
  azure_cosmos_db:   { match: ['Cosmos DB'], replacement: 'Cosmos DB' },
  aws_elasticache:   { match: ['ElastiCache Redis', 'ElastiCache'], replacement: 'ElastiCache' },
  azure_redis:       { match: ['Azure Cache for Redis', 'Azure Redis'], replacement: 'Azure Redis' },
  aws_cloudfront:    { match: ['CloudFront'], replacement: 'CloudFront' },
  azure_front_door:  { match: ['Front Door'], replacement: 'Front Door' },
  aws_waf:           { match: ['AWS WAF WebACL', 'AWS WAF'], replacement: 'AWS WAF' },
  azure_waf:         { match: ['Azure WAF Policy', 'Azure WAF'], replacement: 'Azure WAF' },
  aws_route53:       { match: ['Route 53 DNS', 'Route 53'], replacement: 'Route 53' },
  azure_dns:         { match: ['Azure DNS', 'DNS'], replacement: 'Azure DNS' },
  aws_cloudwatch:    { match: ['CloudWatch Alarms', 'CloudWatch'], replacement: 'CloudWatch' },
  azure_monitor:     { match: ['Azure Monitor', 'Monitor'], replacement: 'Azure Monitor' },
  azure_postgres:    { match: ['Azure PostgreSQL', 'PostgreSQL'], replacement: 'Azure PostgreSQL' },
  azure_mysql:       { match: ['Azure MySQL', 'MySQL'], replacement: 'Azure MySQL' },
  aws_sqs:           { match: ['SQS Queue', 'SQS'], replacement: 'SQS' },
  azure_service_bus: { match: ['Service Bus'], replacement: 'Service Bus' },
};

function translateLabel(originalLabel: string, sourceType: string, targetType: string): string {
  const target = BRAND_LABEL[targetType];
  const source = BRAND_LABEL[sourceType];
  if (!target || !source || !originalLabel) return originalLabel;

  for (const term of source.match) {
    const idx = originalLabel.toLowerCase().indexOf(term.toLowerCase());
    if (idx !== -1) {
      return (originalLabel.slice(0, idx) + target.replacement + originalLabel.slice(idx + term.length))
        .replace(/\s+/g, ' ')
        .replace(/\b([A-Za-z0-9]+) \1\b/gi, '$1')     // "RDS PostgreSQL" -> "Azure PostgreSQL PostgreSQL" -> "Azure PostgreSQL"
        .trim();
    }
  }
  // The original label never mentioned the source's brand term (it was
  // already generic, e.g. "App Server AZ-A") — leave it untouched.
  return originalLabel;
}

export class CloudCostComparisonService {
  /**
   * Translate a set of CanvasNodes to their nearest provider-native
   * equivalent for the target provider — both resourceType AND capacity-
   * equivalent configuration, not just a relabeled type with the source
   * provider's config fields left untouched.
   */
  static translateNodes(nodes: CanvasNode[], targetProvider: Provider): CanvasNode[] {
    return nodes.map((node) => {
      const translatedType = targetTypeFor(node.resourceType, node.config ?? {}, targetProvider);
      const translator = CONFIG_TRANSLATORS[node.resourceType];
      const config = translator ? translator({ ...node.config }, targetProvider) : { ...node.config };
      const label = translateLabel(node.label, node.resourceType, translatedType);

      return {
        ...node,
        provider: targetProvider,
        resourceType: translatedType,
        config,
        label,
      };
    });
  }

  /**
   * For the backend: translate raw persisted resource rows the same way.
   * `res` is a DbArchitectureResource-shaped object with a JSON `configJson`
   * string rather than a `config` object — translated the same way, then
   * re-serialized, so both entry points share one translation table instead
   * of two independently-maintained ones drifting apart (which is how the
   * server path previously ended up doing NO config translation at all).
   */
  static translateResources<T extends { resourceType: string; provider: string; configJson?: string; label?: string; region?: string | null }>(
    resources: T[],
    targetProvider: Provider,
  ): T[] {
    return resources.map((res) => {
      let sourceConfig: Record<string, unknown> = {};
      if (typeof res.configJson === 'string') { try { sourceConfig = JSON.parse(res.configJson) as Record<string, unknown>; } catch { /* a malformed config translates as empty */ } }
      const translatedType = targetTypeFor(res.resourceType, sourceConfig, targetProvider);
      const translator = CONFIG_TRANSLATORS[res.resourceType];

      let configJson = res.configJson;
      if (translator && typeof res.configJson === 'string') {
        try {
          const parsed = JSON.parse(res.configJson) as Record<string, unknown>;
          configJson = JSON.stringify(translator(parsed, targetProvider));
        } catch {
          // Malformed stored config — leave it untouched rather than throwing;
          // downstream pricing will treat it the same way it already does today.
        }
      }

      const label = typeof res.label === 'string' ? translateLabel(res.label, res.resourceType, translatedType) : res.label;

      // The source region string is only valid for the source provider (e.g.
      // "us-east-1" means nothing to Azure) — translate it to the nearest
      // real region of targetProvider rather than leaving it verbatim, which
      // previously made AzurePricingProvider's region filter match nothing
      // and showed a nonexistent region label in the UI.
      const region = translateRegion(res.region, res.provider as Provider, targetProvider);

      return {
        ...res,
        provider: targetProvider,
        resourceType: translatedType,
        configJson,
        label,
        region,
      };
    });
  }
}
