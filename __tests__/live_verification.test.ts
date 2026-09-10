import { currencyExchangeRateService } from '@/lib/currency/CurrencyExchangeRateService';
import { costEstimator } from '@/lib/engines/cost/CostEstimator';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

describe('Live Controlled Verification', () => {
  test('Live Forex retrieval & Real cloud price conversion', async () => {
    // 1. Live Exchange Rates
    const inr = await currencyExchangeRateService.getExchangeRate({ from: 'USD', to: 'INR' });
    const eur = await currencyExchangeRateService.getExchangeRate({ from: 'USD', to: 'EUR' });

    console.log('=== LIVE FOREX RATES ===');
    console.log(`USD -> INR: Rate=${inr?.rate}, Source=${inr?.source}, RetrievedAt=${inr?.retrievedAt}`);
    console.log(`USD -> EUR: Rate=${eur?.rate}, Source=${eur?.source}, RetrievedAt=${eur?.retrievedAt}`);

    expect(inr).not.toBeNull();
    expect(inr!.rate).toBeGreaterThan(70);
    expect(eur).not.toBeNull();
    expect(eur!.rate).toBeGreaterThan(0.7);

    // 2. AWS Pricing + Currency Conversion
    const awsRes: DbArchitectureResource = {
      id: 'live-ec2',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'Mumbai EC2 t3.medium',
      positionX: 0,
      positionY: 0,
      configJson: JSON.stringify({ instanceType: 't3.medium' }),
      region: 'ap-south-1',
      groupId: null,
      locked: false,
      architectureId: 'live-arch',
    };

    const awsResult = await costEstimator.estimateAsync({
      architectureId: 'live-arch',
      projectId: 'live-proj',
      resources: [awsRes],
      targetCurrency: 'INR',
    }, 'REAL');

    console.log('=== AWS REAL PRICE CONVERSION (ap-south-1) ===');
    console.log(`Monthly USD: $${awsResult.totalMonthlyUsd.toFixed(2)}`);
    console.log(`Monthly INR: ₹${awsResult.totalMonthlyConverted?.toFixed(2)}`);
    console.log(`Exchange Rate: 1 USD = ₹${awsResult.exchangeRateMeta?.rate.toFixed(4)} via ${awsResult.exchangeRateMeta?.source}`);

    expect(awsResult.totalMonthlyUsd).toBeGreaterThan(0);
    expect(awsResult.totalMonthlyConverted).toBeGreaterThan(0);
    expect(awsResult.currency).toBe('INR');

    // 3. Azure Pricing + Currency Conversion
    const azRes: DbArchitectureResource = {
      id: 'live-vm',
      resourceType: 'azure_vm',
      provider: 'azure',
      label: 'Europe VM Standard_B2s',
      positionX: 0,
      positionY: 0,
      configJson: JSON.stringify({ size: 'Standard_B2s' }),
      region: 'westeurope',
      groupId: null,
      locked: false,
      architectureId: 'live-arch',
    };

    const azResult = await costEstimator.estimateAsync({
      architectureId: 'live-arch',
      projectId: 'live-proj',
      resources: [azRes],
      targetCurrency: 'EUR',
    }, 'REAL');

    console.log('=== AZURE REAL PRICE CONVERSION (westeurope) ===');
    console.log(`Monthly USD: $${azResult.totalMonthlyUsd.toFixed(2)}`);
    console.log(`Monthly EUR: €${azResult.totalMonthlyConverted?.toFixed(2)}`);
    console.log(`Exchange Rate: 1 USD = €${azResult.exchangeRateMeta?.rate.toFixed(4)} via ${azResult.exchangeRateMeta?.source}`);

    expect(azResult.totalMonthlyUsd).toBeGreaterThan(0);
    expect(azResult.totalMonthlyConverted).toBeGreaterThan(0);
    expect(azResult.currency).toBe('EUR');
  }, 30000);
});
