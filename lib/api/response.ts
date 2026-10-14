/**
 * Consistent API response envelope used by all REST routes.
 * Provides a uniform shape regardless of success or failure.
 */
import { hideVendorNames, hideVendorNamesDeep } from './vendorNames';
import { NextRequest, NextResponse } from 'next/server';
import type { ZodError } from 'zod';

// ─── Response envelope ────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function ok<T>(data: T, status = 200): NextResponse<ApiSuccess<T>> {
  return NextResponse.json({ ok: true, data }, { status });
}

export function created<T>(data: T): NextResponse<ApiSuccess<T>> {
  return ok(data, 201);
}

export function apiError(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): NextResponse<ApiError> {
  return NextResponse.json(
    { ok: false, error: { code, message: hideVendorNames(message), ...(details !== undefined ? { details: hideVendorNamesDeep(details) } : {}) } },
    { status },
  );
}

export function notFound(resource = 'Resource'): NextResponse<ApiError> {
  return apiError('NOT_FOUND', `${resource} not found`, 404);
}

export function badRequest(message: string, details?: unknown): NextResponse<ApiError> {
  return apiError('BAD_REQUEST', message, 400, details);
}

export function forbidden(message = 'Access denied'): NextResponse<ApiError> {
  return apiError('FORBIDDEN', message, 403);
}

export function unauthorized(message = 'Authentication required'): NextResponse<ApiError> {
  return apiError('UNAUTHORIZED', message, 401);
}

export function internalError(message = 'Internal server error'): NextResponse<ApiError> {
  return apiError('INTERNAL_ERROR', message, 500);
}

export function serviceUnavailable(message = 'This feature is not available right now'): NextResponse<ApiError> {
  return apiError('SERVICE_UNAVAILABLE', message, 503);
}

export function tooManyRequests(retryAfterSeconds?: number): NextResponse<ApiError> {
  const res = apiError('RATE_LIMITED', 'Too many requests — please slow down and try again shortly.', 429);
  if (retryAfterSeconds !== undefined) res.headers.set('Retry-After', String(retryAfterSeconds));
  return res;
}

// ─── Validation helper ────────────────────────────────────────────────────────

export function validationError(error: ZodError): NextResponse<ApiError> {
  return badRequest('Validation failed', (error as { flatten?: () => unknown }).flatten?.() ?? error.message);
}

// ─── Request body parser ─────────────────────────────────────────────────────

type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: ZodError };

/** Whether a parsed JSON value has a NUL character in any string or object key, however deeply nested. */
export function containsNulCharacter(value: unknown, depth = 0): boolean {
  if (depth > 40) return false;
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some((v) => containsNulCharacter(v, depth + 1));
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => k.includes('\u0000') || containsNulCharacter(v, depth + 1));
  return false;
}

export async function parseBody<T>(
  req: NextRequest,
  schema: { safeParse: (v: unknown) => SafeParseResult<T> },
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse<ApiError> }> {
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return { ok: false, response: badRequest('Invalid JSON body') };
  }
  // A NUL character in any text (or key) is refused by the database, which used to surface as a 500 from whichever route stored or looked up
  // that field. It is never valid, so it is a 400 here, for every route that reads its body through parseBody.
  if (containsNulCharacter(body)) return { ok: false, response: badRequest('The request contains an invalid character.') };
  const result = schema.safeParse(body);
  if (!result.success) {
    return { ok: false, response: validationError(result.error) };
  }
  return { ok: true, data: result.data };
}

// ─── Route error wrapper ──────────────────────────────────────────────────────

type RouteHandler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<NextResponse>;

export function withErrorHandler(handler: RouteHandler): RouteHandler {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      // Log only the message — never the full Error object which may contain
      // stack frames with file paths, or a serialized credential in a nested
      // property (e.g. from misconfigured AWS SDK error objects).
      const message = err instanceof Error ? err.message : String(err);
      console.error('[API Error]', message);
      return internalError();
    }
  };
}
