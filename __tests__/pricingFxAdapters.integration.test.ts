/**
 * Integration tests for the pricing and FX adapters against recorded official response
 * shapes (see __tests__/fixtures/pricing/README.md). No network is used: global.fetch is
 * replaced per test. Covers 200, 403, 429, timeout, network failure, malformed JSON,
 * empty responses and stale-cache behaviour, and the LIVE / CACHED_LIVE /
 * FALLBACK_ESTIMATE / UNAVAILABLE tiering that the UI relies on.
 */
import fs from 'fs';
import path from 'path';
import { AzurePricingProvider } from '@/lib/cloud/pricing/AzurePricingProvider';
import { AwsPricingProvider } from '@/lib/cloud/pricing/AwsPricingProvider';
import { CloudProviderPricingService } from '@/lib/cloud/pricing/CloudProviderPricingService';
import { PricingCache } from '@/lib/cloud/pricing/PricingCache';
import { classifyPricingSource, classifyRate, weakestTier } from '@/lib/cloud/pricing/tiers';
import type { ICloudPricingProvider, NormalizedPrice, PriceQuery } from '@/lib/cloud/pricing/types';
import { OpenErApiProvider } from '@/lib/currency/providers/OpenErApiProvider';
import { FrankfurterProvider } from '@/lib/currency/providers/FrankfurterProvider';
import { CurrencyExchangeRateService } from '@/lib/currency/CurrencyExchangeRateService';
import { CurrencyExchangeRateCache } from '@/lib/currency/CurrencyExchangeRateCache';
import { CostEstimator } from '@/lib/engines/cost/CostEstimator';
import { costService } from '@/lib/services/CostService';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

const FIX = (f: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pricing', f), 'utf8'));
const guardedFetch = global.fetch;
afterEach(() => { global.fetch = guardedFetch; jest.useRealTimers(); });

type Behaviour = 'ok' | '403' | '429' | 'network' | 'malformed' | 'empty' | 'timeout';
function mockFetch(behaviour: Behaviour, body?: unknown) {
  const fn = jest.fn((_url: string, init?: RequestInit) => {
    switch (behaviour) {
      case 'ok': return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      case '403': return Promise.resolve(new Response('Forbidden', { status: 403 }));
      case '429': return Promise.resolve(new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '30' } }));
      case 'network': return Promise.reject(new TypeError('fetch failed'));
      case 'malformed': return Promise.resolve(new Response('<html>gateway error</html>', { status: 200 }));
      case 'empty': return Promise.resolve(new Response('', { status: 200 }));
      case 'timeout':
        // Never resolves on its own: only the adapter's AbortController can end it.
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
        });
    }
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const silence = () => jest.spyOn(console, 'warn').mockImplementation(() => {});

// ─── Tier classification ─────────────────────────────────────────────────────

describe('Pricing tiers', () => {
  test('only official API sources classify as LIVE; unknown sources are never promoted', () => {
    expect(classifyPricingSource('aws-price-list-api')).toBe('LIVE');
    expect(classifyPricingSource('azure-retail-api')).toBe('LIVE');
    expect(classifyPricingSource('aws-static-rate-table')).toBe('FALLBACK_ESTIMATE');
    expect(classifyPricingSource('azure-static-estimate')).toBe('FALLBACK_ESTIMATE');
    expect(classifyPricingSource('aws-ec2-ondemand-list-price')).toBe('FALLBACK_ESTIMATE');
    expect(classifyPricingSource('something-new')).toBe('FALLBACK_ESTIMATE');
    expect(classifyPricingSource('unavailable')).toBe('UNAVAILABLE');
    expect(classifyPricingSource(undefined)).toBe('UNAVAILABLE');
  });

  test('exchange-rate tiers', () => {
    expect(classifyRate(null)).toBe('UNAVAILABLE');
    expect(classifyRate({ source: 'identity' })).toBe('LIVE');
    expect(classifyRate({ source: 'open-er-api' })).toBe('LIVE');
    expect(classifyRate({ source: 'open-er-api', isCached: true })).toBe('CACHED_LIVE');
    expect(classifyRate({ source: 'open-er-api (cached stale from x)', isCached: true, isStale: true })).toBe('CACHED_LIVE');
  });

  test('a total is only as strong as its weakest item', () => {
    expect(weakestTier(['LIVE', 'CACHED_LIVE'])).toBe('CACHED_LIVE');
    expect(weakestTier(['LIVE', 'FALLBACK_ESTIMATE'])).toBe('FALLBACK_ESTIMATE');
    expect(weakestTier([])).toBeNull();
  });
});

// ─── Azure Retail Prices API adapter ─────────────────────────────────────────

describe('AzurePricingProvider against the Retail Prices API response shape', () => {
  const vmQuery: PriceQuery = { provider: 'azure', resourceType: 'azure_vm', region: 'eastus', configuration: { size: 'Standard_B2s', osDiskGb: 128 } };

  test('200: picks the Linux, non-spot meter for the requested SKU and labels it live', async () => {
    const f = mockFetch('ok', FIX('azure-retail-vm-b2s-eastus.json'));
    const p = await new AzurePricingProvider().getPrice(vmQuery);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toContain('prices.azure.com/api/retail/prices');
    expect(p!.unitPrice).toBe(0.0416); // not the spot (0.0166) or Windows (0.0496) meter
    expect(p!.source).toBe('azure-retail-api');
    expect(classifyPricingSource(p!.source)).toBe('LIVE');
  });

  test('200 with no matching meter: a baseline estimate, never labelled live', async () => {
    silence();
    mockFetch('ok', { Items: [], Count: 0, NextPageLink: null });
    const p = await new AzurePricingProvider().getPrice(vmQuery);
    expect(p!.source).toBe('azure-static-estimate');
    expect(p!.assumptions.join(' ')).not.toMatch(/Live price/);
  });

  test.each<Behaviour>(['403', '429', 'network', 'malformed', 'empty'])('%s: VM price is not fabricated (provider returns null)', async (b) => {
    silence();
    mockFetch(b);
    expect(await new AzurePricingProvider().getPrice(vmQuery)).toBeNull();
  });

  test('timeout: the request is aborted by the adapter and no price is fabricated', async () => {
    silence();
    jest.useFakeTimers();
    mockFetch('timeout');
    const pending = new AzurePricingProvider().getPrice(vmQuery);
    await jest.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
  });

  // With no usable live meter the adapter returns null (it never guesses a meter); CostEstimator then prices the resource from the
  // static table in lib/engines/cost/azurePricing.ts, which is labelled a fallback estimate.
  test.each<Behaviour>(['403', '429', 'network', 'malformed'])('%s: SQL, storage, LB and App Gateway return null so the static table is used', async (b) => {
    silence();
    mockFetch(b);
    const prov = new AzurePricingProvider();
    for (const [resourceType, configuration] of [
      ['azure_sql', { tier: 'S0', maxSizeGb: 250 }], ['azure_storage', { sku: 'Standard_LRS' }],
      ['azure_lb', { sku: 'Standard' }], ['azure_app_gateway', {}],
    ] as const) {
      expect(await prov.getPrice({ provider: 'azure', resourceType, region: 'eastus', configuration })).toBeNull();
    }
  });

  test('Functions, AKS and Key Vault are never queried live and are never labelled live', async () => {
    const f = mockFetch('ok', { Items: [] });
    const prov = new AzurePricingProvider();
    for (const resourceType of ['azure_functions', 'azure_aks', 'azure_key_vault']) {
      const p = await prov.getPrice({ provider: 'azure', resourceType, region: 'eastus', configuration: {} });
      expect(classifyPricingSource(p!.source)).toBe('FALLBACK_ESTIMATE');
    }
    expect(f).not.toHaveBeenCalled();
  });
});

// ─── AWS adapter without credentials ─────────────────────────────────────────

describe('AwsPricingProvider without Price List API credentials', () => {
  test('uses the static rate table and says so', async () => {
    const saved = { ...process.env };
    delete process.env['AWS_PRICING_ACCESS_KEY_ID']; delete process.env['AWS_PRICING_SECRET_ACCESS_KEY'];
    try {
      const p = await new AwsPricingProvider().getPrice({ provider: 'aws', resourceType: 'aws_ec2', region: 'us-east-1', configuration: { instanceType: 't3.micro' } });
      expect(p!.source).toBe('aws-static-rate-table');
      expect(classifyPricingSource(p!.source)).toBe('FALLBACK_ESTIMATE');
    } finally { process.env = saved; }
  });
});

// ─── CloudProviderPricingService: caching and tiers ──────────────────────────

class MemCache extends PricingCache {
  // Avoid touching the on-disk cache in tests.
  constructor() { super(); this.clear(); }
}

function fakeProvider(results: Array<NormalizedPrice | null | 'throw'>): ICloudPricingProvider & { calls: number } {
  const obj = {
    name: 'fake', provider: 'aws' as const, calls: 0,
    async getPrice(q: PriceQuery) {
      const r = results[Math.min(obj.calls, results.length - 1)]; obj.calls += 1;
      if (r === 'throw') throw new Error('boom');
      return r ? { ...r, region: q.region } : null;
    },
  };
  return obj;
}
const price = (source: string, monthly = 30): NormalizedPrice => ({
  provider: 'aws', service: 'AmazonEC2', resourceType: 'aws_ec2', region: 'us-east-1', sku: 't3.micro', pricingModel: 'on-demand',
  unit: '1 Hour', unitPrice: monthly / 730, monthlyPrice: monthly, currency: 'USD', description: 'x', source,
  retrievedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), assumptions: [],
});
const q: PriceQuery = { provider: 'aws', resourceType: 'aws_ec2', region: 'us-east-1', configuration: { instanceType: 't3.micro' } };

describe('CloudProviderPricingService tiers', () => {
  test('live → LIVE, then served from cache as CACHED_LIVE', async () => {
    const svc = new CloudProviderPricingService(new MemCache(), [fakeProvider([price('aws-price-list-api')])]);
    expect((await svc.getPrice(q)).tier).toBe('LIVE');
    const again = await svc.getPrice(q);
    expect(again.tier).toBe('CACHED_LIVE');
    expect(again.isStale).toBe(false);
  });

  test('fallback estimates are never cached (so they can never be served as "cached live")', async () => {
    const prov = fakeProvider([price('aws-static-rate-table'), price('aws-price-list-api')]);
    const svc = new CloudProviderPricingService(new MemCache(), [prov]);
    expect((await svc.getPrice(q)).tier).toBe('FALLBACK_ESTIMATE');
    expect((await svc.getPrice(q)).tier).toBe('LIVE'); // provider queried again
    expect(prov.calls).toBe(2);
  });

  test('expired live price is preferred over a fallback, and flagged stale', async () => {
    const cache = new MemCache();
    const svc = new CloudProviderPricingService(cache, [fakeProvider(['throw'])]);
    cache.set(cache.makeCacheKey(q), { ...price('aws-price-list-api'), retrievedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z' });
    silence();
    const p = await svc.getPrice(q);
    expect(p.tier).toBe('CACHED_LIVE');
    expect(p.isStale).toBe(true);
  });

  test('nothing available → UNAVAILABLE with zero cost, never a fabricated figure', async () => {
    silence();
    const p = await new CloudProviderPricingService(new MemCache(), [fakeProvider([null])]).getPrice(q);
    expect(p.tier).toBe('UNAVAILABLE');
    expect(p.monthlyPrice).toBe(0);
  });
});

// ─── FX adapters ─────────────────────────────────────────────────────────────

describe('Exchange-rate adapters against official response shapes', () => {
  test('open.er-api 200', async () => {
    mockFetch('ok', FIX('open-er-api-usd.json'));
    const r = await new OpenErApiProvider().getRate('USD', 'INR');
    expect(r).toMatchObject({ rate: 85, source: 'open-er-api', fromCurrency: 'USD', toCurrency: 'INR' });
    expect(new Date(r!.expiresAt).toISOString()).toBe('2026-09-24T00:00:01.000Z');
  });

  test('Frankfurter 200', async () => {
    mockFetch('ok', FIX('frankfurter-usd-eur.json'));
    expect(await new FrankfurterProvider().getRate('USD', 'EUR')).toMatchObject({ rate: 0.91, source: 'frankfurter-ecb' });
  });

  test.each<Behaviour>(['403', '429', 'network', 'malformed', 'empty'])('%s: both providers return null (no invented rate)', async (b) => {
    silence();
    mockFetch(b);
    expect(await new OpenErApiProvider().getRate('USD', 'EUR')).toBeNull();
    expect(await new FrankfurterProvider().getRate('USD', 'EUR')).toBeNull();
  });

  test('open.er-api "result: error" payload returns null', async () => {
    mockFetch('ok', { result: 'error', 'error-type': 'unsupported-code' });
    expect(await new OpenErApiProvider().getRate('USD', 'EUR')).toBeNull();
  });

  test('timeout: requests are aborted after 8 s', async () => {
    silence();
    jest.useFakeTimers();
    mockFetch('timeout');
    const pending = new OpenErApiProvider().getRate('USD', 'EUR');
    await jest.advanceTimersByTimeAsync(8000);
    expect(await pending).toBeNull();
  });

  test('service: first provider 403 → second provider answers (LIVE)', async () => {
    silence();
    global.fetch = jest.fn((url: string) => url.includes('er-api')
      ? Promise.resolve(new Response('Forbidden', { status: 403 }))
      : Promise.resolve(new Response(JSON.stringify(FIX('frankfurter-usd-eur.json')), { status: 200 }))) as unknown as typeof fetch;
    const svc = new CurrencyExchangeRateService(new CurrencyExchangeRateCache(1000, false), [new OpenErApiProvider(), new FrankfurterProvider()]);
    const r = await svc.getExchangeRate({ from: 'USD', to: 'EUR' });
    expect(r!.source).toBe('frankfurter-ecb');
    expect(classifyRate(r)).toBe('LIVE');
  });

  test('service: all providers down + stale cache → CACHED_LIVE (stale), never LIVE', async () => {
    silence();
    const cache = new CurrencyExchangeRateCache(1, false);
    await cache.set({ fromCurrency: 'USD', toCurrency: 'EUR', rate: 0.9, source: 'open-er-api', retrievedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z' });
    mockFetch('network');
    const r = await new CurrencyExchangeRateService(cache, [new OpenErApiProvider(), new FrankfurterProvider()]).getExchangeRate({ from: 'USD', to: 'EUR' });
    expect(r!.isStale).toBe(true);
    expect(classifyRate(r)).toBe('CACHED_LIVE');
  });

  test('service: all providers down, no cache → null (UNAVAILABLE)', async () => {
    silence();
    mockFetch('403');
    const r = await new CurrencyExchangeRateService(new CurrencyExchangeRateCache(1000, false), [new OpenErApiProvider(), new FrankfurterProvider()]).getExchangeRate({ from: 'USD', to: 'EUR' });
    expect(classifyRate(r)).toBe('UNAVAILABLE');
  });
});

// ─── CostEstimator end-to-end tiers ──────────────────────────────────────────

const res = (id: string, resourceType: string, provider: string, config: object, region: string): DbArchitectureResource => ({
  id, resourceType, provider, label: id, positionX: 0, positionY: 0, configJson: JSON.stringify(config), region, groupId: null, locked: false, architectureId: 'a',
});

describe('CostEstimator tiers and currency honesty', () => {
  test('fallback figures are labelled as such in items, totals and assumptions', async () => {
    silence();
    const est = new CostEstimator({
      pricing: new CloudProviderPricingService(new MemCache(), [fakeProvider([null])]),
      currency: { getExchangeRate: async () => null },
    });
    const r = await est.estimateAsync({ architectureId: 'a', projectId: 'p', resources: [res('ec2', 'aws_ec2', 'aws', { instanceType: 't3.micro' }, 'us-east-1')], targetCurrency: 'EUR' }, 'REAL');
    expect(r.items[0].pricingTier).toBe('FALLBACK_ESTIMATE');
    expect(r.pricingTier).toBe('FALLBACK_ESTIMATE');
    expect(r.assumptions.join(' ')).toMatch(/fallback estimates/);
    expect(r.assumptions.join(' ')).not.toMatch(/All prices are official/);
    // FX unavailable → stays USD, conversion marked unavailable
    expect(r.currency).toBe('USD');
    expect(r.exchangeRateTier).toBe('UNAVAILABLE');
  });

  test('live price + live rate → LIVE throughout', async () => {
    const est = new CostEstimator({
      pricing: new CloudProviderPricingService(new MemCache(), [fakeProvider([price('aws-price-list-api', 73)])]),
      currency: { getExchangeRate: async () => ({ fromCurrency: 'USD', toCurrency: 'EUR', rate: 0.9, source: 'open-er-api', retrievedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), isCached: false, isStale: false }) },
    });
    const r = await est.estimateAsync({ architectureId: 'a', projectId: 'p', resources: [res('ec2', 'aws_ec2', 'aws', { instanceType: 't3.micro' }, 'us-east-1')], targetCurrency: 'EUR' }, 'REAL');
    expect(r.pricingTier).toBe('LIVE');
    expect(r.exchangeRateTier).toBe('LIVE');
    expect(r.totalMonthlyConverted).toBeCloseTo(73 * 0.9, 5);
    expect(r.assumptions[1]).toMatch(/All prices are official/);
  });

  test('offline UI fallback never invents an exchange rate', async () => {
    const items = await costService.calculateCosts([
      { id: 'n1', type: 'cloudNode', resourceType: 'aws_ec2', provider: 'aws', label: 'EC2', position: { x: 0, y: 0 }, config: { instanceType: 't3.micro' } },
    ] as never, 'INR');
    expect(items[0].currency).toBe('USD');
    expect(items[0].exchangeRate).toBeUndefined();
    expect(items[0].exchangeRateTier).toBe('UNAVAILABLE');
    expect(items[0].pricingTier).toBe('FALLBACK_ESTIMATE');
  });

  test('resources with no direct charge are not reported as "price unavailable"; layout boundaries are not priced', async () => {
    silence();
    const est = new CostEstimator({ pricing: new CloudProviderPricingService(new MemCache(), [fakeProvider([null])]), currency: { getExchangeRate: async () => null } });
    const r = await est.estimateAsync({ architectureId: 'a', projectId: 'p', resources: [
      res('nacl', 'aws_nacl', 'aws', {}, 'us-east-1'), res('b1', 'aws_cloud_boundary', 'aws', {}, 'us-east-1'), res('b2', 'azure_cloud_boundary', 'azure', {}, 'eastus'),
    ] }, 'REAL');
    expect(r.items).toEqual([]);
  });

  test('an Auto Scaling group is priced as its instances, from the live EC2 price when there is one and the built-in table when there is not', async () => {
    silence();
    const asg = res('asg', 'aws_auto_scaling', 'aws', { instanceType: 't3.medium', desiredCapacity: 3 }, 'us-east-1');
    // Built-in table: the live lookup finds nothing, so the group falls back to 3 x the t3.medium table price.
    const offline = new CostEstimator({ pricing: new CloudProviderPricingService(new MemCache(), [fakeProvider([null])]), currency: { getExchangeRate: async () => null } });
    const o = await offline.estimateAsync({ architectureId: 'a', projectId: 'p', resources: [asg] }, 'REAL');
    expect(o.items).toHaveLength(1);
    expect(o.items[0].monthlyUsd).toBeGreaterThan(90); // 3 x ($30.37 compute + EBS)
    expect(o.items[0].pricingTier).toBe('FALLBACK_ESTIMATE');
    // Live price: the group is asked for as an aws_ec2 instance, and the one-instance price is multiplied by the capacity.
    const asked: string[] = [];
    const live = new CostEstimator({
      pricing: { getPrice: async (q) => { asked.push(q.resourceType); return { provider: 'aws', service: 'AmazonEC2', resourceType: 'aws_ec2', region: 'us-east-1', sku: 't3.medium', pricingModel: 'on-demand', unit: '1 Hour', unitPrice: 0.0416, monthlyPrice: 30.37, currency: 'USD', description: 'EC2', source: 'aws-price-list-api', retrievedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1e6).toISOString(), assumptions: [], tier: 'LIVE' } as never; } },
      currency: { getExchangeRate: async () => null },
    });
    const l = await live.estimateAsync({ architectureId: 'a', projectId: 'p', resources: [asg] }, 'REAL');
    expect(asked).toEqual(['aws_ec2']);
    expect(l.items[0].monthlyUsd).toBeCloseTo(30.37 * 3, 2);
    expect(l.items[0].breakdown[0].label).toMatch(/^3 × t3\.medium/);
  });
});
