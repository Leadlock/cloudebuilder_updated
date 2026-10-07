/**
 * Price quality: every line says how far it can be trusted, and a fixed set of reference designs with hand-checked prices makes a pricing
 * change that moves a number fail here instead of reaching a person. All input is saved data: no network, no model.
 */
import { assessLine, assessResult, oldestPriceTime } from '@/lib/cost/quality/priceQuality';
import { pickAzureMeters } from '@/lib/cost/ai/meterPicker';
import { monthlyFromRetailItem, type AzureRetailPriceItem } from '@/lib/cloud/pricing/azureRetail';
import { CloudCostComparisonService } from '@/lib/engines/comparison/CloudCostComparisonService';
import { PricingCache, PRICING_CACHE_VERSION } from '@/lib/cloud/pricing/PricingCache';
import type { AskModel } from '@/lib/cost/ai/askModel';
import type { CostLineItem } from '@/lib/engines/cost/types';

const line = (o: Partial<CostLineItem>): CostLineItem => ({
  resourceId: 'r1', resourceLabel: 'R', resourceType: 'aws_ec2', provider: 'aws', region: 'us-east-1', hourlyUsd: 0, monthlyUsd: 100,
  breakdown: [], assumptions: [], pricingSource: 'aws-price-list-api', pricingTier: 'LIVE', confidence: 'estimate', ...o,
});

describe('assessLine', () => {
  test('a price from the official list that passes every check is verified', () => {
    expect(assessLine(line({}))).toEqual({ status: 'verified', notes: [], excludes: [] });
    expect(assessLine(line({ pricingTier: 'CACHED_LIVE' })).status).toBe('verified');
  });

  test('a built-in table price is an estimate and says so', () => {
    const q = assessLine(line({ pricingTier: 'FALLBACK_ESTIMATE', pricingSource: 'aws-static-rate-table' }));
    expect(q.status).toBe('estimate');
    expect(q.notes.join(' ')).toMatch(/Built-in estimate/);
  });

  test('a line with no usable price is unpriced, never zero-cost', () => {
    expect(assessLine(line({ confidence: 'unsupported', monthlyUsd: 0 })).status).toBe('unpriced');
    expect(assessLine(line({ pricingTier: 'UNAVAILABLE' })).status).toBe('unpriced');
  });

  test('the same meter line twice is flagged as a possible double count (the doubled Redis cache)', () => {
    const meter = 'Azure Redis Cache Standard / C2 / C2 Cache: $0.225 per Hour × 1 = $164.25/mo';
    const q = assessLine(line({ resourceType: 'azure_redis', provider: 'azure', monthlyUsd: 328.5, assumptions: [meter, meter, 'Region: eastus'] }));
    expect(q.status).toBe('check');
    expect(q.notes.join(' ')).toMatch(/twice/);
    expect(assessLine(line({ resourceType: 'azure_redis', provider: 'azure', monthlyUsd: 164.25, assumptions: [meter, 'Region: eastus'] })).status).toBe('verified');
  });

  test('an Azure database priced as a DTU tier is flagged as not the same size as the AWS instance', () => {
    const q = assessLine(line({ resourceType: 'azure_sql', provider: 'azure', assumptions: ['Database S4 list price: $9.678 per 1/Day = $294.37/mo'] }));
    expect(q.status).toBe('check');
    expect(q.notes.join(' ')).toMatch(/DTU/);
  });

  test('an implausibly high price is flagged', () => {
    expect(assessLine(line({ resourceType: 'azure_sql', provider: 'azure', monthlyUsd: 105_980 })).status).toBe('check');
  });

  test('a saved price past its refresh time is mentioned but still verified', () => {
    const q = assessLine(line({ pricingTier: 'CACHED_LIVE', pricingIsStale: true }));
    expect(q.status).toBe('verified');
    expect(q.notes.join(' ')).toMatch(/Refresh prices/);
  });
});

describe('usage charges a price leaves out', () => {
  test('are listed from the price\'s own assumptions, without the dollar rate', () => {
    const q = assessLine(line({ assumptions: ['Request-processing charges not included — $0.60 per million requests', 'Data transfer and request-volume charges not included', 'Region: us-east-1'] }));
    expect(q.excludes).toEqual(['Request-processing charges', 'Data transfer and request-volume charges']);
  });
  test('lose the trailing comma left by "..., not included here"', () => {
    expect(assessLine(line({ assumptions: ['Request-processing charges billed through the associated gateway, not included here'] })).excludes).toEqual(['Request-processing charges billed through the associated gateway']);
  });
  test('are empty when the price says nothing is left out', () => {
    expect(assessLine(line({ assumptions: ['Region: us-east-1'] })).excludes).toEqual([]);
  });
});

describe('assessResult', () => {
  test('counts and sums each group, and keys lines by resource id', () => {
    const { lines, summary } = assessResult([
      line({ resourceId: 'a', monthlyUsd: 10 }),
      line({ resourceId: 'b', monthlyUsd: 20, pricingTier: 'FALLBACK_ESTIMATE' }),
      line({ resourceId: 'c', monthlyUsd: 30, resourceType: 'azure_sql', provider: 'azure', assumptions: ['Database S1 list price'] }),
      line({ resourceId: 'd', monthlyUsd: 0, confidence: 'unsupported' }),
    ]);
    expect(Object.keys(lines)).toEqual(['a', 'b', 'c', 'd']);
    expect(summary).toEqual({ verified: 1, estimates: 1, check: 1, unpriced: 1, verifiedUsd: 10, estimateUsd: 20, checkUsd: 30 });
  });

  test('the oldest price time is the earliest valid one, or null when none is known', () => {
    expect(oldestPriceTime([line({ pricingRetrievedAt: '2026-10-07T10:00:00Z' }), line({ pricingRetrievedAt: '2026-10-06T10:00:00Z' }), line({})])).toBe('2026-10-06T10:00:00Z');
    expect(oldestPriceTime([line({ pricingRetrievedAt: 'garbage' }), line({})])).toBeNull();
  });
});

describe('saved prices are versioned', () => {
  test('every cache key carries the pricing version, so prices saved by older code are never served', () => {
    const key = new PricingCache().makeCacheKey({ provider: 'aws', resourceType: 'aws_ec2', region: 'us-east-1', configuration: { instanceType: 't3.micro' } });
    expect(key.startsWith(`v${PRICING_CACHE_VERSION}:aws:aws_ec2:`)).toBe(true);
  });
});

// ── Reference designs ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Each reference design lists the AWS resource types it contains and the Azure type every one must be priced as. */
const REFERENCE_DESIGNS: Record<string, [string, string][]> = {
  'highly available SaaS': [
    ['aws_route53', 'azure_dns'], ['aws_cloudfront', 'azure_front_door'], ['aws_waf', 'azure_waf'], ['aws_nat', 'azure_nat'], ['aws_alb', 'azure_app_gateway'],
    ['aws_rds', 'azure_sql'], ['aws_elasticache', 'azure_redis'], ['aws_cloudwatch', 'azure_monitor'],
  ],
  'web app with storage': [['aws_ec2', 'azure_vm'], ['aws_s3', 'azure_storage'], ['aws_alb', 'azure_app_gateway'], ['aws_rds', 'azure_sql'], ['aws_vpc', 'azure_vnet']],
  'serverless API': [['aws_lambda', 'azure_functions'], ['aws_dynamodb', 'azure_cosmos_db'], ['aws_cloudfront', 'azure_front_door'], ['aws_s3', 'azure_storage']],
};

describe.each(Object.entries(REFERENCE_DESIGNS))('reference design: %s', (_name, pairs) => {
  test('every resource is mapped to the same Azure service as when its price was checked by hand', () => {
    const resources = pairs.map(([type], i) => ({ id: `r${i}`, label: type, resourceType: type, provider: 'aws', configJson: '{}', region: 'us-east-1' }));
    const translated = CloudCostComparisonService.translateResources(resources, 'azure');
    expect(translated.map((r) => r.resourceType)).toEqual(pairs.map(([, azure]) => azure));
  });
});

const row = (o: Partial<AzureRetailPriceItem>): AzureRetailPriceItem => ({
  currencyCode: 'USD', tierMinimumUnits: 0, retailPrice: 0, unitPrice: 0, armRegionName: '', location: '', effectiveStartDate: '', meterId: '', meterName: '',
  productId: '', skuId: '', productName: '', skuName: '', serviceName: '', serviceId: '', serviceFamily: '', unitOfMeasure: '1 Hour', type: 'Consumption', ...o,
});

/** Saved Azure Retail Prices rows (October 2026), with the monthly price worked out by hand. */
const SAVED_ROWS = {
  azure_dns: {
    rows: [
      row({ serviceName: 'Azure DNS', productName: 'Azure DNS', skuName: 'Public', meterName: 'Public Zone', retailPrice: 0.5, unitOfMeasure: '1' }),
      row({ serviceName: 'Azure DNS', productName: 'Azure DNS', skuName: 'Public', meterName: 'Public Queries', retailPrice: 0.4, unitOfMeasure: '1M' }),
      row({ serviceName: 'Azure DNS', productName: 'Azure DNS', skuName: 'Private', meterName: 'Private Zone', retailPrice: 0.5, unitOfMeasure: '1' }),
    ],
    pick: ['Public Zone'], expectedMonthly: 0.5,
  },
  azure_redis: {
    rows: [
      row({ serviceName: 'Redis Cache', productName: 'Azure Redis Cache Standard', skuName: 'C2', meterName: 'C2 Cache', retailPrice: 0.225 }),
      row({ serviceName: 'Redis Cache', productName: 'Azure Redis Cache Standard', skuName: 'C2', meterName: 'C2 Cache', retailPrice: 0.225 }), // the price feed's repeated row
    ],
    pick: ['C2 Cache', 'C2 Cache'], expectedMonthly: 0.225 * 730,
  },
};

describe.each(Object.entries(SAVED_ROWS))('saved price rows: %s', (type, { rows, pick, expectedMonthly }) => {
  test('is priced at the hand-checked monthly amount', async () => {
    const ask: AskModel = async (_s, user) => {
      const lines = user.split('\n').filter((l) => /^\d+: /.test(l));
      const picks = pick.map((needle, n) => {
        const matches = lines.filter((l) => l.includes(needle));
        return { i: Number(matches[Math.min(n, matches.length - 1)]!.split(':')[0]), quantity: 1 };
      });
      return { picks };
    };
    const p = await pickAzureMeters({ resourceType: type, region: 'eastus', config: {}, rows, anchorMonthlyUsd: null, ask });
    expect(p!.monthlyPrice).toBeCloseTo(expectedMonthly, 2);
  });
});

test('a flat per-item price with no time unit is read as monthly', () => {
  expect(monthlyFromRetailItem({ retailPrice: 0.5, unitOfMeasure: '1' })).toBe(0.5);
  expect(monthlyFromRetailItem({ retailPrice: 0.4, unitOfMeasure: '1M' })).toBeNull();
});
