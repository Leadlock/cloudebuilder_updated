/**
 * GET /api/currency/rates
 * Server-side exchange rates endpoint.
 *
 * Query params:
 *   from: Base currency (default: 'USD')
 *   to: Optional target currency. If omitted, returns rates for all supported currencies.
 */
import { NextRequest } from 'next/server';
import { ok, badRequest, internalError, tooManyRequests } from '@/lib/api/response';
import { currencyExchangeRateService } from '@/lib/currency/CurrencyExchangeRateService';
import { SUPPORTED_CURRENCIES, SUPPORTED_CURRENCY_CODES, BASE_CURRENCY } from '@/lib/currency/types';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    // This route is unauthenticated (exchange rates aren't user-scoped data),
    // so there's no userId to key the limiter on — fall back to the
    // proxy-reported client IP, same best-effort-only caveat documented on
    // checkRateLimit itself (an IP behind a shared NAT/proxy shares a budget).
    const clientKey = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anonymous';
    const rl = checkRateLimit(`${clientKey}:currency-rates`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const { searchParams } = new URL(req.url);
    const from = (searchParams.get('from') || searchParams.get('base') || BASE_CURRENCY).toUpperCase();
    const to = searchParams.get('to')?.toUpperCase();

    // Specific currency pair
    if (to) {
      const rate = await currencyExchangeRateService.getExchangeRate({ from, to });
      if (!rate) {
        return badRequest(`Exchange rate unavailable for ${from} -> ${to}`);
      }
      return ok({
        rate,
        currency: SUPPORTED_CURRENCIES[to] || null,
      });
    }

    // All supported currencies
    const targetCodes = SUPPORTED_CURRENCY_CODES.filter((c) => c !== from);
    const batchRates = await currencyExchangeRateService.getBatchRates(targetCodes, from);

    const ratesObj: Record<string, unknown> = {};
    for (const [code, rateInfo] of batchRates.entries()) {
      ratesObj[code] = rateInfo;
    }

    // Include self identity rate
    ratesObj[from] = {
      fromCurrency: from,
      toCurrency: from,
      rate: 1.0,
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      source: 'identity',
      isCached: false,
    };

    return ok({
      base: from,
      rates: ratesObj,
      supportedCurrencies: SUPPORTED_CURRENCIES,
    });
  } catch (err) {
    console.error('[GET /api/currency/rates]', err);
    return internalError();
  }
}
