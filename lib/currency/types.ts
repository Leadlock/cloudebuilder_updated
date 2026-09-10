/**
 * CloudCraft — Multi-Currency & Live Exchange Rate Domain Types
 *
 * Provides a strong contract for money amounts, exchange rate queries,
 * normalized results, and currency definitions.
 */

export interface Money {
  amount: number;
  currency: string;
}

export interface ExchangeRateQuery {
  from: string;
  to: string;
}

export interface ExchangeRateResult {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  retrievedAt: string;
  expiresAt: string;
  source: string;
  isCached?: boolean;
  isStale?: boolean;
}

export interface SupportedCurrency {
  code: string;
  name: string;
  symbol: string;
  locale: string;
  decimals: number;
  flag?: string;
}

export const BASE_CURRENCY = 'USD';

export const SUPPORTED_CURRENCIES: Record<string, SupportedCurrency> = {
  USD: { code: 'USD', name: 'US Dollar', symbol: '$', locale: 'en-US', decimals: 2 },
  EUR: { code: 'EUR', name: 'Euro', symbol: '€', locale: 'de-DE', decimals: 2 },
  GBP: { code: 'GBP', name: 'British Pound', symbol: '£', locale: 'en-GB', decimals: 2 },
  INR: { code: 'INR', name: 'Indian Rupee', symbol: '₹', locale: 'en-IN', decimals: 2 },
  JPY: { code: 'JPY', name: 'Japanese Yen', symbol: '¥', locale: 'ja-JP', decimals: 0 },
  AUD: { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', locale: 'en-AU', decimals: 2 },
  CAD: { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', locale: 'en-CA', decimals: 2 },
  SGD: { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', locale: 'en-SG', decimals: 2 },
  AED: { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', locale: 'ar-AE', decimals: 2 },
};

export const SUPPORTED_CURRENCY_CODES = Object.keys(SUPPORTED_CURRENCIES);

export function isSupportedCurrency(currency: string): boolean {
  return currency.toUpperCase() in SUPPORTED_CURRENCIES;
}

export function getCurrencyDefinition(currency: string): SupportedCurrency {
  const code = currency.toUpperCase();
  return SUPPORTED_CURRENCIES[code] ?? {
    code,
    name: code,
    symbol: code,
    locale: 'en-US',
    decimals: 2,
  };
}
