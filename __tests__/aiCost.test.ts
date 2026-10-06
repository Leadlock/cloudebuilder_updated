/**
 * AI cost features: the model chooses and explains, code prices. These tests use fake models and a fake price feed; the point of each is
 * that a wrong, invented or hostile model answer can never change what is shown as a price.
 */
import { findCostAnomalies } from '@/lib/cost/ai/plausibility';
import { pickAzureMeters, selectCandidates } from '@/lib/cost/ai/meterPicker';
import { translateResourcesWithAi, _clearEquivalentCache } from '@/lib/cost/ai/equivalents';
import { buildCostInsights, withoutFigures } from '@/lib/cost/ai/insights';
import { runCostComparison } from '@/lib/engines/comparison/runCostComparison';
import { AzurePricingProvider } from '@/lib/cloud/pricing/AzurePricingProvider';
import { classifyPricingSource } from '@/lib/cloud/pricing/tiers';
import type { AzureRetailPriceItem } from '@/lib/cloud/pricing/azureRetail';
import type { AskModel } from '@/lib/cost/ai/askModel';
import type { CostEstimationResult, CostLineItem } from '@/lib/engines/cost/types';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

const row = (o: Partial<AzureRetailPriceItem>): AzureRetailPriceItem => ({
  currencyCode: 'USD', tierMinimumUnits: 0, retailPrice: 0, unitPrice: 0, armRegionName: 'eastus', location: '', effectiveStartDate: '', meterId: '', meterName: '',
  productId: '', skuId: '', productName: '', skuName: '', serviceName: 'Redis Cache', serviceId: '', serviceFamily: '', unitOfMeasure: '1 Hour', type: 'Consumption', ...o,
});

const REDIS_ROWS = [
  row({ productName: 'Azure Redis Cache Basic', skuName: 'C1', meterName: 'C1 Cache', retailPrice: 0.055 }),
  row({ productName: 'Azure Redis Cache Standard', skuName: 'C1', meterName: 'C1 Cache', retailPrice: 0.138 }),
  row({ productName: 'Azure Redis Cache Standard', skuName: 'C1', meterName: 'C1 Cache Spot', retailPrice: 0.01 }),
  row({ productName: 'Azure Redis Cache Premium', skuName: 'P1', meterName: 'P1 Cache', retailPrice: 0.5 }),
  row({ productName: 'Azure Redis Cache Standard', skuName: 'C1', meterName: 'Data Transfer', unitOfMeasure: '1 GB', retailPrice: 0.087 }),
];

/** A fake model that picks the listed row whose text contains `needle` (the prompt numbers the rows). */
const pickerFor = (needle: string, quantity = 1, extra: Record<string, unknown> = {}): AskModel => async (_s, user) => {
  const line = user.split('\n').find((l) => /^\d+: /.test(l) && l.includes(needle));
  return { picks: line ? [{ i: Number(line.split(':')[0]), quantity, reason: 'fits', ...extra }] : [] };
};

const redisArgs = { resourceType: 'azure_redis', region: 'eastus', config: { sku: 'Standard', capacity: 1 }, rows: REDIS_ROWS, anchorMonthlyUsd: null as number | null };

describe('plausibility', () => {
  const line = (resourceType: string, monthlyUsd: number, confidence = 'estimate') => ({ resourceId: 'r', resourceLabel: 'R', resourceType, monthlyUsd, confidence });
  test('flags the $105,980 SQL database and not a normal one', () => {
    expect(findCostAnomalies([line('azure_sql', 105_980.2)])).toHaveLength(1);
    expect(findCostAnomalies([line('azure_sql', 29.4)])).toEqual([]);
  });
  test('unpriced lines and unknown types with sane values are not flagged; negative or NaN is', () => {
    expect(findCostAnomalies([line('azure_sql', 0, 'unsupported'), line('aws_made_up', 500)])).toEqual([]);
    expect(findCostAnomalies([line('aws_ec2', -1), line('aws_ec2', NaN)])).toHaveLength(2);
  });
});

describe('meter picker: the model chooses rows, code reads the price', () => {
  test('prices from the chosen row, converted by its unit', async () => {
    const p = await pickAzureMeters({ ...redisArgs, ask: pickerFor('Standard | C1 | C1 Cache |') });
    expect(p!.monthlyPrice).toBeCloseTo(0.138 * 730, 4);
    expect(p!.source).toBe('azure-retail-api-ai-matched');
    expect(classifyPricingSource(p!.source)).toBe('LIVE');
    expect(p!.assumptions.join(' ')).toMatch(/chosen by AI/);
  });

  test('a price the model states is ignored', async () => {
    const p = await pickAzureMeters({ ...redisArgs, ask: pickerFor('Standard | C1 | C1 Cache |', 1, { price: 1, monthlyUsd: 1 }) });
    expect(p!.monthlyPrice).toBeCloseTo(100.74, 2);
  });

  test('Spot and other excluded rows are never offered to the model', () => {
    const shown = selectCandidates(REDIS_ROWS, { sku: 'Standard' }).map((r) => r.meterName);
    expect(shown).not.toContain('C1 Cache Spot');
  });

  test('rows with the settings\' own tokens come first', () => {
    expect(selectCandidates(REDIS_ROWS, { sku: 'Premium' })[0]!.skuName).toBe('P1');
  });

  test.each([
    ['an index that was never offered', async () => ({ picks: [{ i: 99, quantity: 1 }] })],
    ['a negative index', async () => ({ picks: [{ i: -1, quantity: 1 }] })],
    ['a fractional index', async () => ({ picks: [{ i: 0.5, quantity: 1 }] })],
    ['an absurd quantity', async () => ({ picks: [{ i: 0, quantity: 1e9 }] })],
    ['a zero quantity', async () => ({ picks: [{ i: 0, quantity: 0 }] })],
    ['the same row twice', async () => ({ picks: [{ i: 0, quantity: 1 }, { i: 0, quantity: 1 }] })],
    ['too many rows', async () => ({ picks: [0, 1, 2, 3, 4].map((i) => ({ i, quantity: 1 })) })],
    ['no picks', async () => ({ picks: [] })],
    ['garbage', async () => ({ picks: 'cheap please' as unknown })],
    ['no answer', async () => undefined],
  ] as [string, AskModel][])('is rejected: %s', async (_name, ask) => {
    expect(await pickAzureMeters({ ...redisArgs, ask })).toBeNull();
  });

  test('two rows that are the same meter are one charge, not two', async () => {
    const twin = row({ productName: 'Azure Redis Cache Standard', skuName: 'C2', meterName: 'C2 Cache', retailPrice: 0.225 });
    const ask: AskModel = async () => ({ picks: [{ i: 0, quantity: 1 }, { i: 1, quantity: 1 }] });
    const p = await pickAzureMeters({ ...redisArgs, rows: [twin, { ...twin }], ask });
    expect(p!.monthlyPrice).toBeCloseTo(0.225 * 730, 4);
  });

  test('a total above the plausible maximum for the type is rejected', async () => {
    const rows = [row({ productName: 'x', skuName: 'C1', meterName: 'C1 Cache', retailPrice: 500 })]; // $365,000/mo
    expect(await pickAzureMeters({ ...redisArgs, rows, ask: async () => ({ picks: [{ i: 0, quantity: 1 }] }) })).toBeNull();
  });

  test('a total far from the built-in estimate is rejected, a close one accepted', async () => {
    const ask = pickerFor('Standard | C1 | C1 Cache |');
    expect(await pickAzureMeters({ ...redisArgs, anchorMonthlyUsd: 5, ask })).toBeNull();      // $100.74 vs $5: 20x
    expect(await pickAzureMeters({ ...redisArgs, anchorMonthlyUsd: 90, ask })).not.toBeNull(); // within 8x
  });

  test('per-GB rows are priced by usage, never by hours', async () => {
    const p = await pickAzureMeters({ ...redisArgs, config: { usage: 'data transfer' }, ask: pickerFor('Data Transfer', 100) });
    expect(p!.monthlyPrice).toBeCloseTo(0.087 * 100, 4); // not 0.087 * 730 * 100
  });
});

describe('Azure provider with AI meter matching', () => {
  const guarded = global.fetch;
  afterEach(() => { global.fetch = guarded; });
  const serve = (items: AzureRetailPriceItem[]) => { global.fetch = jest.fn(() => Promise.resolve(new Response(JSON.stringify({ Items: items, Count: items.length }), { status: 200 }))) as unknown as typeof fetch; };
  const q = { provider: 'azure' as const, resourceType: 'azure_redis', region: 'eastus', configuration: { sku: 'Standard', capacity: 1 } };

  test('prices Redis from the AI-chosen official row', async () => {
    serve(REDIS_ROWS);
    const p = await new AzurePricingProvider({ aiMeterMatching: true, ask: pickerFor('Standard | C1 | C1 Cache |') }).getPrice(q);
    expect(p!.monthlyPrice).toBeCloseTo(100.74, 2);
  });

  test('is off by default under test, so unit tests never reach a model', async () => {
    serve(REDIS_ROWS);
    expect(await new AzurePricingProvider().getPrice(q)).toBeNull();
  });

  test('a model that throws leaves the resource to the built-in table (null)', async () => {
    serve(REDIS_ROWS);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await new AzurePricingProvider({ aiMeterMatching: true, ask: async () => { throw new Error('model down'); } }).getPrice(q)).toBeNull();
  });
});

describe('AI-proposed equivalents', () => {
  beforeEach(() => _clearEquivalentCache());
  const res = (id: string, resourceType: string): DbArchitectureResource => ({ id, label: id, resourceType, provider: 'aws', configJson: JSON.stringify({ instanceType: 't3.large' }), region: 'us-east-1' } as unknown as DbArchitectureResource);

  test('a type the fixed table does not cover is matched to a real catalogue type and reported', async () => {
    const ask: AskModel = async () => ({ matches: [{ resourceType: 'aws_eks', to: 'azure_aks', reason: 'managed Kubernetes' }] });
    const r = await translateResourcesWithAi([res('k', 'aws_eks'), res('e', 'aws_ec2')], 'azure', ask);
    expect(r.resources[0]).toMatchObject({ resourceType: 'azure_aks', provider: 'azure', configJson: '{}' });
    expect(r.resources[1]!.resourceType).toBe('azure_vm'); // the fixed table still handles EC2
    expect(r.matches).toEqual([{ resourceId: 'k', from: 'aws_eks', to: 'azure_aks', reason: 'managed Kubernetes' }]);
  });

  test('an invented or wrong-cloud type is ignored', async () => {
    const ask: AskModel = async () => ({ matches: [{ resourceType: 'aws_eks', to: 'azure_magic_cluster', reason: 'x' }, { resourceType: 'aws_sqs', to: 'aws_sqs', reason: 'x' }] });
    const r = await translateResourcesWithAi([res('k', 'aws_eks'), res('q', 'aws_sqs')], 'azure', ask);
    expect(r.matches).toEqual([]);
    expect(r.resources.map((x) => x.resourceType)).toEqual(['aws_eks', 'aws_sqs']); // left as-is: priced as unsupported, never invented
  });

  test('Route 53 is never matched to a load balancer, even when the model offers it', async () => {
    const ask: AskModel = async () => ({ matches: [{ resourceType: 'aws_route53', to: 'azure_lb', reason: 'both route traffic' }] });
    const r = await translateResourcesWithAi([res('d', 'aws_route53')], 'azure', ask);
    expect(r.matches).toEqual([]);
    expect(r.resources[0]!.resourceType).toBe('aws_route53');
  });

  test('free networking types are not sent to the model', async () => {
    const ask = jest.fn(async () => ({ matches: [] }));
    await translateResourcesWithAi([res('v', 'aws_vpc'), res('s', 'aws_sg'), res('e', 'aws_ec2')], 'azure', ask as unknown as AskModel);
    expect(ask).not.toHaveBeenCalled();
  });

  test('a model failure leaves everything unmatched without throwing', async () => {
    const r = await translateResourcesWithAi([res('k', 'aws_eks')], 'azure', async () => { throw new Error('down'); });
    expect(r.matches).toEqual([]);
  });
});

describe('insights', () => {
  const resource = { id: 'ec2', label: 'Web server', resourceType: 'aws_ec2', provider: 'aws', configJson: JSON.stringify({ instanceType: 't3.large' }), region: 'us-east-1' } as unknown as DbArchitectureResource;
  const line = (resourceId: string, label: string, resourceType: string, monthlyUsd: number): CostLineItem => ({
    resourceId, resourceLabel: label, resourceType, provider: 'aws', region: 'us-east-1', hourlyUsd: monthlyUsd / 730, monthlyUsd, breakdown: [], assumptions: [], pricingSource: 'x', pricingTier: 'LIVE', confidence: 'estimate',
  });
  const result = (items: CostLineItem[]): CostEstimationResult => ({
    items, totalMonthlyUsd: items.reduce((s, i) => s + i.monthlyUsd, 0), totalHourlyUsd: 0, currency: 'USD', assumptions: [], pricingSource: 'x', pricingTier: 'LIVE',
    pricingTierCounts: { LIVE: items.length, CACHED_LIVE: 0, FALLBACK_ESTIMATE: 0, UNAVAILABLE: 0 }, exchangeRateTier: null, confidence: 'estimate',
  });
  // Re-pricing: t3.large = $80, t3.small = $20, anything else $80.
  const estimator = { estimateAsync: jest.fn(async (input: { resources: DbArchitectureResource[] }) => {
    const r = input.resources[0]!; const t = JSON.parse(r.configJson).instanceType;
    return result([line(r.id, r.label, r.resourceType, t === 't3.small' ? 20 : 80)]);
  }) };
  const base = {
    currentProvider: 'aws', targetProvider: 'azure', current: result([line('ec2', 'Web server', 'aws_ec2', 80), line('free', 'Nothing', 'aws_vpc', 0)]),
    translated: result([line('ec2', 'Web server', 'azure_vm', 60)]), resources: [resource],
    estimateInput: { architectureId: 'a', projectId: 'p', targetCurrency: 'USD' }, estimator,
  };

  test('a valid suggestion is re-priced by the estimator; the saving is the estimator\'s, not the model\'s', async () => {
    const ask: AskModel = async () => ({
      summary: 'The compute dominates the bill. Azure is a bit cheaper here.',
      why: [{ resourceId: 'ec2', text: 'It runs around the clock on a mid-size instance.' }],
      suggestions: [{ resourceId: 'ec2', field: 'instanceType', value: 't3.small', rationale: 'Light traffic does not need a large instance.', saving: 9999, monthlyUsd: 1 }],
    });
    const i = await buildCostInsights({ ...base, ask });
    expect(i.suggestions).toHaveLength(1);
    expect(i.suggestions[0]).toMatchObject({ resourceId: 'ec2', field: 'instanceType', from: 't3.large', to: 't3.small', currentMonthlyUsd: 80, newMonthlyUsd: 20, savingUsd: 60 });
    expect(i.facts.currentMonthlyUsd).toBe(80);
    expect(i.facts.targetMonthlyUsd).toBe(60);
    expect(i.facts.differencePct).toBeCloseTo(-25, 6);
    expect(i.facts.topDrivers[0]).toMatchObject({ resourceId: 'ec2', sharePct: 100, why: 'It runs around the clock on a mid-size instance.' });
  });

  test.each([
    ['an unknown resource', { resourceId: 'ghost', field: 'instanceType', value: 't3.small' }],
    ['a setting that is not a dropdown of the resource', { resourceId: 'ec2', field: 'rootPassword', value: 'x' }],
    ['an option that does not exist', { resourceId: 'ec2', field: 'instanceType', value: 'x1e.32xlarge-free' }],
    ['the value already set', { resourceId: 'ec2', field: 'instanceType', value: 't3.large' }],
    ['a zero-cost resource', { resourceId: 'free', field: 'cidr', value: '10.0.0.0/8' }],
  ])('a suggestion naming %s is dropped', async (_n, suggestion) => {
    const i = await buildCostInsights({ ...base, ask: async () => ({ suggestions: [suggestion] }) });
    expect(i.suggestions).toEqual([]);
  });

  test('a "saving" that does not reduce the re-priced cost is dropped', async () => {
    const i = await buildCostInsights({ ...base, ask: async () => ({ suggestions: [{ resourceId: 'ec2', field: 'instanceType', value: 'm5.large', rationale: 'x' }] }) });
    expect(i.suggestions).toEqual([]); // the fake estimator prices m5.large at $80, the same as now
  });

  test('sentences with an amount or percentage are removed from the model\'s words', async () => {
    const ask: AskModel = async () => ({
      summary: 'Compute dominates. It costs $80 a month. About 40% is storage. Azure is cheaper.',
      why: [{ resourceId: 'ec2', text: 'Saves 30 percent if downsized.' }],
    });
    const i = await buildCostInsights({ ...base, ask });
    expect(i.summary).toBe('Compute dominates.'); // "Azure is cheaper" is a verdict: the app shows that from the totals
    expect(i.facts.topDrivers[0]!.why).toBe('');
  });

  test('a model failure still returns the code-computed facts', async () => {
    const i = await buildCostInsights({ ...base, ask: async () => { throw new Error('down'); } });
    expect(i.summary).toBe('');
    expect(i.suggestions).toEqual([]);
    expect(i.facts.currentMonthlyUsd).toBe(80);
  });
});

describe('withoutFigures', () => {
  test.each([
    ['Costs $5 per month.', ''], ['It is 20% cheaper.', ''], ['Roughly 1500 requests.', ''], ['Price is €3.', ''],
    ['The database dominates. Consider a smaller tier.', 'The database dominates. Consider a smaller tier.'],
    ['Use 2 nodes.', 'Use 2 nodes.'],
  ])('%s', (input, expected) => expect(withoutFigures(input, 500)).toBe(expected));
  test('non-strings give an empty string', () => { expect(withoutFigures(42, 10)).toBe(''); expect(withoutFigures(undefined, 10)).toBe(''); });
});

describe('runCostComparison', () => {
  test('prices both clouds, flags an implausible line, and reports AI matches', async () => {
    const calls: DbArchitectureResource[][] = [];
    const estimator = { estimateAsync: jest.fn(async (input: { resources: DbArchitectureResource[] }) => {
      calls.push(input.resources);
      const azure = input.resources[0]!.provider === 'azure';
      return result2([{ resourceId: input.resources[0]!.id, resourceLabel: 'DB', resourceType: azure ? 'azure_sql' : 'aws_rds', monthlyUsd: azure ? 105_980 : 60 }]);
    }) };
    const resources = [{ id: 'db', label: 'DB', resourceType: 'aws_rds', provider: 'aws', configJson: '{}', region: 'us-east-1' }] as unknown as DbArchitectureResource[];
    const run = await runCostComparison({ architectureId: 'a', projectId: 'p', resources, projectRegion: 'us-east-1', targetCurrency: 'USD', aiMatching: false, estimator });
    expect(run.targetProvider).toBe('azure');
    expect(calls[1]![0]!.resourceType).toBe('azure_sql');
    expect(run.anomalies.translated).toHaveLength(1);
    expect(run.anomalies.current).toEqual([]);
    expect(run.aiMatches).toEqual([]);
  });
});

function result2(items: Partial<CostLineItem>[]): CostEstimationResult {
  const full = items.map((i) => ({ hourlyUsd: 0, region: 'r', provider: 'x', breakdown: [], assumptions: [], pricingSource: 'x', confidence: 'estimate', ...i })) as CostLineItem[];
  return { items: full, totalMonthlyUsd: full.reduce((s, i) => s + i.monthlyUsd, 0), totalHourlyUsd: 0, currency: 'USD', assumptions: [], pricingSource: 'x', pricingTier: 'LIVE',
    pricingTierCounts: { LIVE: full.length, CACHED_LIVE: 0, FALLBACK_ESTIMATE: 0, UNAVAILABLE: 0 }, exchangeRateTier: null, confidence: 'estimate' };
}
