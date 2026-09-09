/**
 * Consistent API response envelope used by all REST routes.
 * Provides a uniform shape regardless of success or failure.
 */
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
    { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } },
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

// ─── Validation helper ────────────────────────────────────────────────────────

export function validationError(error: ZodError): NextResponse<ApiError> {
  return badRequest('Validation failed', (error as { flatten?: () => unknown }).flatten?.() ?? error.message);
}

// ─── Request body parser ─────────────────────────────────────────────────────

type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: ZodError };

export async function parseBody<T>(
  req: NextRequest,
  schema: { safeParse: (v: unknown) => SafeParseResult<T> },
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse<ApiError> }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, response: badRequest('Invalid JSON body') };
  }
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
