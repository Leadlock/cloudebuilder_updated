/**
 * CloudCraft — AWS Pricing Provider
 *
 * Integrates with AWS's official Price List Query API
 * (https://docs.aws.amazon.com/awspricelist/latest/) via @aws-sdk/client-pricing
 * for EC2, RDS, S3, EBS, ALB, NAT Gateway, and EKS.
 *
 * Unlike Azure's Retail Prices API, AWS's Price List Query API requires a
 * signed AWS request. This isn't tied to any user's connected cloud account
 * (design-time cost estimation happens with no cloud account in scope at
 * all), so it authenticates with a dedicated, least-privilege service
 * credential read from AWS_PRICING_ACCESS_KEY_ID / AWS_PRICING_SECRET_ACCESS_KEY.
 * That IAM identity needs only `pricing:GetProducts` (the Price List Query
 * API is a metadata service — it doesn't need permission on any actual
 * resource). If those env vars are unset, or a query fails or times out,
 * every method below falls back to the static rate tables — this provider
 * never throws out to the caller and never fabricates a "live" price it
 * didn't get from AWS.
 *
 * NOT live (deliberately, not an oversight — see each method for why):
 * - Lambda / CloudFront / DynamoDB: these are usage-tiered (free tier +
 *   per-request/per-GB/per-RU bands), not a single on-demand SKU rate — a
 *   single GetProducts lookup can't represent that. The usage-aware scaling
 *   logic for these lives in lib/engines/cost/awsPricing.ts (the design-time
 *   estimator's fallback provider), which this provider intentionally does
 *   not duplicate.
 */
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';
import type { ICloudPricingProvider, NormalizedPrice, PriceQuery } from './types';

// ─── AWS Regional Pricing Multipliers (static fallback only) ─────────────
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

// ─── AWS Price List API "location" attribute names ───────────────────────
// The Price List Query API filters on the human-readable region name, not
// the region code — this is AWS's own attribute value, not ours.
const AWS_REGION_LOCATION: Record<string, string> = {
  'us-east-1':      'US East (N. Virginia)',
  'us-east-2':      'US East (Ohio)',
  'us-west-1':      'US West (N. California)',
  'us-west-2':      'US West (Oregon)',
  'ca-central-1':   'Canada (Central)',
  'eu-west-1':      'EU (Ireland)',
  'eu-west-2':      'EU (London)',
  'eu-west-3':      'EU (Paris)',
  'eu-central-1':   'EU (Frankfurt)',
  'eu-central-2':   'EU (Zurich)',
  'eu-north-1':     'EU (Stockholm)',
  'eu-south-1':     'EU (Milan)',
  'eu-south-2':     'EU (Spain)',
  'ap-south-1':     'Asia Pacific (Mumbai)',
  'ap-south-2':     'Asia Pacific (Hyderabad)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-southeast-3': 'Asia Pacific (Jakarta)',
  'ap-southeast-4': 'Asia Pacific (Melbourne)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ap-east-1':      'Asia Pacific (Hong Kong)',
  'sa-east-1':      'South America (Sao Paulo)',
  'me-south-1':     'Middle East (Bahrain)',
  'me-central-1':   'Middle East (UAE)',
  'il-central-1':   'Israel (Tel Aviv)',
  'af-south-1':     'Africa (Cape Town)',
};

const DB_ENGINE_MAP: Record<string, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  'aurora-mysql': 'Aurora MySQL',
  'aurora-postgresql': 'Aurora PostgreSQL',
  mariadb: 'MariaDB',
  oracle: 'Oracle',
  sqlserver: 'SQL Server',
};

/**
 * AWS On-Demand Linux Base Hourly, static fallback (us-east-1). This is the
 * table that actually runs whenever no AWS_PRICING_ACCESS_KEY_ID is
 * configured (getPricingClient() returns null, so queryOnDemandPrice always
 * resolves to null, so _getEc2Price falls straight to this table) — i.e.
 * the table this project's own dev/test environment hits on every request.
 * It had zero c6g.* (Graviton, compute-optimized) entries even though
 * AdaptiveScaleEngine.ts assigns c6g.xlarge/2xlarge/4xlarge at every scale
 * tier above "Production Small", and the aws_ec2 resource's own
 * instanceType dropdown (lib/resources/aws.ts) offers exactly those three
 * values. `?? EC2_BASE_HOURLY['t3.medium']` silently priced every one of
 * them as a t3.medium, so scaling up never changed the shown EC2 cost.
 * c6g.* verified against instances.vantage.sh (sourced from AWS's own
 * Price List API) on 2026-09-24: c6g.xlarge $0.136/hr, c6g.2xlarge
 * $0.272/hr, c6g.4xlarge $0.544/hr.
 */
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
  // C6g (Graviton2, compute optimized)
  'c6g.xlarge':  0.136,
  'c6g.2xlarge': 0.272,
  'c6g.4xlarge': 0.544,
  // R5 (memory optimized)
  'r5.large':    0.126,
  'r5.xlarge':   0.252,
  'r5.2xlarge':  0.504,
  'r5.4xlarge':  1.008,
};

/**
 * AWS RDS Single-AZ Base Hourly, static fallback (us-east-1) — same
 * no-credentials code path as EC2_BASE_HOURLY above. Had zero db.r6g.*
 * entries even though AdaptiveScaleEngine.ts assigns db.r6g.xlarge/
 * 2xlarge/4xlarge at every scale tier above "Production Small", and the
 * aws_rds resource's own instanceClass dropdown offers exactly those three
 * values plus db.t4g.micro/medium. `?? RDS_BASE_HOURLY['db.t3.micro']`
 * silently priced every one of them as a db.t3.micro. Verified against
 * instances.vantage.sh on 2026-09-24: db.t4g.micro $0.016/hr, db.t4g.medium
 * $0.065/hr, db.r6g.xlarge $0.450/hr, db.r6g.2xlarge $0.899/hr,
 * db.r6g.4xlarge $1.798/hr (the db.t4g.* rows below were previously stale —
 * 0.015/0.058 vs the now-verified 0.016/0.065 — corrected at the same time).
 */
const RDS_BASE_HOURLY: Record<string, number> = {
  'db.t3.micro':    0.017,
  'db.t3.small':    0.034,
  'db.t3.medium':   0.068,
  'db.t3.large':    0.136,
  'db.t3.xlarge':   0.272,
  'db.t4g.micro':   0.016,
  'db.t4g.small':   0.029,
  'db.t4g.medium':  0.065,
  'db.m5.large':    0.240,
  'db.m5.xlarge':   0.480,
  'db.m5.2xlarge':  0.960,
  'db.r5.large':    0.300,
  'db.r5.xlarge':   0.600,
  'db.r5.2xlarge':  1.200,
  'db.r6g.xlarge':  0.450,
  'db.r6g.2xlarge': 0.899,
  'db.r6g.4xlarge': 1.798,
};

function getRegionFactor(region: string): number {
  return AWS_REGION_RATE_FACTOR[region.toLowerCase()] ?? 1.10;
}

function getRegionLocation(region: string): string {
  return AWS_REGION_LOCATION[region.toLowerCase()] ?? AWS_REGION_LOCATION['us-east-1']!;
}

// ─── AWS Price List Query API client (lazy, credential-gated) ────────────
// The Pricing API is only served from us-east-1 and ap-south-1 regardless
// of which region a price is being looked up for.
let pricingClient: PricingClient | null | undefined; // undefined = not yet resolved

/** When AWS last refused the price list to the signed-in identity (a role without pricing:GetProducts), or null. */
let deniedAt: number | null = null;
let warnedNoClient = false;
export function awsPricingDeniedRecently(): boolean {
  return deniedAt !== null && Date.now() - deniedAt < 15 * 60 * 1000;
}

// Temporary credentials of a connected account's role (lib/cloud/pricing/awsPricingAccess.ts), used when no server key is configured.
let roleClient: { client: PricingClient; expiresAt: number } | null = null;

export function provideAwsPricingCredentials(creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }, expiresAt: number): void {
  roleClient = { client: new PricingClient({ region: 'us-east-1', credentials: creds }), expiresAt };
  deniedAt = null; // a new session may carry a newer policy
  warnedNoClient = false;
}

/** Whether a live price lookup can be made right now (a server key, or an unexpired role session). */
export function hasAwsPricingAccess(): boolean {
  return !!(process.env['AWS_PRICING_ACCESS_KEY_ID'] && process.env['AWS_PRICING_SECRET_ACCESS_KEY']) || (roleClient !== null && roleClient.expiresAt > Date.now());
}

function getPricingClient(): PricingClient | null {
  if (pricingClient) return pricingClient;
  const accessKeyId = process.env['AWS_PRICING_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['AWS_PRICING_SECRET_ACCESS_KEY'];
  if (!accessKeyId || !secretAccessKey) {
    return roleClient && roleClient.expiresAt > Date.now() ? roleClient.client : null;
  }
  pricingClient = new PricingClient({ region: 'us-east-1', credentials: { accessKeyId, secretAccessKey } });
  return pricingClient;
}

interface AwsPriceDimension {
  unit: string;
  pricePerUnit: { USD?: string };
  description: string;
}
interface AwsPriceListItem {
  product: { productFamily: string; attributes: Record<string, string> };
  terms: { OnDemand?: Record<string, { priceDimensions: Record<string, AwsPriceDimension> }> };
}

/**
 * Runs a GetProducts query and returns every On-Demand (price, unit) pair
 * found across all matching products/dimensions. Returns [] on any failure
 * (no client configured, network error, timeout, no matching product) —
 * callers must fall back to the static tables.
 */
async function queryOnDemandPrices(
  serviceCode: string,
  filters: Array<{ field: string; value: string }>,
): Promise<Array<{ price: number; unit: string }>> {
  const client = getPricingClient();
  if (!client) {
    if (!warnedNoClient) { warnedNoClient = true; console.warn('[AwsPricingProvider] No AWS price list access (no server key and no connected role session): AWS prices use the built-in table.'); }
    return [];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);
  try {
    const cmd = new GetProductsCommand({
      ServiceCode: serviceCode,
      Filters: filters.map((f) => ({ Type: 'TERM_MATCH', Field: f.field, Value: f.value })),
      MaxResults: 10,
    });
    const res = await client.send(cmd, { abortSignal: controller.signal });
    deniedAt = null; // the price list answered, so any earlier refusal no longer applies
    clearTimeout(timeoutId);

    const results: Array<{ price: number; unit: string }> = [];
    for (const raw of res.PriceList ?? []) {
      // The SDK hands each product back as a JSON string wrapper object (not a primitive string), so test for an already-parsed product
      // instead of for a string; treating the wrapper as an object made every lookup find no prices.
      const asObject = raw as unknown as Partial<AwsPriceListItem> | null;
      const item: AwsPriceListItem = asObject && typeof asObject === 'object' && asObject.terms ? (asObject as AwsPriceListItem) : JSON.parse(String(raw));
      const onDemand = item.terms?.OnDemand;
      if (!onDemand) continue;
      for (const term of Object.values(onDemand)) {
        for (const dim of Object.values(term.priceDimensions)) {
          const usd = dim.pricePerUnit?.USD;
          if (!usd) continue;
          const price = parseFloat(usd);
          if (!Number.isFinite(price) || price < 0) continue;
          results.push({ price, unit: dim.unit });
        }
      }
    }
    if (results.length === 0) console.warn(`[AwsPricingProvider] The price list returned no prices for ${serviceCode} (${filters.map((f) => `${f.field}=${f.value}`).join(', ')}); the built-in table is used for this line. Products returned: ${(res.PriceList ?? []).length}.`);
    return results;
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    if (/not authorized to perform: pricing:GetProducts/i.test(message)) deniedAt = Date.now();
    console.warn(`[AwsPricingProvider] Live pricing lookup failed for ${serviceCode}:`, message);
    return [];
  }
}

/**
 * Runs a GetProducts query and returns the first On-Demand USD price found.
 * Returns null on any failure — callers must fall back to the static tables.
 */
async function queryOnDemandPrice(
  serviceCode: string,
  filters: Array<{ field: string; value: string }>,
): Promise<{ price: number; unit: string } | null> {
  const results = await queryOnDemandPrices(serviceCode, filters);
  return results[0] ?? null;
}

export class AwsPricingProvider implements ICloudPricingProvider {
  readonly name = 'aws-price-list-api';
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

  private async _getEc2Price(config: Record<string, unknown>, region: string, factor: number): Promise<NormalizedPrice> {
    const instanceType = (config['instanceType'] as string) || 't3.micro';

    const live = await queryOnDemandPrice('AmazonEC2', [
      { field: 'instanceType', value: instanceType },
      { field: 'location', value: getRegionLocation(region) },
      { field: 'operatingSystem', value: 'Linux' },
      { field: 'tenancy', value: 'Shared' },
      { field: 'preInstalledSw', value: 'NA' },
      { field: 'capacitystatus', value: 'Used' },
    ]);
    const hourly = live ? live.price : (EC2_BASE_HOURLY[instanceType] ?? EC2_BASE_HOURLY['t3.medium']!) * factor;
    const source = live ? 'aws-price-list-api' : 'aws-static-rate-table';
    const computeMonthly = hourly * 730;

    const storageGb = Number(config['storageGb'] || 20);
    // gp3 rate ~$0.08/GB-mo in us-east-1, adjusted regionally (not live-queried)
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
      source,
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        live
          ? `Live on-demand rate from AWS Price List API: $${hourly.toFixed(4)}/hr`
          : `Static reference on-demand rate for ${instanceType}: $${hourly.toFixed(4)}/hr`,
        `Assumes 730 hours/month operation: $${computeMonthly.toFixed(2)}/mo`,
        `${storageGb}GB EBS gp3 root storage: $${storageMonthly.toFixed(2)}/mo`,
        `Region: ${region} (Rate factor: ${factor.toFixed(2)}x)`,
      ],
    };
  }

  private async _getRdsPrice(config: Record<string, unknown>, region: string, factor: number): Promise<NormalizedPrice> {
    const instanceClass = (config['instanceClass'] as string) || 'db.t3.micro';
    const engine = (config['engine'] as string) || 'mysql';
    const multiAz = config['multiAz'] === true;
    const storageGb = Number(config['allocatedStorage'] || 20);

    const live = await queryOnDemandPrice('AmazonRDS', [
      { field: 'instanceType', value: instanceClass },
      { field: 'location', value: getRegionLocation(region) },
      { field: 'databaseEngine', value: DB_ENGINE_MAP[engine.toLowerCase()] ?? 'MySQL' },
      { field: 'deploymentOption', value: multiAz ? 'Multi-AZ' : 'Single-AZ' },
    ]);
    const hourly = live ? live.price : (RDS_BASE_HOURLY[instanceClass] ?? RDS_BASE_HOURLY['db.t3.micro']!) * factor * (multiAz ? 2 : 1);
    const source = live ? 'aws-price-list-api' : 'aws-static-rate-table';
    const computeMonthly = hourly * 730;

    // gp2/gp3 database storage ~$0.115/GB-mo (not live-queried)
    const storageMonthly = storageGb * 0.115 * factor * (multiAz ? 2 : 1);
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
      source,
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        `Engine: ${engine}, instance: ${instanceClass}`,
        multiAz ? 'Multi-AZ enabled: 2x compute and storage redundancy' : 'Single-AZ deployment',
        live
          ? `Live on-demand rate from AWS Price List API: $${hourly.toFixed(4)}/hr ($${computeMonthly.toFixed(2)}/mo)`
          : `Compute: $${hourly.toFixed(4)}/hr ($${computeMonthly.toFixed(2)}/mo)`,
        `Storage (${storageGb}GB): $${storageMonthly.toFixed(2)}/mo`,
        `Region: ${region}`,
      ],
    };
  }

  private async _getS3Price(config: Record<string, unknown>, region: string, factor: number): Promise<NormalizedPrice> {
    const storageGb = Number(config['estimatedStorageGb'] || 50);
    const requestsPerMonth = Number(config['estimatedRequestsPerMonth'] || 100_000);

    const live = await queryOnDemandPrice('AmazonS3', [
      { field: 'location', value: getRegionLocation(region) },
      { field: 'storageClass', value: 'General Purpose' },
      { field: 'volumeType', value: 'Standard' },
    ]);
    const baseStorageRate = live ? live.price : 0.023 * factor;
    const source = live ? 'aws-price-list-api' : 'aws-static-rate-table';
    const storageCost = storageGb * baseStorageRate;
    // S3 PUT/POST/LIST: ~$0.005 per 1,000 requests (not live-queried)
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
      unitPrice: baseStorageRate,
      monthlyPrice,
      currency: 'USD',
      description: `AWS S3 Standard Storage (${storageGb}GB)`,
      source,
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        live
          ? `Live S3 Standard storage rate from AWS Price List API: $${baseStorageRate.toFixed(4)}/GB-mo ($${storageCost.toFixed(2)}/mo)`
          : `S3 Standard storage: $${baseStorageRate.toFixed(4)}/GB-mo ($${storageCost.toFixed(2)}/mo)`,
        `Request tier (${requestsPerMonth.toLocaleString()} PUT/POST/LIST): $${requestCost.toFixed(2)}/mo`,
        'Data egress bandwidth charges calculated separately based on traffic',
        `Region: ${region}`,
      ],
    };
  }

  private async _getAlbPrice(config: Record<string, unknown>, region: string, factor: number): Promise<NormalizedPrice> {
    const lbType = (config['lbType'] as string) || 'application';

    const live = await queryOnDemandPrice('AWSELB', [
      { field: 'location', value: getRegionLocation(region) },
      { field: 'productFamily', value: lbType === 'network' ? 'Load Balancer-Network' : 'Load Balancer-Application' },
    ]);
    const baseHourly = live ? live.price : 0.0225 * factor;
    const source = live ? 'aws-price-list-api' : 'aws-static-rate-table';
    const computeMonthly = baseHourly * 730;
    // Minimum 1 LCU (not live-queried — LCU pricing is usage-metered, not a flat SKU)
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
      source,
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        live
          ? `Live base hourly charge from AWS Price List API: $${baseHourly.toFixed(4)}/hr ($${computeMonthly.toFixed(2)}/mo)`
          : `Base hourly charge: $${baseHourly.toFixed(4)}/hr ($${computeMonthly.toFixed(2)}/mo)`,
        `Includes 1 baseline Load Balancer Capacity Unit (LCU): $${lcuMonthly.toFixed(2)}/mo`,
        `Region: ${region}`,
      ],
    };
  }

  private async _getNatPrice(_config: Record<string, unknown>, region: string, factor: number): Promise<NormalizedPrice> {
    // NAT Gateway has two On-Demand meters under the same productFamily
    // ("NAT Gateway"): an hourly charge and a per-GB data processing charge.
    // Rather than guessing AWS's internal `group` attribute value for each,
    // disambiguate by `unit` — "Hrs" vs "GB" — which is a stable, documented
    // part of the API response regardless of exact meter naming.
    const results = await queryOnDemandPrices('AmazonEC2', [
      { field: 'location', value: getRegionLocation(region) },
      { field: 'productFamily', value: 'NAT Gateway' },
    ]);
    const liveHourly = results.find((r) => r.unit === 'Hrs');
    const liveData = results.find((r) => r.unit.includes('GB'));
    const live = Boolean(liveHourly);

    const hourly = liveHourly ? liveHourly.price : 0.045 * factor;
    const source = live ? 'aws-price-list-api' : 'aws-static-rate-table';
    const fixedMonthly = hourly * 730;
    const dataRate = liveData ? liveData.price : 0.045 * factor;
    // Assume 100GB/mo data processing
    const dataMonthly = 100 * dataRate;
    const monthlyPrice = fixedMonthly + dataMonthly;

    return {
      provider: 'aws',
      service: 'AmazonEC2 (NAT Gateway)',
      resourceType: 'aws_nat',
      region,
      sku: 'NAT Gateway',
      pricingModel: 'on-demand',
      unit: '1 Hour',
      unitPrice: hourly,
      monthlyPrice,
      currency: 'USD',
      description: 'AWS NAT Gateway (hourly + data processing)',
      source,
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        live
          ? `Live hourly rate from AWS Price List API: $${hourly.toFixed(4)}/hr ($${fixedMonthly.toFixed(2)}/mo)`
          : `Fixed hourly rate: $${hourly.toFixed(4)}/hr ($${fixedMonthly.toFixed(2)}/mo)`,
        `Estimated 100GB/mo data processing charge at $${dataRate.toFixed(4)}/GB: $${dataMonthly.toFixed(2)}/mo`,
        `Region: ${region}`,
      ],
    };
  }

  private _getLambdaPrice(_config: Record<string, unknown>, region: string, _factor: number): NormalizedPrice {
    // Not live — see file header. Static reference rate only.
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
    // Not live — see file header. Static reference rate only.
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

  private async _getEbsPrice(config: Record<string, unknown>, region: string, factor: number): Promise<NormalizedPrice> {
    const sizeGb = Number(config['sizeGb'] || 100);
    const volumeType = (config['type'] as string) || 'gp3';

    const live = await queryOnDemandPrice('AmazonEC2', [
      { field: 'location', value: getRegionLocation(region) },
      { field: 'productFamily', value: 'Storage' },
      { field: 'volumeApiName', value: volumeType },
    ]);
    const ratePerGb = live ? live.price : (volumeType === 'io2' ? 0.125 : 0.08) * factor;
    const source = live ? 'aws-price-list-api' : 'aws-static-rate-table';
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
      source,
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        live
          ? `Live rate from AWS Price List API: $${ratePerGb.toFixed(4)}/GB-mo for ${volumeType}`
          : `Rate: $${ratePerGb.toFixed(4)}/GB-mo for ${volumeType}`,
        `Volume size: ${sizeGb}GB`,
        `Region: ${region}`,
      ],
    };
  }

  private _getDynamoDbPrice(_config: Record<string, unknown>, region: string, _factor: number): NormalizedPrice {
    // Not live — see file header. Static reference rate only.
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

  private async _getEksPrice(_config: Record<string, unknown>, region: string, _factor: number): Promise<NormalizedPrice> {
    // EKS control plane pricing's productFamily is "Kubernetes" — a single
    // hourly meter, disambiguated the same way as NAT Gateway (by `unit`,
    // not by guessing AWS's internal group attribute).
    const results = await queryOnDemandPrices('AmazonEKS', [
      { field: 'location', value: getRegionLocation(region) },
      { field: 'productFamily', value: 'Kubernetes' },
    ]);
    const liveHourly = results.find((r) => r.unit === 'Hrs');
    const live = Boolean(liveHourly);
    const hourly = liveHourly ? liveHourly.price : 0.10;
    const source = live ? 'aws-price-list-api' : 'aws-static-rate-table';

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
      source,
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      assumptions: [
        live
          ? `Live control plane fee from AWS Price List API: $${hourly.toFixed(4)}/hr ($${(hourly * 730).toFixed(2)}/month)`
          : `EKS Cluster control plane fee: $${hourly.toFixed(2)}/hr ($${(hourly * 730).toFixed(2)}/month)`,
        'Worker nodes (EC2 or Fargate) billed separately',
        `Region: ${region}`,
      ],
    };
  }
}

export const awsPricingProvider = new AwsPricingProvider();
