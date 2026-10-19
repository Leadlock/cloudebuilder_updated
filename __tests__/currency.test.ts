/**
 * CloudBuilder — Multi-Currency & Real Exchange Rate Tests
 *
 * Requirements verified:
 * - USD -> USD identity (rate 1.0)
 * - USD -> INR, USD -> EUR, USD -> GBP conversions
 * - Exchange-rate normalization
 * - Exchange-rate caching (fresh, expired, stale)
 * - API failure handling (stale fallback, never invent fake rates)
 * - Missing exchange rate handling
 * - Currency formatting (locale-aware, JPY zero decimals, INR group separators)
 * - Cost conversion integration
 * - AWS pricing + currency conversion
 * - Azure pricing + currency conversion
 *
 * Deterministic: mocks live HTTP to guarantee 100% reproducible tests.
 */
import { formatCurrency, formatDualCurrency } from '@/lib/currency/formatter';
import { SUPPORTED_CURRENCIES, getCurrencyDefinition, isSupportedCurrency } from '@/lib/currency/types';
import { CurrencyExchangeRateCache } from '@/lib/currency/CurrencyExchangeRateCache';
import { CurrencyExchangeRateService } from '@/lib/currency/CurrencyExchangeRateService';
import { MockExchangeRateProvider, DETERMINISTIC_MOCK_RATES } from '@/lib/currency/providers/MockExchangeRateProvider';
import type { IExchangeRateProvider } from '@/lib/currency/providers/IExchangeRateProvider';
import { CostEstimator } from '@/lib/engines/cost/CostEstimator';
import { CloudProviderPricingService } from '@/lib/cloud/pricing/CloudProviderPricingService';
import { AwsPricingProvider } from '@/lib/cloud/pricing/AwsPricingProvider';
import { AzurePricingProvider } from '@/lib/cloud/pricing/AzurePricingProvider';
import { PricingCache } from '@/lib/cloud/pricing/PricingCache';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

describe('Currency Definition & Formatter', () => {
  test('Supported currencies list includes all required currencies', () => {
    const required = ['USD', 'EUR', 'GBP', 'INR', 'JPY', 'AUD', 'CAD', 'SGD', 'AED'];
    for (const code of required) {
      expect(isSupportedCurrency(code)).toBe(true);
      const def = getCurrencyDefinition(code);
      expect(def.code).toBe(code);
      expect(def.symbol).toBeTruthy();
      expect(def.locale).toBeTruthy();
    }
  });

  test('formatCurrency formats USD correctly with two decimals and dollar symbol', () => {
    const formatted = formatCurrency(1250.5, 'USD');
    expect(formatted).toMatch(/\$1,250\.50/);
  });

  test('formatCurrency formats EUR with Euro currency symbol and proper locale digits', () => {
    const formatted = formatCurrency(1150.4, 'EUR');
    expect(formatted).toContain('€');
    expect(formatted).toMatch(/1[.,]150[.,]40/);
  });

  test('formatCurrency formats GBP with pound sign', () => {
    const formatted = formatCurrency(980.2, 'GBP');
    expect(formatted).toContain('£');
    expect(formatted).toMatch(/980\.20/);
  });

  test('formatCurrency formats INR with rupee symbol', () => {
    const formatted = formatCurrency(104250, 'INR');
    expect(formatted).toContain('₹');
    expect(formatted).toMatch(/1,04,250/);
  });

  test('formatCurrency formats JPY with ZERO decimals', () => {
    const formatted = formatCurrency(180000, 'JPY');
    expect(formatted).toMatch(/[¥￥]/);
    expect(formatted).not.toContain('.00');
    expect(formatted).toMatch(/180,000/);
  });

  test('formatCurrency never manually concatenates and respects custom decimals override', () => {
    const formatted = formatCurrency(50.555, 'USD', { decimals: 3 });
    expect(formatted).toMatch(/\$50\.555/);
  });

  test('formatDualCurrency returns primary target and secondary original provider USD price', () => {
    const dual = formatDualCurrency(4175, 'INR', 50, 'USD', '/mo');
    expect(dual.primary).toContain('₹');
    expect(dual.primary).toContain('/mo');
    expect(dual.secondary).toContain('≈');
    expect(dual.secondary).toContain('$50.00');
    expect(dual.secondary).toContain('/mo');
  });

  test('formatDualCurrency omits secondary when target is USD', () => {
    const dual = formatDualCurrency(50, 'USD', 50, 'USD');
    expect(dual.primary).toContain('$50.00');
    expect(dual.secondary).toBe('');
  });
});

describe('CurrencyExchangeRateService & Caching', () => {
  let mockProvider: MockExchangeRateProvider;
  let customCache: CurrencyExchangeRateCache;
  let service: CurrencyExchangeRateService;

  beforeEach(() => {
    mockProvider = new MockExchangeRateProvider();
    customCache = new CurrencyExchangeRateCache(1000, false); // in-memory only for isolated testing
    service = new CurrencyExchangeRateService(customCache, [mockProvider]);
  });

  test('USD -> USD identity conversion always returns 1.0 without calling providers', async () => {
    const rate = await service.getExchangeRate({ from: 'USD', to: 'USD' });
    expect(rate).not.toBeNull();
    expect(rate!.rate).toBe(1.0);
    expect(rate!.fromCurrency).toBe('USD');
    expect(rate!.toCurrency).toBe('USD');
    expect(rate!.source).toBe('identity');
    expect(rate!.isCached).toBe(false);
  });

  test('USD -> INR returns normalized exchange rate from provider', async () => {
    const rate = await service.getExchangeRate({ from: 'USD', to: 'INR' });
    expect(rate).not.toBeNull();
    expect(rate!.fromCurrency).toBe('USD');
    expect(rate!.toCurrency).toBe('INR');
    expect(rate!.rate).toBe(DETERMINISTIC_MOCK_RATES['USD:INR']);
    expect(rate!.source).toBe('mock-fixtures');
    expect(rate!.retrievedAt).toBeTruthy();
    expect(rate!.expiresAt).toBeTruthy();
  });

  test('USD -> EUR returns normalized exchange rate', async () => {
    const rate = await service.getExchangeRate({ from: 'USD', to: 'EUR' });
    expect(rate).not.toBeNull();
    expect(rate!.fromCurrency).toBe('USD');
    expect(rate!.toCurrency).toBe('EUR');
    expect(rate!.rate).toBe(DETERMINISTIC_MOCK_RATES['USD:EUR']);
  });

  test('USD -> GBP returns normalized exchange rate', async () => {
    const rate = await service.getExchangeRate({ from: 'USD', to: 'GBP' });
    expect(rate).not.toBeNull();
    expect(rate!.fromCurrency).toBe('USD');
    expect(rate!.toCurrency).toBe('GBP');
    expect(rate!.rate).toBe(DETERMINISTIC_MOCK_RATES['USD:GBP']);
  });

  test('Subsequent queries return cached rate with isCached: true', async () => {
    // First call populates cache
    const first = await service.getExchangeRate({ from: 'USD', to: 'INR' });
    expect(first!.isCached).toBe(false);

    // Second call hits cache
    const second = await service.getExchangeRate({ from: 'USD', to: 'INR' });
    expect(second!.isCached).toBe(true);
    expect(second!.isStale).toBe(false);
    expect(second!.rate).toBe(first!.rate);
  });

  test('Expired cache: falls back to stale rate when provider fails', async () => {
    // Populate cache with an entry that expires immediately
    const now = new Date();
    await customCache.set({
      fromCurrency: 'USD',
      toCurrency: 'JPY',
      rate: 150.0,
      retrievedAt: new Date(now.getTime() - 10000).toISOString(),
      expiresAt: new Date(now.getTime() - 5000).toISOString(), // expired
      source: 'test-source',
    });

    // Provider that fails
    const failingProvider: IExchangeRateProvider = {
      name: 'failing-provider',
      getRate: async () => { throw new Error('Network error'); },
    };

    service.setProviders([failingProvider]);

    // Service should return stale cached rate with indicator
    const rate = await service.getExchangeRate({ from: 'USD', to: 'JPY' });
    expect(rate).not.toBeNull();
    expect(rate!.rate).toBe(150.0);
    expect(rate!.isCached).toBe(true);
    expect(rate!.isStale).toBe(true);
    expect(rate!.source).toContain('cached stale');
  });

  test('API failure with NO cache returns null (never invents a fake rate)', async () => {
    const failingProvider: IExchangeRateProvider = {
      name: 'failing-provider',
      getRate: async () => null,
    };
    const emptyCache = new CurrencyExchangeRateCache(1000, false);
    const brokenService = new CurrencyExchangeRateService(emptyCache, [failingProvider]);

    const rate = await brokenService.getExchangeRate({ from: 'USD', to: 'AED' });
    expect(rate).toBeNull();
  });

  test('Missing exchange rate returns null for unsupported currency', async () => {
    const rate = await service.getExchangeRate({ from: 'USD', to: 'XYZ_FAKE_CURRENCY' });
    expect(rate).toBeNull();
  });

  test('convertAmount converts monetary values accurately with metadata', async () => {
    const conversion = await service.convertAmount(100, 'USD', 'INR');
    expect(conversion).not.toBeNull();
    expect(conversion!.originalAmount).toBe(100);
    expect(conversion!.originalCurrency).toBe('USD');
    expect(conversion!.targetCurrency).toBe('INR');
    expect(conversion!.convertedAmount).toBe(100 * 83.50);
    expect(conversion!.rate).toBe(83.50);
    expect(conversion!.source).toBe('mock-fixtures');
  });
});

describe('Cost Engine + Multi-Currency Integration', () => {
  let mockProvider: MockExchangeRateProvider;
  let customCache: CurrencyExchangeRateCache;
  let service: CurrencyExchangeRateService;
  let estimator: CostEstimator;

  beforeEach(() => {
    mockProvider = new MockExchangeRateProvider();
    customCache = new CurrencyExchangeRateCache(1000, false);
    service = new CurrencyExchangeRateService(customCache, [mockProvider]);
    // The mocked FX service must actually be wired in (previously it was created but the
    // estimator used the live singleton, so these tests silently depended on the network).
    // AWS pricing uses the static table (no credentials); Azure uses a fixed fixture price.
    const azureFixture = new AzurePricingProvider();
    azureFixture.getPrice = async (q) => ({
      provider: 'azure', service: 'Virtual Machines', resourceType: q.resourceType, region: q.region, sku: String(q.configuration['size']),
      pricingModel: 'on-demand', unit: '1 Hour', unitPrice: 0.0416, monthlyPrice: 0.0416 * 730, currency: 'USD', description: 'fixture',
      source: 'azure-retail-api', retrievedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), assumptions: [],
    });
    const pricingCache = new PricingCache(); pricingCache.clear();
    estimator = new CostEstimator({
      currency: service,
      pricing: new CloudProviderPricingService(pricingCache, [new AwsPricingProvider(), azureFixture]),
    });
  });

  test('Synchronous estimate keeps original providerPrice in USD', () => {
    const resource: DbArchitectureResource = {
      id: 'res-ec2-1',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'Web Server',
      positionX: 0,
      positionY: 0,
      configJson: JSON.stringify({ instanceType: 't3.micro' }),
      region: 'us-east-1',
      groupId: null,
      locked: false,
      architectureId: 'arch-1',
    };

    const result = estimator.estimate({
      architectureId: 'arch-1',
      projectId: 'proj-1',
      resources: [resource],
    }, 'TEST');

    expect(result.currency).toBe('USD');
    expect(result.totalMonthlyUsd).toBeGreaterThan(0);
    expect(result.items.length).toBe(1);

    const item = result.items[0];
    expect(item.providerPrice).toBeDefined();
    expect(item.providerPrice!.currency).toBe('USD');
    expect(item.providerPrice!.monthlyPrice).toBe(item.monthlyUsd);
    expect(item.providerPrice!.unitPrice).toBe(item.hourlyUsd);
  });

  test('AWS EC2 pricing with USD -> INR real currency conversion', async () => {
    // Inject mock exchange rate service
    const resource: DbArchitectureResource = {
      id: 'res-ec2-inr',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'Mumbai App Server',
      positionX: 0,
      positionY: 0,
      configJson: JSON.stringify({ instanceType: 't3.micro' }),
      region: 'ap-south-1',
      groupId: null,
      locked: false,
      architectureId: 'arch-1',
    };

    const result = await estimator.estimateAsync({
      architectureId: 'arch-1',
      projectId: 'proj-1',
      resources: [resource],
      targetCurrency: 'INR',
    }, 'REAL');

    expect(result.currency).toBe('INR');
    expect(result.totalMonthlyUsd).toBeGreaterThan(0);
    expect(result.totalMonthlyConverted).toBeGreaterThan(result.totalMonthlyUsd);

    const item = result.items[0];
    // Provider price preserved
    expect(item.providerPrice).toBeDefined();
    expect(item.providerPrice!.currency).toBe('USD');
    expect(item.providerPrice!.monthlyPrice).toBe(item.monthlyUsd);

    // Converted price accurate
    expect(item.convertedPrice).toBeDefined();
    expect(item.convertedPrice!.currency).toBe('INR');
    expect(item.convertedPrice!.exchangeRate).toBeGreaterThan(0);
    expect(item.convertedPrice!.monthlyPrice).toBeCloseTo(item.monthlyUsd * item.convertedPrice!.exchangeRate, 2);

    // Exchange rate meta attached
    expect(result.exchangeRateMeta).toBeDefined();
    expect(result.exchangeRateMeta!.toCurrency).toBe('INR');
    expect(result.exchangeRateMeta!.rate).toBe(DETERMINISTIC_MOCK_RATES['USD:INR']);
    expect(result.exchangeRateTier).toBe('LIVE');
  });

  test('Azure VM pricing with USD -> EUR real currency conversion', async () => {
    const resource: DbArchitectureResource = {
      id: 'res-vm-eur',
      resourceType: 'azure_vm',
      provider: 'azure',
      label: 'Europe VM',
      positionX: 0,
      positionY: 0,
      configJson: JSON.stringify({ size: 'Standard_B2s' }),
      region: 'westeurope',
      groupId: null,
      locked: false,
      architectureId: 'arch-1',
    };

    const result = await estimator.estimateAsync({
      architectureId: 'arch-1',
      projectId: 'proj-1',
      resources: [resource],
      targetCurrency: 'EUR',
    }, 'REAL');

    expect(result.currency).toBe('EUR');
    expect(result.totalMonthlyUsd).toBeGreaterThan(0);
    expect(result.totalMonthlyConverted).toBeGreaterThan(0);

    const item = result.items[0];
    expect(item.providerPrice).toBeDefined();
    expect(item.providerPrice!.currency).toBe('USD');
    expect(item.convertedPrice).toBeDefined();
    expect(item.convertedPrice!.currency).toBe('EUR');
  });

  test('Multi-cloud architecture (AWS + Azure) converted together consistently', async () => {
    const awsRes: DbArchitectureResource = {
      id: 'res-aws',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'AWS EC2',
      positionX: 0,
      positionY: 0,
      configJson: JSON.stringify({ instanceType: 't3.micro' }),
      region: 'us-east-1',
      groupId: null,
      locked: false,
      architectureId: 'arch-1',
    };

    const azureRes: DbArchitectureResource = {
      id: 'res-az',
      resourceType: 'azure_vm',
      provider: 'azure',
      label: 'Azure VM',
      positionX: 0,
      positionY: 0,
      configJson: JSON.stringify({ size: 'Standard_B2s' }),
      region: 'eastus',
      groupId: null,
      locked: false,
      architectureId: 'arch-1',
    };

    const result = await estimator.estimateAsync({
      architectureId: 'arch-1',
      projectId: 'proj-1',
      resources: [awsRes, azureRes],
      targetCurrency: 'GBP',
    }, 'REAL');

    expect(result.currency).toBe('GBP');
    expect(result.items.length).toBe(2);
    expect(result.items[0].convertedPrice?.currency).toBe('GBP');
    expect(result.items[1].convertedPrice?.currency).toBe('GBP');
    expect(result.totalMonthlyConverted).toBeCloseTo(
      result.totalMonthlyUsd * (result.exchangeRateMeta?.rate ?? 1.0),
      1
    );
  });
});
