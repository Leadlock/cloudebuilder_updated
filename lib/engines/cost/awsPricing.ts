/**
 * AWS Pricing Provider — static fallback
 *
 * This is NOT the primary pricing path anymore. CostEstimator.estimateAsync()
 * (lib/engines/cost/CostEstimator.ts) queries the live
 * CloudProviderPricingService (lib/cloud/pricing/CloudProviderPricingService.ts)
 * first — which itself hits the real AWS Price List Query API for EC2, RDS,
 * S3, EBS, ALB, NAT Gateway, and EKS (see lib/cloud/pricing/AwsPricingProvider.ts)
 * — and only falls back to this class when that live call is unavailable or
 * throws. So in the normal case this file's static tables are dead code that
 * exists purely for resilience, not the day-to-day pricing source.
 *
 * It's still load-bearing for two real reasons, not just inertia:
 * 1. It's the offline/no-credentials/API-down fallback for every resource
 *    type, including the ones the live provider does cover.
 * 2. Lambda, CloudFront, and DynamoDB are usage-tiered (free tier + per-
 *    request/GB/RU bands) rather than a single on-demand SKU rate, so the
 *    live provider deliberately never covers them (see the "NOT live"
 *    section of AwsPricingProvider.ts's header) — this file's usage-aware
 *    scaling logic for those three is the ONLY place that modeling exists,
 *    live or not.
 *
 * Prices below are AWS public list prices as of late 2024, sourced from
 * https://aws.amazon.com/pricing/, and will drift over time — that's
 * expected and acceptable for a fallback path, not a correctness bug.
 */

import { externalServiceLineItem } from '@/lib/cloud/pricing/externalServicePrice';
import type { PricingProvider, CostLineItem } from './types';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';
import { autoScalingAsInstances } from './autoScaling';
import { estimateCloudFront } from './cloudfrontEstimate';

// ─── Static price tables (USD/hour, on-demand, Linux, us-east-1 base) ────────

/**
 * EC2 on-demand hourly prices (Linux, us-east-1) — AWS public list price.
 * The t4g/c6g (Graviton) rows were added after an audit found
 * AdaptiveScaleEngine.ts recommends exactly these instance types at every
 * scale tier above "Entry/Dev" — and the aws_ec2 resource's own
 * instanceType dropdown (lib/resources/aws.ts) offers exactly these same
 * five values — but none of them existed in this table. The
 * `?? EC2_HOURLY_USD['t3.medium']` fallback below silently priced a
 * c6g.4xlarge as if it were a t3.medium, so scaling up never changed the
 * displayed cost even though the (correct) instance type label did.
 * Verified against instances.vantage.sh (sourced from AWS's own Price List
 * API) on 2026-09-24: t4g.small $0.0168/hr, t4g.medium $0.0336/hr,
 * c6g.xlarge $0.136/hr, c6g.2xlarge $0.272/hr, c6g.4xlarge $0.544/hr.
 */
const EC2_HOURLY_USD: Record<string, number> = {
  // General purpose
  't3.nano':     0.0052,
  't3.micro':    0.0104,
  't3.small':    0.0208,
  't3.medium':   0.0416,
  't3.large':    0.0832,
  't3.xlarge':   0.1664,
  't3.2xlarge':  0.3328,
  // T4g (Graviton, burstable) — only the sizes the RDE dropdown offers
  't4g.small':   0.0168,
  't4g.medium':  0.0336,
  // M5
  'm5.large':    0.096,
  'm5.xlarge':   0.192,
  'm5.2xlarge':  0.384,
  'm5.4xlarge':  0.768,
  // C5
  'c5.large':    0.085,
  'c5.xlarge':   0.170,
  'c5.2xlarge':  0.340,
  // C6g (Graviton, compute optimized) — only the sizes the RDE dropdown offers
  'c6g.xlarge':  0.136,
  'c6g.2xlarge': 0.272,
  'c6g.4xlarge': 0.544,
  // R5
  'r5.large':    0.126,
  'r5.xlarge':   0.252,
  'r5.2xlarge':  0.504,
};

/**
 * RDS on-demand hourly prices (Single-AZ, db instance class, us-east-1).
 * db.t4g.* / db.r6g.* added for the same reason as EC2's Graviton rows
 * above — AdaptiveScaleEngine recommends db.t4g.micro/medium and
 * db.r6g.xlarge/2xlarge/4xlarge at every scale tier, and the aws_rds
 * resource's own instanceClass dropdown offers exactly these five values,
 * but none of them existed here. Verified against instances.vantage.sh on
 * 2026-09-24: db.t4g.micro $0.016/hr, db.t4g.medium $0.065/hr,
 * db.r6g.xlarge $0.450/hr, db.r6g.2xlarge $0.899/hr, db.r6g.4xlarge $1.798/hr.
 */
const RDS_HOURLY_USD: Record<string, number> = {
  // PostgreSQL Single-AZ, us-east-1. Checked against the AWS price list: db.t3.medium $0.072, db.m5.large $0.178, db.r5.large $0.25.
  // The other sizes in a family follow by doubling per size step. MySQL/MariaDB run roughly 4-6% lower; Oracle and SQL Server add licence cost.
  'db.t3.micro':    0.018,
  'db.t3.small':    0.036,
  'db.t3.medium':   0.072,
  'db.t3.large':    0.145,
  'db.t4g.micro':   0.016,
  'db.t4g.medium':  0.065,
  'db.m5.large':    0.178,
  'db.m5.xlarge':   0.356,
  'db.r5.large':    0.250,
  'db.r5.xlarge':   0.500,
  'db.r6g.xlarge':  0.450,
  'db.r6g.2xlarge': 0.899,
  'db.r6g.4xlarge': 1.798,
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

/** Built-in on-demand hourly price (us-east-1, Linux) of an EC2 instance type, or undefined when it is not in the table. */
export const ec2HourlyUsd = (instanceType: string): number | undefined => EC2_HOURLY_USD[instanceType];

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
      case 'aws_container_service': return this._containerService(resource, config, region, mult);
      case 'aws_auto_scaling': return this._autoScaling(resource, config, region, mult);
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
      case 'aws_ecs':        return this._ecs(resource, config, region, mult);
      case 'aws_route53':    return this._route53(resource, config, region, mult);
      case 'aws_waf':        return this._waf(resource, config, region, mult);
      case 'aws_external_service': return externalServiceLineItem(resource, 'aws', region, config);
      case 'aws_kms':        return this._kms(resource, config, region, mult);
      case 'aws_cloudwatch': return this._cloudwatch(resource, config, region, mult);
      case 'aws_vpc':
      case 'aws_subnet':
      case 'aws_igw':
      case 'aws_sg':
      case 'aws_nacl':
      case 'aws_route_table':
      case 'aws_iam':
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

  /** A container service is one EC2 instance with its disk (and a fixed public IP when asked for): priced as that instance. */
  private _containerService(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const instanceType = (config['instanceType'] as string) ?? 't3.small';
    const hourly = (EC2_HOURLY_USD[instanceType] ?? EC2_HOURLY_USD['t3.small']!) * mult;
    const monthly = toMonthly(hourly);
    const storageGb = Number(config['storageGb'] ?? 20);
    const disk = storageGb * 0.08;
    const breakdown: { label: string; monthlyUsd: number }[] = [
      { label: `EC2 ${instanceType} (on-demand, Linux)`, monthlyUsd: monthly },
      { label: `EBS gp3 storage (${storageGb}GB)`, monthlyUsd: disk },
    ];
    let ip = 0;
    if (config['elasticIp'] === true) { ip = toMonthly(0.005 * mult); breakdown.push({ label: 'Public IPv4 address', monthlyUsd: ip }); }
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly + disk + ip,
      breakdown,
      assumptions: [
        'On-demand pricing, Linux OS, one container instance',
        'No data transfer or image storage (ECR) charges included',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-ec2-ondemand-list-price',
      confidence: 'estimate',
    };
  }

  /** An Auto Scaling group costs what its instances cost: price one instance as EC2, then multiply by the group's capacity. */
  private _autoScaling(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const asg = autoScalingAsInstances(config);
    const one = this._ec2(resource, asg.instanceConfig, region, mult);
    const q = asg.quantity;
    return {
      ...one,
      hourlyUsd: one.hourlyUsd * q,
      monthlyUsd: one.monthlyUsd * q,
      breakdown: one.breakdown.map((b) => ({ ...b, label: `${q} × ${b.label}`, monthlyUsd: b.monthlyUsd * q })),
      assumptions: [...asg.assumptions, ...one.assumptions],
      pricingSource: 'aws-ec2-ondemand-list-price',
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
    // us-east-1 list price: $0.0225 per load-balancer hour, plus $0.008 per LCU-hour (ALB) or $0.006 per NLCU-hour (NLB). One LCU is assumed.
    const hourly = 0.0225 * mult;
    const capacityUnitHourly = (lbType === 'network' ? 0.006 : 0.008) * mult;
    const lcuMonthly = toMonthly(capacityUnitHourly);
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
        { label: `${lbType === 'network' ? 'NLCU' : 'LCU'} charges (1 unit assumed)`, monthlyUsd: lcuMonthly },
      ],
      assumptions: [
        `${lbType} load balancer type`,
        'One LCU assumed; actual cost depends on new connections, active connections, processed bytes and rule evaluations',
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
    config: Record<string, unknown>,
    region: string,
    _mult: number,
  ): CostLineItem {
    const e = estimateCloudFront(config);
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: e.monthlyUsd / 730,
      monthlyUsd: e.monthlyUsd,
      breakdown: e.breakdown,
      assumptions: [...e.assumptions, `Region: ${region}`],
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
    const volumeType = (config['volumeType'] as string) || 'gp3';
    // us-east-1 EBS list prices per GB-month.
    const ratePerGbMap: Record<string, number> = { gp3: 0.08, gp2: 0.10, io1: 0.125, io2: 0.125, st1: 0.045, sc1: 0.015 };
    const ratePerGb = (ratePerGbMap[volumeType] ?? ratePerGbMap['gp3']!) * mult;
    let monthly = sizeGb * ratePerGb;
    const breakdown: { label: string; monthlyUsd: number }[] = [
      { label: `EBS ${volumeType} volume (${sizeGb}GB)`, monthlyUsd: monthly },
    ];

    if (volumeType === 'io1' || volumeType === 'io2') {
      const iops = Number(config['iops'] ?? 3000);
      const iopsMonthly = iops * 0.065 * mult;
      breakdown.push({ label: `Provisioned IOPS (${iops})`, monthlyUsd: iopsMonthly });
      monthly += iopsMonthly;
    } else if (volumeType === 'gp3') {
      const throughput = Number(config['throughputMbps'] ?? 125);
      const extraThroughputMonthly = Math.max(0, throughput - 125) * 0.04 * mult;
      if (extraThroughputMonthly > 0) {
        breakdown.push({ label: `Throughput above 125MB/s baseline`, monthlyUsd: extraThroughputMonthly });
        monthly += extraThroughputMonthly;
      }
    }

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
        `${volumeType} rate: $${ratePerGb.toFixed(4)}/GB-mo`,
        `Region: ${region}`,
      ],
      pricingSource: 'aws-ebs-list-price',
      confidence: 'estimate',
    };
  }

  private _kms(
    resource: DbArchitectureResource,
    _config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    // $1.00/customer-managed key/month (flat, not usage-based for standard keys).
    const monthly = 1.0 * mult;
    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: 'Customer-managed KMS key', monthlyUsd: monthly },
      ],
      assumptions: [
        'API request charges not included — first 20,000 free requests/mo, then $0.03/10,000',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-kms-list-price',
      confidence: 'estimate',
    };
  }

  private _cloudwatch(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    // $0.10/alarm/month (standard resolution) + log storage at $0.03/GB.
    const alarmMonthly = 0.10 * mult;
    const estimatedLogGb = 1; // conservative baseline assumption for a single log group's steady-state storage
    const logStorageMonthly = estimatedLogGb * 0.03 * mult;
    const monthly = alarmMonthly + logStorageMonthly;

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: 'Alarm (standard resolution)', monthlyUsd: alarmMonthly },
        { label: `Log storage (~${estimatedLogGb}GB assumed)`, monthlyUsd: logStorageMonthly },
      ],
      assumptions: [
        `Log retention: ${config['logRetentionDays'] ?? 30} days`,
        'Log ingestion volume not included — $0.50/GB ingested',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-cloudwatch-list-price',
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

  private _ecs(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const launchType = (config['launchType'] as string) || 'FARGATE';
    const desiredCount = Math.max(0, Number(config['desiredCount'] ?? 2));

    if (launchType !== 'FARGATE') {
      return {
        resourceId: resource.id,
        resourceLabel: resource.label,
        resourceType: resource.resourceType,
        provider: 'aws',
        region,
        hourlyUsd: 0,
        monthlyUsd: 0,
        breakdown: [],
        assumptions: [
          'EC2 launch type: task compute is billed via the underlying EC2 instances/Auto Scaling group, not as a separate ECS charge',
          `Region: ${region}`,
        ],
        pricingSource: 'aws-ecs-ec2-no-separate-charge',
        confidence: 'estimate',
      };
    }

    // Fargate us-east-1 list price: $0.04048/vCPU-hour, $0.004445/GB-hour.
    const vcpu = Number(config['cpu'] ?? 256) / 1024;
    const memoryGb = Number(config['memory'] ?? 512) / 1024;
    const hourlyPerTask = (vcpu * 0.04048 + memoryGb * 0.004445) * mult;
    const hourly = hourlyPerTask * desiredCount;
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
        { label: `Fargate ${vcpu} vCPU / ${memoryGb.toFixed(2)}GB x ${desiredCount} task(s)`, monthlyUsd: monthly },
      ],
      assumptions: [
        `Launch type: Fargate, ${desiredCount} desired task(s)`,
        `${vcpu} vCPU / ${memoryGb.toFixed(2)}GB per task`,
        `Region: ${region}`,
      ],
      pricingSource: 'aws-fargate-list-price',
      confidence: 'estimate',
    };
  }

  private _eks(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    mult: number,
  ): CostLineItem {
    const controlPlaneHourly = 0.10 * mult;
    const controlPlaneMonthly = toMonthly(controlPlaneHourly);

    const nodeInstanceType = (config['nodeInstanceType'] as string) ?? 't3.medium';
    const nodeCount = Math.max(0, Number(config['nodeCount'] ?? 3));
    const isSpot = config['capacityType'] === 'SPOT';
    const nodeBaseHourly = EC2_HOURLY_USD[nodeInstanceType] ?? EC2_HOURLY_USD['t3.medium']!;
    // Spot typically runs ~70% below on-demand; a rough estimate, not a live spot price.
    const nodeHourlyEach = nodeBaseHourly * mult * (isSpot ? 0.3 : 1);
    const nodesHourly = nodeHourlyEach * nodeCount;
    const nodesMonthly = toMonthly(nodesHourly);

    const hourly = controlPlaneHourly + nodesHourly;
    const monthly = controlPlaneMonthly + nodesMonthly;

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: hourly,
      monthlyUsd: monthly,
      breakdown: [
        { label: 'EKS cluster control plane ($0.10/hr)', monthlyUsd: controlPlaneMonthly },
        { label: `Worker nodes: ${nodeInstanceType} x${nodeCount}${isSpot ? ' (Spot, ~70% off)' : ''}`, monthlyUsd: nodesMonthly },
      ],
      assumptions: [
        'Fixed control plane management fee',
        `${nodeCount} x ${nodeInstanceType} worker node(s), ${isSpot ? 'Spot (rough estimate, not a live spot price)' : 'On-Demand'}`,
        `Region: ${region}`,
      ],
      pricingSource: 'aws-eks-list-price',
      confidence: 'estimate',
    };
  }

  private _route53(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    _mult: number,
  ): CostLineItem {
    // $0.50/hosted-zone/month (first 25 zones) + $0.40 per million standard queries (first 1B/mo).
    const hostedZoneMonthly = 0.50;
    const isPrivate = config['hostedZoneType'] === 'Private';
    const privateZoneMonthly = isPrivate ? 0.10 : 0; // Private zones bill an additional VPC association charge.
    const monthly = hostedZoneMonthly + privateZoneMonthly;

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: `Hosted zone (${isPrivate ? 'Private' : 'Public'})`, monthlyUsd: hostedZoneMonthly },
        ...(isPrivate ? [{ label: 'Private zone VPC association', monthlyUsd: privateZoneMonthly }] : []),
      ],
      assumptions: [
        'Query volume charges not included — first 1B standard queries/mo are $0.40/million',
        `Region: ${region}`,
      ],
      pricingSource: 'aws-route53-list-price',
      confidence: 'estimate',
    };
  }

  private _waf(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    region: string,
    _mult: number,
  ): CostLineItem {
    // $5.00/Web ACL/month + $1.00/rule/month + $0.60 per million requests processed.
    const webAclMonthly = 5.0;
    const managedRuleGroups = Array.isArray(config['managedRuleGroups']) ? config['managedRuleGroups'] as string[] : [];
    const ruleCount = managedRuleGroups.length + (config['rateLimitEnabled'] === true ? 1 : 0);
    const rulesMonthly = ruleCount * 1.0;
    const monthly = webAclMonthly + rulesMonthly;

    return {
      resourceId: resource.id,
      resourceLabel: resource.label,
      resourceType: resource.resourceType,
      provider: 'aws',
      region,
      hourlyUsd: monthly / 730,
      monthlyUsd: monthly,
      breakdown: [
        { label: 'Web ACL', monthlyUsd: webAclMonthly },
        { label: `${ruleCount} rule(s)`, monthlyUsd: rulesMonthly },
      ],
      assumptions: [
        'Request-processing charges not included — $0.60 per million requests',
        `${ruleCount} rule(s): ${managedRuleGroups.length} managed rule group(s)${config['rateLimitEnabled'] === true ? ' + 1 rate-based rule' : ''}`,
        `Region: ${region}`,
      ],
      pricingSource: 'aws-waf-list-price',
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
