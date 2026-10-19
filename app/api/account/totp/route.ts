/**
 * Authenticator-app confirmation for the signed-in person.
 *
 * GET  /api/account/totp                              { enabled, recoveryCodesLeft }
 * POST { action: 'begin',   password }                start setup: returns the secret and otpauth link (shown once)
 * POST { action: 'enable',  code }                    turn it on with a correct code from the app; returns recovery codes (shown once)
 * POST { action: 'disable', password, code }          turn it off (needs both)
 *
 * Once on, confirming a deploy or teardown needs the password AND a code. Starting or stopping it needs the password, so someone who
 * only borrowed an open session cannot switch the protection off, or set up their own app. Wrong tries are rate-limited.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, unauthorized, forbidden, internalError, badRequest, tooManyRequests, apiError } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { checkRateLimit, peekRateLimit, resetRateLimit } from '@/lib/api/rateLimit';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { verifyAccountPassword } from '@/lib/auth/verifyAccountPassword';
import { totpStatus, beginTotpSetup, enableTotp, verifyTotpCode, disableTotp } from '@/lib/api/totpStore';

export const dynamic = 'force-dynamic';

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('begin'), password: z.string().min(1).max(512) }).strict(),
  z.object({ action: z.literal('enable'), code: z.string().trim().min(6).max(12) }).strict(),
  z.object({ action: z.literal('disable'), password: z.string().min(1).max(512), code: z.string().trim().min(6).max(12) }).strict(),
]);

const TRIES = { limit: 5, windowMs: 15 * 60_000 };
const tryKey = (userId: string) => `${userId}:totp-setup`;

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    return ok(await totpStatus(identity.userId));
  } catch (err) {
    console.error('[GET /api/account/totp]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const userId = identity.userId;

    let raw: unknown;
    try { raw = await req.json(); } catch { return badRequest('Invalid JSON body'); }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) return badRequest('Send an action (begin, enable or disable) with the fields it needs.');
    const body = parsed.data;

    const peek = await peekRateLimit(tryKey(userId), TRIES.limit, TRIES.windowMs);
    if (peek.remaining <= 0) return tooManyRequests(peek.resetsInSeconds);
    const fail = async (message: string) => { await checkRateLimit(tryKey(userId), TRIES.limit, TRIES.windowMs); return apiError('WRONG_CREDENTIALS', message, 403); };

    const check = (password: string) => verifyAccountPassword({ userId, email: identity.email, password });

    if (body.action === 'begin') {
      const checked = await check(body.password);
      if (checked === 'none') return forbidden('Your account has no password CloudBuilder can check, so an authenticator app cannot be added to it.');
      if (checked === 'unavailable') return apiError('SERVICE_UNAVAILABLE', 'Could not check your password right now. Try again in a minute.', 503);
      if (checked !== 'ok') return fail('That password is not right.');
      const user = await orgRepository.findUser(userId);
      try {
        const setup = await beginTotpSetup(userId, user?.email ?? userId);
        await resetRateLimit(tryKey(userId));
        return ok(setup);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 409) return apiError('CONFLICT', (err as Error).message, 409);
        throw err;
      }
    }

    if (body.action === 'enable') {
      const result = await enableTotp(userId, body.code);
      if (!result.ok) return fail(result.message);
      await resetRateLimit(tryKey(userId));
      console.info(`[totp] enabled for user ${userId}`);
      return ok({ recoveryCodes: result.recoveryCodes });
    }

    // disable
    const checked = await check(body.password);
    if (checked === 'unavailable') return apiError('SERVICE_UNAVAILABLE', 'Could not check your password right now. Try again in a minute.', 503);
    if (checked !== 'ok') return fail('That password is not right.');
    if (!(await verifyTotpCode(userId, body.code))) return fail('That code is not right.');
    await disableTotp(userId);
    await resetRateLimit(tryKey(userId));
    console.info(`[totp] disabled for user ${userId}`);
    return ok({ enabled: false });
  } catch (err) {
    console.error('[POST /api/account/totp]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
