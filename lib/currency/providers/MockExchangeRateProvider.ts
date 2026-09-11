/**
 * CloudCraft — Mock Exchange Rate Provider
 *
 * Deterministic fixture provider for unit tests and offline testing.
 */
import type { IExchangeRateProvider } from './IExchangeRateProvider';
import type { ExchangeRateResult } from '../types';

export const DETERMINISTIC_MOCK_RATES: Record<string, number> = {
  'USD:USD': 1.0,
  'USD:EUR': 0.92,
  'USD:GBP': 0.79,
  'USD:INR': 83.50,
  'USD:JPY': 155.0,
  'USD:AUD': 1.52,
  'USD:CAD': 1.36,
  'USD:SGD': 1.34,
  'USD:AED': 3.6725,
};

export class MockExchangeRateProvider implements IExchangeRateProvider {
  readonly name = 'mock-fixtures';
  private _rates: Map<string, number>;

  constructor(customRates?: Record<string, number>) {
    this._rates = new Map(Object.entries(customRates ?? DETERMINISTIC_MOCK_RATES));
  }

  setRate(from: string, to: string, rate: number): void {
    this._rates.set(`${from.toUpperCase()}:${to.toUpperCase()}`, rate);
  }

  async getRate(from: string, to: string): Promise<ExchangeRateResult | null> {
    const base = from.toUpperCase();
    const target = to.toUpperCase();

    const now = new Date();
    const retrievedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

    if (base === target) {
      return {
        fromCurrency: base,
        toCurrency: target,
        rate: 1.0,
        retrievedAt,
        expiresAt,
        source: this.name,
      };
    }

    const key = `${base}:${target}`;
    const rate = this._rates.get(key);
    if (rate === undefined) return null;

    return {
      fromCurrency: base,
      toCurrency: target,
      rate,
      retrievedAt,
      expiresAt,
      source: this.name,
    };
  }

  async getAllRates(base: string): Promise<Map<string, ExchangeRateResult> | null> {
    const baseCode = base.toUpperCase();
    const map = new Map<string, ExchangeRateResult>();

    for (const [k, rate] of this._rates.entries()) {
      const [f, t] = k.split(':');
      if (f === baseCode) {
        map.set(t, {
          fromCurrency: f,
          toCurrency: t,
          rate,
          retrievedAt: '2026-09-10T00:00:00.000Z',
          expiresAt: '2026-09-11T00:00:00.000Z',
          source: this.name,
        });
      }
    }
    return map;
  }
}

export const mockExchangeRateProvider = new MockExchangeRateProvider();
