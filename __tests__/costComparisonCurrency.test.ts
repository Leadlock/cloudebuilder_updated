/**
 * Tests for the currency-conversion bug found in this session's audit:
 * CostComparisonPanel (and the services feeding it) read the raw USD
 * total/per-item values and formatted them under the display currency's
 * symbol WITHOUT ever applying the exchange rate — so switching to e.g.
 * INR never actually converted the numbers shown.
 *
 * These tests exercise the SERVICE layer (ApiCostService.compareCosts,
 * MockCostService.compareCosts) that the panel consumes, verifying the
 * returned totals/items carry genuinely converted values, not raw USD
 * relabeled with a different currency code.
 */
import { setActiveProjectId, setActiveEnvironment } from '@/lib/services/ApiCostService';

const originalFetch = global.fetch;

function mockFetchOnce(body: unknown, ok = true) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok,
    json: () => Promise.resolve({ ok: true, data: body }),
  });
}

describe('ApiCostService.compareCosts — currency conversion', () => {
  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    setActiveProjectId('proj-1');
    setActiveEnvironment('production');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setActiveProjectId(null);
  });

  it('uses totalMonthlyConverted (not totalMonthlyUsd) for the converted total when currency is non-USD', async () => {
    mockFetchOnce({
      currentProvider: 'aws',
      targetProvider: 'azure',
      targetCurrency: 'INR',
      current: {
        items: [],
        totalMonthlyUsd: 100,
        totalHourlyUsd: 100 / 730,
        totalMonthlyConverted: 8350, // 100 USD * ~83.5 rate
        totalHourlyConverted: 8350 / 730,
        currency: 'INR',
      },
      translated: {
        items: [],
        totalMonthlyUsd: 120,
        totalHourlyUsd: 120 / 730,
        totalMonthlyConverted: 10020,
        totalHourlyConverted: 10020 / 730,
        currency: 'INR',
      },
    });

    const { apiCostService } = await import('@/lib/services/ApiCostService');
    const result = await apiCostService.compareCosts!([], 'INR');

    expect(result.current.totalMonthlyConverted).toBe(8350);
    expect(result.current.totalMonthlyUsd).toBe(100);
    expect(result.translated.totalMonthlyConverted).toBe(10020);
    // The two must NOT be equal — that equality is exactly the bug (raw USD shown as if converted).
    expect(result.current.totalMonthlyConverted).not.toBe(result.current.totalMonthlyUsd);
  });

  it('maps per-item monthlyCost to the converted price when convertedPrice is present', async () => {
    mockFetchOnce({
      currentProvider: 'aws',
      targetProvider: 'azure',
      targetCurrency: 'EUR',
      current: {
        items: [{
          resourceId: 'r1', resourceLabel: 'Web Server', resourceType: 'aws_ec2', provider: 'aws', region: 'us-east-1',
          hourlyUsd: 0.1, monthlyUsd: 73, breakdown: [], assumptions: [], pricingSource: 'live', confidence: 'estimate',
          convertedPrice: { unitPrice: 0.092, monthlyPrice: 67.16, currency: 'EUR', exchangeRate: 0.92, exchangeRateSource: 'test', exchangeRateRetrievedAt: '2024-01-01T00:00:00Z' },
        }],
        totalMonthlyUsd: 73, totalHourlyUsd: 0.1, totalMonthlyConverted: 67.16, totalHourlyConverted: 0.092, currency: 'EUR',
      },
      translated: { items: [], totalMonthlyUsd: 0, totalHourlyUsd: 0, totalMonthlyConverted: 0, totalHourlyConverted: 0, currency: 'EUR' },
    });

    const { apiCostService } = await import('@/lib/services/ApiCostService');
    const result = await apiCostService.compareCosts!([], 'EUR');

    expect(result.current.items[0]!.monthlyCost).toBe(67.16);
    expect(result.current.items[0]!.currency).toBe('EUR');
  });

  it('computes pricingCoveragePct from unsupported items, and excludes them from items/totals', async () => {
    mockFetchOnce({
      currentProvider: 'aws',
      targetProvider: 'azure',
      targetCurrency: 'USD',
      current: {
        items: [
          { resourceId: 'r1', resourceLabel: 'Priced', resourceType: 'aws_ec2', provider: 'aws', region: 'us-east-1', hourlyUsd: 0.1, monthlyUsd: 73, breakdown: [], assumptions: [], pricingSource: 'live', confidence: 'estimate' },
          { resourceId: 'r2', resourceLabel: 'Unpriced', resourceType: 'aws_ecs', provider: 'aws', region: 'us-east-1', hourlyUsd: 0, monthlyUsd: 0, breakdown: [], assumptions: [], pricingSource: 'none', confidence: 'unsupported' },
        ],
        totalMonthlyUsd: 73, totalHourlyUsd: 0.1, totalMonthlyConverted: 73, totalHourlyConverted: 0.1, currency: 'USD',
      },
      translated: { items: [], totalMonthlyUsd: 0, totalHourlyUsd: 0, totalMonthlyConverted: 0, totalHourlyConverted: 0, currency: 'USD' },
    });

    const { apiCostService } = await import('@/lib/services/ApiCostService');
    const result = await apiCostService.compareCosts!([], 'USD');

    expect(result.current.items).toHaveLength(1);
    expect(result.current.unsupportedCount).toBe(1);
    expect(result.current.totalResourceCount).toBe(2);
    expect(result.current.pricingCoveragePct).toBeCloseTo(50, 5);
  });
});

describe('MockCostService.compareCosts (fallback path) — currency conversion', () => {
  it('produces a totalMonthlyConverted that differs from totalMonthlyUsd for a non-USD currency', async () => {
    const { costService } = await import('@/lib/services/CostService');
    const nodes = [{
      id: 'n1', type: 'cloudNode' as const, resourceType: 'aws_ec2', provider: 'aws' as const, label: 'Web',
      position: { x: 0, y: 0 }, config: { instanceType: 't3.medium' },
    }];

    const result = await costService.compareCosts!(nodes, 'INR');
    expect(result.current.currency).toBe('INR');
    if (result.current.totalMonthlyUsd > 0) {
      expect(result.current.totalMonthlyConverted).not.toBe(result.current.totalMonthlyUsd);
      expect(result.current.totalMonthlyConverted).toBeGreaterThan(result.current.totalMonthlyUsd);
    }
  });

  it('leaves totalMonthlyConverted equal to totalMonthlyUsd for USD (no conversion needed)', async () => {
    const { costService } = await import('@/lib/services/CostService');
    const nodes = [{
      id: 'n1', type: 'cloudNode' as const, resourceType: 'aws_ec2', provider: 'aws' as const, label: 'Web',
      position: { x: 0, y: 0 }, config: { instanceType: 't3.medium' },
    }];

    const result = await costService.compareCosts!(nodes, 'USD');
    expect(result.current.totalMonthlyConverted).toBeCloseTo(result.current.totalMonthlyUsd, 5);
  });
});
