/**
 * CloudCraft — Exchange Rate Provider Interface
 *
 * Allows plugging in different exchange rate sources without changing
 * the core pricing or cost engine.
 */
import type { ExchangeRateResult } from '../types';

export interface IExchangeRateProvider {
  readonly name: string;
  getRate(from: string, to: string): Promise<ExchangeRateResult | null>;
  getAllRates?(base: string): Promise<Map<string, ExchangeRateResult> | null>;
}
