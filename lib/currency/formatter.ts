/**
 * CloudBuilder — Currency Formatting Utilities
 *
 * Provides locale-aware monetary formatting using Intl.NumberFormat.
 * Complies with currency decimal rules (e.g. JPY has 0 decimals, INR uses lakh/crore group separators).
 */
import { getCurrencyDefinition } from './types';

export interface FormatCurrencyOptions {
  /** Override decimals if desired (otherwise follows currency standard) */
  decimals?: number;
  /** Whether to append the currency code after the formatted value, e.g. "₹1,250.00 INR" */
  showCode?: boolean;
}

/**
 * Formats a monetary amount according to locale standards and currency rules.
 * Never manually concatenates currency symbols.
 */
export function formatCurrency(
  amount: number,
  currency: string = 'USD',
  options?: FormatCurrencyOptions
): string {
  const def = getCurrencyDefinition(currency);
  const decimals = options?.decimals !== undefined ? options.decimals : def.decimals;

  try {
    const formatter = new Intl.NumberFormat(def.locale, {
      style: 'currency',
      currency: def.code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });

    const formatted = formatter.format(amount);
    if (options?.showCode && !formatted.includes(def.code)) {
      return `${formatted} ${def.code}`;
    }
    return formatted;
  } catch {
    // Fallback for uncommon environments
    const fallbackFormatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: def.code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return fallbackFormatter.format(amount);
  }
}

/**
 * Dual currency display helper, e.g.:
 * "₹4,195.00/mo (≈ $50.00 USD/mo)"
 */
export function formatDualCurrency(
  targetAmount: number,
  targetCurrency: string,
  providerAmount: number,
  providerCurrency: string = 'USD',
  suffix: string = ''
): { primary: string; secondary: string } {
  const primary = `${formatCurrency(targetAmount, targetCurrency)}${suffix}`;
  const secondary = targetCurrency.toUpperCase() === providerCurrency.toUpperCase()
    ? ''
    : `≈ ${formatCurrency(providerAmount, providerCurrency)}${suffix}`;

  return { primary, secondary };
}
