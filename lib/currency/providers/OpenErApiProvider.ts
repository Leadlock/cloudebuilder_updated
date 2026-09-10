/**
 * CloudCraft — Open ExchangeRate API Provider
 *
 * Sourced from open.er-api.com (reliable, real-time Forex exchange rates).
 * Completely server-side, no secret leakage to client.
 */
import type { IExchangeRateProvider } from './IExchangeRateProvider';
import type { ExchangeRateResult } from '../types';

interface OpenErApiResponse {
  result: string;
  provider: string;
  time_last_update_utc: string;
  time_next_update_utc?: string;
  base_code: string;
  rates: Record<string, number>;
}

export class OpenErApiProvider implements IExchangeRateProvider {
  readonly name = 'open-er-api';
  private _baseUrl: string;

  constructor(baseUrl: string = 'https://open.er-api.com/v6/latest') {
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

      const res = await fetch(`${this._baseUrl}/${base}`, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'CloudCraft-ExchangeRateService/1.0',
        },
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        console.warn(`[OpenErApiProvider] HTTP ${res.status} from ${this._baseUrl}/${base}`);
        return null;
      }

      const data = (await res.json()) as OpenErApiResponse;
      if (data.result !== 'success' || !data.rates || typeof data.rates[target] !== 'number') {
        return null;
      }

      const rate = data.rates[target];
      const retrievedAt = new Date().toISOString();
      const expiresAt = data.time_next_update_utc
        ? new Date(data.time_next_update_utc).toISOString()
        : new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

      return {
        fromCurrency: base,
        toCurrency: target,
        rate,
        retrievedAt,
        expiresAt,
        source: this.name,
      };
    } catch (err) {
      console.warn(`[OpenErApiProvider] Failed to fetch rate ${base} -> ${target}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  async getAllRates(base: string): Promise<Map<string, ExchangeRateResult> | null> {
    const baseCode = base.toUpperCase();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${this._baseUrl}/${baseCode}`, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'CloudCraft-ExchangeRateService/1.0',
        },
      });
      clearTimeout(timeoutId);

      if (!res.ok) return null;

      const data = (await res.json()) as OpenErApiResponse;
      if (data.result !== 'success' || !data.rates) return null;

      const result = new Map<string, ExchangeRateResult>();
      const retrievedAt = new Date().toISOString();
      const expiresAt = data.time_next_update_utc
        ? new Date(data.time_next_update_utc).toISOString()
        : new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

      for (const [targetCode, rate] of Object.entries(data.rates)) {
        result.set(targetCode.toUpperCase(), {
          fromCurrency: baseCode,
          toCurrency: targetCode.toUpperCase(),
          rate,
          retrievedAt,
          expiresAt,
          source: this.name,
        });
      }

      return result;
    } catch (err) {
      console.warn(`[OpenErApiProvider] Failed to fetch all rates for ${baseCode}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }
}

export const openErApiProvider = new OpenErApiProvider();
