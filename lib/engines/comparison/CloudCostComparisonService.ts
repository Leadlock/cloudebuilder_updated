import { CanvasNode } from '@/types';

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
};
const AZURE_TO_AWS_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(AWS_TO_AZURE_TYPE).map(([aws, azure]) => [azure, aws]),
);

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
 * Azure SQL DTU-model tier -> approximate vCPU equivalent, used only to pick
 * the nearest tier for a given RDS instance class. DTU is not literally
 * vCPU, but AWS's own DTU-to-vCore guidance and Microsoft's published
 * DTU benchmark data put S0-S4 in roughly this vCPU-equivalent band; this
 * is documented as an approximation, not a precise conversion.
 *
 * Deliberately mapped to the classic DTU tier names (S0-S4) rather than the
 * vCore-model names (GP_Gen5_2 etc.) also offered in the Azure SQL RDE's
 * `tier` dropdown: lib/engines/cost/azurePricing.ts's `_dtuFromTier` (the
 * static fallback pricing path) only recognizes S0-S4 and silently defaults
 * anything else to 10 DTU — translating into a vCore-model name would
 * reintroduce the exact "collapses to one default regardless of input" bug
 * this service exists to fix.
 */
const AZURE_SQL_TIERS: Array<{ key: string; vcpuEquivalent: number }> = [
  { key: 'S0', vcpuEquivalent: 1 },
  { key: 'S1', vcpuEquivalent: 2 },
  { key: 'S2', vcpuEquivalent: 4 },
  { key: 'S3', vcpuEquivalent: 8 },
  { key: 'S4', vcpuEquivalent: 16 },
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

const translateRdsSql: ConfigTranslator = (config, target) => {
  const next = { ...config };
  const multiAz = config['multiAz'] === true || config['zoneRedundant'] === true;
  if (target === 'azure') {
    const src = specOf(AWS_RDS_SPECS, String(config['instanceClass'] ?? 'db.t3.medium'));
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
};

export class CloudCostComparisonService {
  /**
   * Translate a set of CanvasNodes to their nearest provider-native
   * equivalent for the target provider — both resourceType AND capacity-
   * equivalent configuration, not just a relabeled type with the source
   * provider's config fields left untouched.
   */
  static translateNodes(nodes: CanvasNode[], targetProvider: Provider): CanvasNode[] {
    const typeMap = targetProvider === 'azure' ? AWS_TO_AZURE_TYPE : AZURE_TO_AWS_TYPE;

    return nodes.map((node) => {
      const translatedType = typeMap[node.resourceType] || node.resourceType;
      const translator = CONFIG_TRANSLATORS[node.resourceType];
      const config = translator ? translator({ ...node.config }, targetProvider) : { ...node.config };

      return {
        ...node,
        provider: targetProvider,
        resourceType: translatedType,
        config,
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
  static translateResources<T extends { resourceType: string; provider: string; configJson?: string }>(
    resources: T[],
    targetProvider: Provider,
  ): T[] {
    const typeMap = targetProvider === 'azure' ? AWS_TO_AZURE_TYPE : AZURE_TO_AWS_TYPE;

    return resources.map((res) => {
      const translatedType = typeMap[res.resourceType] || res.resourceType;
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

      return {
        ...res,
        provider: targetProvider,
        resourceType: translatedType,
        configJson,
      };
    });
  }
}
