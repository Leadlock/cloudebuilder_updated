/**
 * AWS Pricing Provider — Phase 2D
 *
 * IMPORTANT: This implementation uses AWS public list prices sourced from
 * AWS pricing documentation (https://aws.amazon.com/pricing/).
 * Prices are stored as static data tables per resource type and region.
 *
 * LIMITATIONS:
 * - These are on-demand list prices as of late 2024. Actual AWS bills may
 *   differ due to reserved instances, savings plans, spot pricing,
 *   enterprise discounts, support charges, or data transfer.
 * - The AWS Price List API (https://pricing.us-east-1.amazonaws.com/) requires
 *   no authentication for public resources but returns very large JSON files
 *   unsuitable for per-request loading. Live API calls are not implemented in
 *   Phase 2D; that is a Phase 2E enhancement.
 * - Prices labelled "estimate" are based on typical instance configurations.
 *   Storage and transfer costs use average assumptions documented per resource.
 */

import type { PricingProvider, CostLineItem } from './types';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

// ─── Static price tables (USD/hour, on-demand, Linux, us-east-1 base) ────────

/** EC2 on-demand hourly prices (Linux, us-east-1) — AWS public list price */
const EC2_HOURLY_USD: Record<string, number> = {
  // General purpose
  't3.nano':     0.0052,
  't3.micro':    0.0104,
  't3.small':    0.0208,
  't3.medium':   0.0416,
  't3.large':    0.0832,
  't3.xlarge':   0.1664,
  't3.2xlarge':  0.3328,
  // M5
  'm5.large':    0.096,
  'm5.xlarge':   0.192,
  'm5.2xlarge':  0.384,
  'm5.4xlarge':  0.768,
  // C5
  'c5.large':    0.085,
  'c5.xlarge':   0.170,
  'c5.2xlarge':  0.340,
  // R5
  'r5.large':    0.126,
  'r5.xlarge':   0.252,
  'r5.2xlarge':  0.504,
};

/** RDS on-demand hourly prices (Single-AZ, db instance class, us-east-1) */
const RDS_HOURLY_USD: Record<string, number> = {
  'db.t3.micro':    0.017,
  'db.t3.small':    0.034,
  'db.t3.medium':   0.068,
  'db.t3.large':    0.136,
  'db.m5.large':    0.240,
  'db.m5.xlarge':   0.480,
  'db.r5.large':    0.300,
  'db.r5.xlarge':   0.600,
};

/** ElastiCache (Redis) on-demand hourly node prices — AWS public list price, us-east-1 */
const CACHE_HOURLY_USD: Record<string, number> = {
  'cache.t3.micro':   0.017,
  'cache.t3.small':   0.034,
  'cache.t3.medium':  0.068,
  'cache.r6g.large':  0.216,
  'cache.r6g.xlarge': 0.432,
};

/** Regional price multipliers relative to us-east-1 */
const REGION_MULTIPLIER: Record<string, number> = {
  'us-east-1':      1.00,
  'us-east-2':      1.00,
  'us-west-1':      1.10,
  'us-west-2':      1.00,
  'eu-west-1':      1.10,
  'eu-central-1':   1.12,
  'ap-southeast-1': 1.15,
  'ap-northeast-1': 1.15,
};

function regionMultiplier(region: string): number {
  return REGION_MULTIPLIER[region] ?? 1.10;
}

function toMonthly(hourly: number): number {
  return hourly * 730; // AWS uses 730 hours/month
}

// ─── AWS Pricing Provider ─────────────────────────────────────────────────────

export class AwsPricingProvider implements PricingProvider {
  readonly name = 'aws-static-list-price';

  estimateResource(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
  ): CostLineItem | null {
    const mult = regionMultiplier(region);

    switch (resource.resourceType) {
      case 'aws_ec2':        return this._ec2(resource, config, region, mult);
      case 'aws_rds':        return this._rds(resource, config, region, mult);
      case 'aws_s3':         return this._s3(resource, config, region, mult);
      case 'aws_alb':        return this._alb(resource, config, region, mult);
      case 'aws_nat':        return this._nat(resource, config, region, mult);
      case 'aws_lambda':     return this._lambda(resource, config, region, mult);
      case 'aws_cloudfront': return this._cloudfront(resource, config, region, mult);
      case 'aws_ebs':        return this._ebs(resource, config, region, mult);
      case 'aws_dynamodb':   return this._dynamodb(resource, config, region, mult);
      case 'aws_eks':        return this._eks(resource, config, region, mult);
      case 'aws_elasticache': return this._elasticache(resource, config, region, mult);
      case 'aws_sqs':        return this._sqs(resource, config, region, mult);
      case 'aws_vpc':
      case 'aws_subnet':
      case 'aws_igw':
      case 'aws_sg':
      case 'aws_route_table':
      case 'aws_iam':
      case 'aws_kms':
      case 'aws_cloudwatch':
      case 'aws_internet':
        return null; // No direct charges
      default:
        return this._unknown(resource, region);
    }
  }

  private _ec2(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const instanceType = (config['instanceType'] as string) ?? 't3.micro';
    const baseHourly = EC2_HOURLY_USD[instanceType] ?? EC2_HOURLY_USD['t3.medium']!;
    const hourly = baseHourly * mult;
    const monthly = toMonthly(hourly);
    const storageGb = (config['storageGb'] as number) ?? 20;
    const storageType = (config['storageType'] as string) || 'gp3';

    // us-east-1 EBS list prices per GB-month.
    const ebsRatePerGb: Record<string, number> = { gp3: 0.08, gp2: 0.10, io1: 0.125, io2: 0.125 };
    const ebsRate = ebsRatePerGb[storageType] ?? ebsRatePerGb['gp3']!;
    let storageMonthlyCost = storageGb * ebsRate;
    const breakdown: { label: string; monthlyUsd: number }[] = [
      { label: `EC2 ${instanceType} (on-demand, Linux)`, monthlyUsd: monthly },
    ];

    if (storageType === 'io1' || storageType === 'io2') {
      const iops = Number(config['storageIops'] ?? 3000);
      const iopsMonthly = iops * 0.065;
      breakdown.push({ label: `EBS ${storageType} storage (${storageGb}GB)`, monthlyUsd: storageMonthlyCost });
      breakdown.push({ label: `Provisioned IOPS (${iops})`, monthlyUsd: iopsMonthly });
      storageMonthlyCost += iopsMonthly;
    } else {
      breakdown.push({ label: `EBS ${storageType} storage (${storageGb}GB)`, monthlyUsd: storageMonthlyCost });
    }

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly + storageMonthlyCost,
      breakdown,
      assumptions: [
        'On-demand pricing, Linux OS',
        `${storageGb}GB EBS ${storageType} root volume assumed`,
        'No data transfer charges included',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-ec2-ondemand-list-price',
      confidence: 'estimate',
    };
  }

  private _rds(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const instanceClass = (config['instanceClass'] as string) ?? 'db.t3.micro';
    const engine = (config['engine'] as string) ?? 'mysql';
    const multiAz = config['multiAz'] === true;
    const storageGb = (config['allocatedStorage'] as number) ?? 20;
    const storageType = (config['storageType'] as string) || 'gp2';
    const azMult = multiAz ? 2 : 1;
    const baseHourly = RDS_HOURLY_USD[instanceClass] ?? RDS_HOURLY_USD['db.t3.micro']!;
    const hourly = baseHourly * mult * azMult;
    const monthly = toMonthly(hourly);

    // us-east-1 RDS storage list prices per GB-month, applied per AZ copy.
    const storageRatePerGb: Record<string, number> = { gp2: 0.115, gp3: 0.08, io1: 0.125, io2: 0.125, standard: 0.10 };
    const storageRate = storageRatePerGb[storageType] ?? storageRatePerGb['gp2']!;
    let storageMonthly = storageGb * storageRate * azMult;
    const breakdown: { label: string; monthlyUsd: number }[] = [
      { label: `RDS ${instanceClass} ${engine}${multiAz ? ' (Multi-AZ)' : ''}`, monthlyUsd: monthly },
    ];

    if (storageType === 'io1' || storageType === 'io2') {
      const iops = Number(config['iops'] ?? 3000);
      const iopsMonthly = iops * 0.10 * azMult;
      breakdown.push({ label: `Storage ${storageType} (${storageGb}GB${multiAz ? ' x2 Multi-AZ' : ''})`, monthlyUsd: storageMonthly });
      breakdown.push({ label: `Provisioned IOPS (${iops}${multiAz ? ' x2 Multi-AZ' : ''})`, monthlyUsd: iopsMonthly });
      storageMonthly += iopsMonthly;
    } else if (storageType === 'gp3') {
      const throughput = Number(config['storageThroughput'] ?? 125);
      const extraThroughputMonthly = Math.max(0, throughput - 125) * 0.04 * azMult;
      breakdown.push({ label: `Storage gp3 (${storageGb}GB${multiAz ? ' x2 Multi-AZ' : ''})`, monthlyUsd: storageMonthly });
      if (extraThroughputMonthly > 0) {
        breakdown.push({ label: `gp3 throughput above 125MB/s baseline${multiAz ? ' x2 Multi-AZ' : ''}`, monthlyUsd: extraThroughputMonthly });
        storageMonthly += extraThroughputMonthly;
      }
    } else {
      breakdown.push({ label: `Storage ${storageType} (${storageGb}GB${multiAz ? ' x2 Multi-AZ' : ''})`, monthlyUsd: storageMonthly });
    }

    // Read replicas are billed as independent single-AZ instances with their own storage.
    const readReplicas = Math.max(0, Number(config['readReplicas'] ?? 0));
    let replicaHourly = 0;
    let replicaMonthly = 0;
    if (readReplicas > 0) {
      replicaHourly = baseHourly * mult * readReplicas;
      const replicaInstanceMonthly = toMonthly(replicaHourly);
      const replicaStorageMonthly = storageGb * storageRate * readReplicas;
      replicaMonthly = replicaInstanceMonthly + replicaStorageMonthly;
      breakdown.push({ label: `${readReplicas} read replica(s) — ${instanceClass} + ${storageGb}GB ${storageType} each`, monthlyUsd: replicaMonthly });
    }

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: hourly + replicaHourly,
      monthlyUsd: monthly + storageMonthly + replicaMonthly,
      breakdown,
      assumptions: [
        `Engine: ${engine}, instance class: ${instanceClass}`,
        multiAz ? 'Multi-AZ: doubles instance cost and storage' : 'Single-AZ deployment',
        `${storageGb}GB ${storageType} storage assumed`,
        'Backup storage not included',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-rds-ondemand-list-price',
      confidence: 'estimate',
    };
  }

  private _s3(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    _mult: number,
  ): CostLineItem {
    const storageGb = (config['estimatedStorageGb'] as number) ?? 50;
    const requestsPerMonth = (config['estimatedRequestsPerMonth'] as number) ?? 100_000;
    const storageCost = storageGb * 0.023;  // S3 Standard first 50TB
    const requestCost = (requestsPerMonth / 1000) * 0.0004; // PUT/COPY/POST
    const monthly = storageCost + requestCost;

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: `S3 Standard storage (${storageGb}GB)`, monthlyUsd: storageCost },
        { label: `S3 PUT/POST requests (~${requestsPerMonth.toLocaleString()}/mo)`, monthlyUsd: requestCost },
      ],
      assumptions: [
        `${storageGb}GB S3 Standard storage assumed (set estimatedStorageGb to override)`,
        `${requestsPerMonth.toLocaleString()} requests/month assumed`,
        'Data transfer costs not included',
        'S3 Standard storage tier',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-s3-standard-list-price',
      confidence: 'estimate',
    };
  }

  private _alb(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const lbType = (config['lbType'] as string) ?? 'application';
    const hourly = 0.008 * mult; // ALB base hourly
    const lcuMonthly = 5 * mult;  // Estimated 5 LCU/month minimum
    const monthly = toMonthly(hourly) + lcuMonthly;

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly,
      breakdown: [
        { label: `${lbType === 'network' ? 'NLB' : 'ALB'} base hourly`, monthlyUsd: toMonthly(hourly) },
        { label: 'LCU/NLCU charges (estimated min)', monthlyUsd: lcuMonthly },
      ],
      assumptions: [
        `${lbType} load balancer type`,
        'Minimum LCU estimated; actual depends on connection count and throughput',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-elb-list-price',
      confidence: 'estimate',
    };
  }

  private _nat(
    resource: DbArchitectureResource,
    _config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const hourly = 0.045 * mult; // NAT Gateway hourly
    const dataProcessingMonthly = 4.5 * mult; // ~100GB/mo @ $0.045/GB assumed

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: hourly,
      monthlyUsd: toMonthly(hourly) + dataProcessingMonthly,
      breakdown: [
        { label: 'NAT Gateway hourly charge', monthlyUsd: toMonthly(hourly) },
        { label: 'Data processing (~100GB assumed)', monthlyUsd: dataProcessingMonthly },
      ],
      assumptions: [
        '~100GB/month outbound data processing assumed',
        'Actual data transfer cost depends on usage',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-nat-gateway-list-price',
      confidence: 'estimate',
    };
  }

  private _lambda(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    _mult: number,
  ): CostLineItem {
    // us-east-1 list price: $0.20 per 1M requests, $0.0000166667 per GB-second (x86_64).
    const memoryMb = Number(config['memorySize'] ?? 512);
    const invocations = Math.max(0, Number(config['estimatedInvocationsPerMonth'] ?? 1_000_000));
    const avgDurationMs = Math.max(0, Number(config['estimatedAvgDurationMs'] ?? 100));
    const provisionedConcurrency = Math.max(0, Number(config['provisionedConcurrency'] ?? 0));

    const freeRequests = 1_000_000;
    const freeGbSeconds = 400_000;
    const gbSeconds = invocations * (memoryMb / 1024) * (avgDurationMs / 1000);

    const billableRequests = Math.max(0, invocations - freeRequests);
    const billableGbSeconds = Math.max(0, gbSeconds - freeGbSeconds);
    const requestCost = (billableRequests / 1_000_000) * 0.20;
    const computeCost = billableGbSeconds * 0.0000166667;

    const breakdown: { label: string; monthlyUsd: number }[] = [
      { label: `Requests (${invocations.toLocaleString()}/mo, 1M free)`, monthlyUsd: requestCost },
      { label: `Compute (${memoryMb}MB x ${avgDurationMs}ms, 400K GB-s free)`, monthlyUsd: computeCost },
    ];

    let provisionedCost = 0;
    if (provisionedConcurrency > 0) {
      // $0.0000041667 per GB-second of provisioned concurrency, held 24/7.
      const provisionedGbSecondsPerMonth = provisionedConcurrency * (memoryMb / 1024) * 730 * 3600;
      provisionedCost = provisionedGbSecondsPerMonth * 0.0000041667;
      breakdown.push({ label: `Provisioned concurrency (${provisionedConcurrency} instances, always-on)`, monthlyUsd: provisionedCost });
    }

    const monthly = requestCost + computeCost + provisionedCost;

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown,
      assumptions: [
        'Includes AWS Free Tier: 1,000,000 requests and 400,000 GB-seconds/mo',
        `${invocations.toLocaleString()} invocations/mo at ${avgDurationMs}ms average duration assumed`,
        `Region: ${region}`,
      ],
      pricingSource: 'aws-lambda-list-price',
      confidence: 'estimate',
    };
  }

  private _cloudfront(
    resource: DbArchitectureResource,
    _config: Record<string, unknown>,
    region: string,
    _mult: number,
  ): CostLineItem {
    const monthly = 12.0;
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: 'CloudFront CDN data transfer & requests', monthlyUsd: monthly },
      ],
      assumptions: [
        'Includes 1TB data egress and 10M requests free tier allowance',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-cloudfront-list-price',
      confidence: 'estimate',
    };
  }

  private _ebs(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const sizeGb = Number(config['sizeGb'] || 100);
    const ratePerGb = 0.08 * mult;
    const monthly = sizeGb * ratePerGb;
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: `EBS gp3 volume (${sizeGb}GB)`, monthlyUsd: monthly },
      ],
      assumptions: [
        `gp3 rate: $${ratePerGb.toFixed(4)}/GB-mo`,
        `Region: ${region}`,
      ],
      pricingSource: 'aws-ebs-list-price',
      confidence: 'estimate',
    };
  }

  private _dynamodb(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    _mult: number,
  ): CostLineItem {
    const billingMode = (config['billingMode'] as string) || 'PAY_PER_REQUEST';
    const storageGb = Math.max(0, Number(config['estimatedStorageGb'] ?? 5));
    const freeStorageGb = 25;
    const storageMonthly = Math.max(0, storageGb - freeStorageGb) * 0.25;
    const breakdown: { label: string; monthlyUsd: number }[] = [];
    let capacityMonthly = 0;

    if (billingMode === 'PROVISIONED') {
      const readCapacity = Math.max(0, Number(config['readCapacity'] ?? 5));
      const writeCapacity = Math.max(0, Number(config['writeCapacity'] ?? 5));
      const readMonthly = readCapacity * 0.00013 * 730;
      const writeMonthly = writeCapacity * 0.00065 * 730;
      breakdown.push(
        { label: `Provisioned read capacity (${readCapacity} RCU)`, monthlyUsd: readMonthly },
        { label: `Provisioned write capacity (${writeCapacity} WCU)`, monthlyUsd: writeMonthly },
      );
      capacityMonthly = readMonthly + writeMonthly;
    } else {
      const readUnits = Math.max(0, Number(config['estimatedReadRequestUnitsPerMonth'] ?? 1_000_000));
      const writeUnits = Math.max(0, Number(config['estimatedWriteRequestUnitsPerMonth'] ?? 500_000));
      const readMonthly = (readUnits / 1_000_000) * 0.25;
      const writeMonthly = (writeUnits / 1_000_000) * 1.25;
      breakdown.push(
        { label: `On-demand read request units (${readUnits.toLocaleString()}/mo)`, monthlyUsd: readMonthly },
        { label: `On-demand write request units (${writeUnits.toLocaleString()}/mo)`, monthlyUsd: writeMonthly },
      );
      capacityMonthly = readMonthly + writeMonthly;
    }
    breakdown.push({ label: `Storage (${storageGb}GB, 25GB free)`, monthlyUsd: storageMonthly });

    const monthly = capacityMonthly + storageMonthly;
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown,
      assumptions: [
        `Billing mode: ${billingMode}`,
        'Includes 25GB free tier storage',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-dynamodb-list-price',
      confidence: 'estimate',
    };
  }

  private _elasticache(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const nodeType = (config['nodeType'] as string) ?? 'cache.t3.medium';
    const numNodes = Math.max(1, Number(config['numNodes'] ?? 2));
    const baseHourly = CACHE_HOURLY_USD[nodeType] ?? CACHE_HOURLY_USD['cache.t3.medium']!;
    const hourly = baseHourly * mult * numNodes;
    const monthly = toMonthly(hourly);

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly,
      breakdown: [
        { label: `ElastiCache ${nodeType} x${numNodes} node(s)`, monthlyUsd: monthly },
      ],
      assumptions: [
        `Node type: ${nodeType}, ${numNodes} node(s)`,
        'Backup/snapshot storage not included',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-elasticache-ondemand-list-price',
      confidence: 'estimate',
    };
  }

  private _sqs(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    _mult: number,
  ): CostLineItem {
    const requests = Math.max(0, Number(config['estimatedRequestsPerMonth'] ?? 1_000_000));
    const freeRequests = 1_000_000;
    const billableRequests = Math.max(0, requests - freeRequests);
    const monthly = (billableRequests / 1_000_000) * 0.40;

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: `Requests (${requests.toLocaleString()}/mo, 1M free)`, monthlyUsd: monthly },
      ],
      assumptions: [
        'Includes AWS Free Tier: 1,000,000 requests/mo',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-sqs-list-price',
      confidence: 'estimate',
    };
  }

  private _eks(
    resource: DbArchitectureResource,
    _config: Record<string, unknown>,
    region: string,
    _mult: number,
  ): CostLineItem {
    const hourly = 0.10;
    const monthly = hourly * 730;
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly,
      breakdown: [
        { label: 'EKS cluster control plane ($0.10/hr)', monthlyUsd: monthly },
      ],
      assumptions: [
        'Fixed control plane management fee',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-eks-list-price',
      confidence: 'estimate',
    };
  }

  private _unknown(resource: DbArchitectureResource, region: string): CostLineItem {
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
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

export const awsPricingProvider = new AwsPricingProvider();
