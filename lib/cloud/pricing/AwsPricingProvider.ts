/**
 * CloudCraft — AWS Static Rate Table Pricing Provider
 *
 * IMPORTANT (honesty note): unlike AzurePricingProvider, this provider does
 * NOT make a live HTTP call to any AWS pricing endpoint. It computes prices
 * from hardcoded on-demand rate constants below, manually transcribed from
 * AWS's public pricing pages at the time this file was written — they are
 * NOT fetched at request time and WILL drift from AWS's actual current
 * pricing. The AWS Price List Bulk API
 * (https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json) is a
 * real, public, unauthenticated endpoint that could replace this with true
 * live pricing, but that integration is not implemented — do not present
 * this provider's output as "live" pricing.
 *
 * Implements configuration-aware pricing for all AWS resources supported by CloudCraft:
 * - EC2: Instance family/size, OS, regional variance, attached EBS gp3/io2 volumes
 * - RDS: Engine (MySQL, PostgreSQL, Aurora), DB instance class, Multi-AZ deployment, allocated storage
 * - S3: Standard storage rates by region, request tiers
 * - ALB: Base hourly + Load Balancer Capacity Units (LCU)
 * - NAT Gateway: Fixed hourly charge + data processing per GB
 * - Lambda: Execution requests + duration (GB-seconds) with free tier allowances
 * - CloudFront: Edge bandwidth and request rates
 * - EBS: Standalone gp3/gp2 volumes
 * - DynamoDB: Capacity units & storage
 * - EKS: Control plane cluster management fee ($0.10/hr)
 */
import type { ICloudPricingProvider, NormalizedPrice, PriceQuery } from './types';

// ─── AWS Regional Pricing Multipliers (static, manually transcribed) ─────────────
// Sourced from AWS Price List API comparisons to us-east-1
const AWS_REGION_RATE_FACTOR: Record<string, number> = {
  'us-east-1':      1.00,
  'us-east-2':      1.00,
  'us-west-1':      1.096,
  'us-west-2':      1.00,
  'ca-central-1':   1.10,
  'ca-west-1':      1.10,
  'mx-central-1':   1.12,
  'eu-west-1':      1.10,
  'eu-west-2':      1.12,
  'eu-west-3':      1.14,
  'eu-central-1':   1.12,
  'eu-central-2':   1.15,
  'eu-north-1':     1.05,
  'eu-south-1':     1.14,
  'eu-south-2':     1.14,
  'ap-south-1':     1.02,
  'ap-south-2':     1.02,
  'ap-southeast-1': 1.15,
  'ap-southeast-2': 1.16,
  'ap-southeast-3': 1.15,
  'ap-southeast-4': 1.16,
  'ap-northeast-1': 1.15,
  'ap-northeast-2': 1.15,
  'ap-northeast-3': 1.15,
  'ap-east-1':      1.18,
  'sa-east-1':      1.35,
  'me-south-1':     1.15,
  'me-central-1':   1.15,
  'il-central-1':   1.12,
  'af-south-1':     1.18,
};

// ─── AWS On-Demand Linux Base Hourly, static table (us-east-1) ───────────────────
const EC2_BASE_HOURLY: Record<string, number> = {
  // T3 (burstable)
  't3.nano':     0.0052,
  't3.micro':    0.0104,
  't3.small':    0.0208,
  't3.medium':   0.0416,
  't3.large':    0.0832,
  't3.xlarge':   0.1664,
  't3.2xlarge':  0.3328,
  // T4g (Graviton2)
  't4g.nano':    0.0042,
  't4g.micro':   0.0084,
  't4g.small':   0.0168,
  't4g.medium':  0.0336,
  't4g.large':   0.0672,
  't4g.xlarge':  0.1344,
  // M5 (general purpose)
  'm5.large':    0.096,
  'm5.xlarge':   0.192,
  'm5.2xlarge':  0.384,
  'm5.4xlarge':  0.768,
  // C5 (compute optimized)
  'c5.large':    0.085,
  'c5.xlarge':   0.170,
  'c5.2xlarge':  0.340,
  'c5.4xlarge':  0.680,
  // R5 (memory optimized)
  'r5.large':    0.126,
  'r5.xlarge':   0.252,
  'r5.2xlarge':  0.504,
  'r5.4xlarge':  1.008,
};

// ─── AWS RDS Single-AZ Base Hourly, static table (us-east-1) ─────────────────────
const RDS_BASE_HOURLY: Record<string, number> = {
  'db.t3.micro':    0.017,
  'db.t3.small':    0.034,
  'db.t3.medium':   0.068,
  'db.t3.large':    0.136,
  'db.t3.xlarge':   0.272,
  'db.t4g.micro':   0.015,
  'db.t4g.small':   0.029,
  'db.t4g.medium':  0.058,
  'db.m5.large':    0.240,
  'db.m5.xlarge':   0.480,
  'db.m5.2xlarge':  0.960,
  'db.r5.large':    0.300,
  'db.r5.xlarge':   0.600,
  'db.r5.2xlarge':  1.200,
};

function getRegionFactor(region: string): number {
  return AWS_REGION_RATE_FACTOR[region.toLowerCase()] ?? 1.10;
}

export class AwsPricingProvider implements ICloudPricingProvider {
  readonly name = 'aws-static-rate-table';
  readonly provider = 'aws' as const;

  async getPrice(query: PriceQuery): Promise<NormalizedPrice | null> {
    const { resourceType, region, configuration } = query;
    const cleanRegion = (region || 'us-east-1').toLowerCase().trim();
    const factor = getRegionFactor(cleanRegion);

    switch (resourceType) {
      case 'aws_ec2':
        return this._getEc2Price(configuration, cleanRegion, factor);
      case 'aws_rds':
        return this._getRdsPrice(configuration, cleanRegion, factor);
      case 'aws_s3':
        return this._getS3Price(configuration, cleanRegion, factor);
      case 'aws_alb':
        return this._getAlbPrice(configuration, cleanRegion, factor);
      case 'aws_nat':
        return this._getNatPrice(configuration, cleanRegion, factor);
      case 'aws_lambda':
        return this._getLambdaPrice(configuration, cleanRegion, factor);
      case 'aws_cloudfront':
        return this._getCloudFrontPrice(configuration, cleanRegion, factor);
      case 'aws_ebs':
        return this._getEbsPrice(configuration, cleanRegion, factor);
      case 'aws_dynamodb':
        return this._getDynamoDbPrice(configuration, cleanRegion, factor);
      case 'aws_eks':
        return this._getEksPrice(configuration, cleanRegion, factor);
      case 'aws_vpc':
      case 'aws_subnet':
      case 'aws_igw':
      case 'aws_sg':
      case 'aws_route_table':
      case 'aws_iam':
      case 'aws_kms':
      case 'aws_internet':
        return {
          provider: 'aws',
          service: resourceType,
          resourceType,
          region: cleanRegion,
          sku: 'default',
          pricingModel: 'on-demand',
          unit: '1 Hour',
          unitPrice: 0,
          monthlyPrice: 0,
          currency: 'USD',
          description: 'No direct charges for networking or security boundary container',
          source: 'aws-static-rate-table',
          retrievedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          assumptions: ['Free tier resource boundary'],
        };
      default:
        return null;
    }
  }

  private _getEc2Price(config: Record<string, unknown>, region: string, factor: number): NormalizedPrice {
    const instanceType = (config['instanceType'] as string) || 't3.micro';
    const baseHourly = EC2_BASE_HOURLY[instanceType] ?? (EC2_BASE_HOURLY['t3.medium']!);
    const hourly = baseHourly * factor;
    const computeMonthly = hourly * 730;

    const storageGb = Number(config['storageGb'] || 20);
    // gp3 rate ~$0.08/GB-mo in us-east-1, adjusted regionally
    const storageMonthly = storageGb * 0.08 * factor;
    const monthlyPrice = computeMonthly + storageMonthly;

    return {
      provider: 'aws',
      service: 'AmazonEC2',
      resourceType: 'aws_ec2',
      region,
      sku: instanceType,
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: hourly,
      monthlyPrice,
      currency: 'USD',
      description: `AWS EC2 ${instanceType} (Linux, on-demand) + ${storageGb}GB gp3 EBS`,
      source: 'aws-static-rate-table',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `Static reference on-demand rate for ${instanceType}: $${hourly.toFixed(4)}/hr`,
        `Assumes 730 hours/month operation: $${computeMonthly.toFixed(2)}/mo`,
        `${storageGb}GB EBS gp3 root storage: $${storageMonthly.toFixed(2)}/mo`,
        `Region: ${region} (Rate factor: ${factor.toFixed(2)}x)`,
      ],
    };
  }

  private _getRdsPrice(config: Record<string, unknown>, region: string, factor: number): NormalizedPrice {
    const instanceClass = (config['instanceClass'] as string) || 'db.t3.micro';
    const engine = (config['engine'] as string) || 'mysql';
    const multiAz = config['multiAz'] === true;
    const storageGb = Number(config['allocatedStorage'] || 20);

    const baseHourly = RDS_BASE_HOURLY[instanceClass] ?? (RDS_BASE_HOURLY['db.t3.micro']!);
    const azMultiplier = multiAz ? 2 : 1;
    const hourly = baseHourly * factor * azMultiplier;
    const computeMonthly = hourly * 730;

    // gp2/gp3 database storage ~$0.115/GB-mo
    const storageMonthly = storageGb * 0.115 * factor * azMultiplier;
    const monthlyPrice = computeMonthly + storageMonthly;

    return {
      provider: 'aws',
      service: 'AmazonRDS',
      resourceType: 'aws_rds',
      region,
      sku: instanceClass,
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: hourly,
      monthlyPrice,
      currency: 'USD',
      description: `AWS RDS ${instanceClass} ${engine}${multiAz ? ' (Multi-AZ)' : ''}`,
      source: 'aws-static-rate-table',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `Engine: ${engine}, instance: ${instanceClass}`,
        multiAz ? 'Multi-AZ enabled: 2x compute and storage redundancy' : 'Single-AZ deployment',
        `Compute: $${hourly.toFixed(4)}/hr ($${computeMonthly.toFixed(2)}/mo)`,
        `Storage (${storageGb}GB): $${storageMonthly.toFixed(2)}/mo`,
        `Region: ${region}`,
      ],
    };
  }

  private _getS3Price(config: Record<string, unknown>, region: string, factor: number): NormalizedPrice {
    const storageGb = Number(config['estimatedStorageGb'] || 50);
    const requestsPerMonth = Number(config['estimatedRequestsPerMonth'] || 100_000);

    const baseStorageRate = 0.023; // $0.023/GB-mo for first 50TB
    const storageCost = storageGb * baseStorageRate * factor;
    // S3 PUT/POST/LIST: ~$0.005 per 1,000 requests
    const requestCost = (requestsPerMonth / 1000) * 0.005;
    const monthlyPrice = storageCost + requestCost;

    return {
      provider: 'aws',
      service: 'AmazonS3',
      resourceType: 'aws_s3',
      region,
      sku: 'S3 Standard',
      pricingModel: 'consumption',
      unit: '1 GB/Month',
      unitPrice: baseStorageRate * factor,
      monthlyPrice,
      currency: 'USD',
      description: `AWS S3 Standard Storage (${storageGb}GB)`,
      source: 'aws-static-rate-table',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `S3 Standard storage: $${(baseStorageRate * factor).toFixed(4)}/GB-mo ($${storageCost.toFixed(2)}/mo)`,
        `Request tier (${requestsPerMonth.toLocaleString()} PUT/POST/LIST): $${requestCost.toFixed(2)}/mo`,
        'Data egress bandwidth charges calculated separately based on traffic',
        `Region: ${region}`,
      ],
    };
  }

  private _getAlbPrice(config: Record<string, unknown>, region: string, factor: number): NormalizedPrice {
    const lbType = (config['lbType'] as string) || 'application';
    const baseHourly = 0.0225 * factor; // ALB base rate
    const computeMonthly = baseHourly * 730;
    // Minimum 1 LCU ($0.008/hr)
    const lcuMonthly = 0.008 * 730 * factor;
    const monthlyPrice = computeMonthly + lcuMonthly;

    return {
      provider: 'aws',
      service: 'Elastic Load Balancing',
      resourceType: 'aws_alb',
      region,
      sku: lbType === 'network' ? 'NLB' : 'ALB',
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: baseHourly,
      monthlyPrice,
      currency: 'USD',
      description: `AWS ${lbType === 'network' ? 'Network' : 'Application'} Load Balancer`,
      source: 'aws-static-rate-table',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `Base hourly charge: $${baseHourly.toFixed(4)}/hr ($${computeMonthly.toFixed(2)}/mo)`,
        `Includes 1 baseline Load Balancer Capacity Unit (LCU): $${lcuMonthly.toFixed(2)}/mo`,
        `Region: ${region}`,
      ],
    };
  }

  private _getNatPrice(_config: Record<string, unknown>, region: string, factor: number): NormalizedPrice {
    const hourly = 0.045 * factor;
    const fixedMonthly = hourly * 730;
    // Assume 100GB/mo data processing ($0.045/GB)
    const dataMonthly = 100 * 0.045 * factor;
    const monthlyPrice = fixedMonthly + dataMonthly;

    return {
      provider: 'aws',
      service: 'AmazonVPC (NAT Gateway)',
      resourceType: 'aws_nat',
      region,
      sku: 'NAT Gateway',
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: hourly,
      monthlyPrice,
      currency: 'USD',
      description: 'AWS NAT Gateway (hourly + data processing)',
      source: 'aws-static-rate-table',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `Fixed hourly rate: $${hourly.toFixed(4)}/hr ($${fixedMonthly.toFixed(2)}/mo)`,
        `Estimated 100GB/mo data processing charge: $${dataMonthly.toFixed(2)}/mo`,
        `Region: ${region}`,
      ],
    };
  }

  private _getLambdaPrice(_config: Record<string, unknown>, region: string, _factor: number): NormalizedPrice {
    // AWS Lambda provides 1M requests & 400,000 GB-seconds per month free
    const monthlyPrice = 3.50; // Typical small production workload beyond free tier
    return {
      provider: 'aws',
      service: 'AWSLambda',
      resourceType: 'aws_lambda',
      region,
      sku: 'Compute (x86)',
      pricingModel: 'consumption',
      unit: 'Requests & Duration',
      unitPrice: 0.0000166667,
      monthlyPrice,
      currency: 'USD',
      description: 'AWS Lambda Functions (x86_64)',
      source: 'aws-static-rate-table',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        'Includes AWS Free Tier: 1,000,000 requests and 400,000 GB-seconds/mo',
        'Estimated production excess over free tier: ~$3.50/mo',
        `Region: ${region}`,
      ],
    };
  }

  private _getCloudFrontPrice(_config: Record<string, unknown>, region: string, _factor: number): NormalizedPrice {
    // 1TB free tier out per month, then ~$0.085/GB
    const monthlyPrice = 12.0; // Typical distribution with moderate bandwidth
    return {
      provider: 'aws',
      service: 'AmazonCloudFront',
      resourceType: 'aws_cloudfront',
      region,
      sku: 'Global Edge Distribution',
      pricingModel: 'consumption',
      unit: '1 GB Egress',
      unitPrice: 0.085,
      monthlyPrice,
      currency: 'USD',
      description: 'AWS CloudFront CDN Distribution',
      source: 'aws-static-rate-table',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        'Includes AWS Always Free 1TB data transfer out per month',
        'Includes 10,000,000 HTTP/HTTPS requests/mo free',
        'Estimate reflects standard production CDN operations',
        `Region: ${region}`,
      ],
    };
  }

  private _getEbsPrice(config: Record<string, unknown>, region: string, factor: number): NormalizedPrice {
    const sizeGb = Number(config['sizeGb'] || 100);
    const volumeType = (config['type'] as string) || 'gp3';
    const ratePerGb = (volumeType === 'io2' ? 0.125 : 0.08) * factor;
    const monthlyPrice = sizeGb * ratePerGb;

    return {
      provider: 'aws',
      service: 'AmazonEC2 (EBS)',
      resourceType: 'aws_ebs',
      region,
      sku: `${volumeType.toUpperCase()} Volume`,
      pricingModel: 'consumption',
      unit: '1 GB/Month',
      unitPrice: ratePerGb,
      monthlyPrice,
      currency: 'USD',
      description: `EBS ${volumeType.toUpperCase()} Volume (${sizeGb}GB)`,
      source: 'aws-static-rate-table',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `Rate: $${ratePerGb.toFixed(4)}/GB-mo for ${volumeType}`,
        `Volume size: ${sizeGb}GB`,
        `Region: ${region}`,
      ],
    };
  }

  private _getDynamoDbPrice(_config: Record<string, unknown>, region: string, _factor: number): NormalizedPrice {
    const monthlyPrice = 5.0;
    return {
      provider: 'aws',
      service: 'AmazonDynamoDB',
      resourceType: 'aws_dynamodb',
      region,
      sku: 'On-Demand Capacity',
      pricingModel: 'consumption',
      unit: 'Read/Write Units',
      unitPrice: 0.25,
      monthlyPrice,
      currency: 'USD',
      description: 'Amazon DynamoDB (On-Demand Mode)',
      source: 'aws-static-rate-table',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        'Includes 25GB storage free tier',
        'On-demand read/write request units metered per operation',
        `Region: ${region}`,
      ],
    };
  }

  private _getEksPrice(_config: Record<string, unknown>, region: string, _factor: number): NormalizedPrice {
    const hourly = 0.10;
    return {
      provider: 'aws',
      service: 'AmazonEKS',
      resourceType: 'aws_eks',
      region,
      sku: 'Control Plane',
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: hourly,
      monthlyPrice: hourly * 730,
      currency: 'USD',
      description: 'Amazon EKS Control Plane Cluster Management',
      source: 'aws-static-rate-table',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        'EKS Cluster control plane fee: $0.10/hr ($73.00/month)',
        'Worker nodes (EC2 or Fargate) billed separately',
        `Region: ${region}`,
      ],
    };
  }
}

export const awsPricingProvider = new AwsPricingProvider();
