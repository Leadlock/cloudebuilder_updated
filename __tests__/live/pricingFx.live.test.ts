/**
 * LIVE VERIFICATION — requires outbound HTTPS to:
 *   - open.er-api.com / api.frankfurter.dev (exchange rates)
 *   - prices.azure.com (Azure Retail Prices API)
 *   - AWS Price List API (only when AWS_PRICING_ACCESS_KEY_ID / _SECRET_ACCESS_KEY are set)
 *
 * Not part of `npm test`. Run with `npm run test:live`. A host that cannot be reached is a
 * FAILED live check (reported with the host and reason), never a pass.
 */
import { CurrencyExchangeRateService } from '@/lib/currency/CurrencyExchangeRateService';
import { CurrencyExchangeRateCache } from '@/lib/currency/CurrencyExchangeRateCache';
import { AzurePricingProvider } from '@/lib/cloud/pricing/AzurePricingProvider';
import { AwsPricingProvider } from '@/lib/cloud/pricing/AwsPricingProvider';
import { classifyPricingSource, classifyRate } from '@/lib/cloud/pricing/tiers';

async function reach(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return r.ok ? null : `HTTP ${r.status}`;
  } catch (e) {
    return (e as Error & { cause?: { message?: string } }).cause?.message ?? (e as Error).message;
  }
}

describe('LIVE: exchange rates', () => {
  test('USD→INR and USD→EUR are retrieved live from a real provider', async () => {
    const blocked = await reach('https://open.er-api.com/v6/latest/USD');
    const blocked2 = await reach('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR');
    if (blocked && blocked2) {
      throw new Error(`EXTERNAL CONNECTIVITY REQUIRED: open.er-api.com (${blocked}) and api.frankfurter.dev (${blocked2}) are unreachable from this environment.`);
    }
    const svc = new CurrencyExchangeRateService(new CurrencyExchangeRateCache(1000, false));
    const inr = await svc.getExchangeRate({ from: 'USD', to: 'INR' });
    const eur = await svc.getExchangeRate({ from: 'USD', to: 'EUR' });
    expect(classifyRate(inr)).toBe('LIVE');
    expect(classifyRate(eur)).toBe('LIVE');
    expect(inr!.rate).toBeGreaterThan(50);
    expect(eur!.rate).toBeGreaterThan(0.5);
  }, 30_000);
});

describe('LIVE: Azure Retail Prices API', () => {
  test('Standard_B2s in eastus is priced from the live API', async () => {
    const blocked = await reach("https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Virtual Machines' and armRegionName eq 'eastus' and armSkuName eq 'Standard_B2s'");
    if (blocked) throw new Error(`EXTERNAL CONNECTIVITY REQUIRED: prices.azure.com unreachable (${blocked}).`);
    const p = await new AzurePricingProvider().getPrice({ provider: 'azure', resourceType: 'azure_vm', region: 'eastus', configuration: { size: 'Standard_B2s' } });
    expect(p).not.toBeNull();
    expect(classifyPricingSource(p!.source)).toBe('LIVE');
    expect(p!.unitPrice).toBeGreaterThan(0);
  }, 30_000);
});

describe('LIVE: AWS Price List API', () => {
  const configured = Boolean(process.env['AWS_PRICING_ACCESS_KEY_ID'] && process.env['AWS_PRICING_SECRET_ACCESS_KEY']);
  test('t3.micro in us-east-1 is priced from the live API (requires AWS_PRICING_* credentials)', async () => {
    if (!configured) throw new Error('EXTERNAL CREDENTIALS REQUIRED: set AWS_PRICING_ACCESS_KEY_ID and AWS_PRICING_SECRET_ACCESS_KEY to verify the AWS Price List API.');
    const p = await new AwsPricingProvider().getPrice({ provider: 'aws', resourceType: 'aws_ec2', region: 'us-east-1', configuration: { instanceType: 't3.micro' } });
    expect(p!.source).toBe('aws-price-list-api');
  }, 30_000);
});
