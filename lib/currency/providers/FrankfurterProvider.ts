/**
 * CloudCraft — Frankfurter Exchange Rate Provider (European Central Bank data)
 *
 * Secondary authoritative fallback provider for Forex reference rates.
 */
import type { IExchangeRateProvider } from './IExchangeRateProvider';
import type { ExchangeRateResult } from '../types';

interface FrankfurterResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

export class FrankfurterProvider implements IExchangeRateProvider {
  readonly name = 'frankfurter-ecb';
  private _baseUrl: string;

  constructor(baseUrl: string = 'https://api.frankfurter.dev/v1/latest') {
    this._baseUrl = baseUrl;
  }

  async getRate(from: string, to: string): Promise<ExchangeRateResult | null> {
    const base = from.toUpperCase();
    const target = to.toUpperCase();

    if (base === target) {
      const now = new Date().toISOString();
      return {
        fromCurrency: base,
        toCurrency: target,
        rate: 1.0,
        retrievedAt: now,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        source: this.name,
      };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${this._baseUrl}?base=${base}&symbols=${target}`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeoutId);

      if (!res.ok) return null;

      const data = (await res.json()) as FrankfurterResponse;
      if (!data.rates || typeof data.rates[target] !== 'number') return null;

      const rate = data.rates[target];
      const now = new Date();
      return {
        fromCurrency: base,
        toCurrency: target,
        rate,
        retrievedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
        source: this.name,
      };
    } catch (err) {
      console.warn(`[FrankfurterProvider] Failed to fetch rate ${base} -> ${target}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }
}

export const frankfurterProvider = new FrankfurterProvider();
