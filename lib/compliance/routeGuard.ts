/**
 * What every readiness route checks first: who is calling, that they belong to the organization that owns the project, that the framework is a
 * known one, and (for the expensive calls) the rate limit. Returns the caller, or the response to send instead.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, tooManyRequests, unauthorized } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { requireProjectAccess } from '@/lib/api/projectAccess';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import { isFramework } from './rules';
import type { FrameworkId } from './types';

export interface ReadinessCaller { userId: string; email: string; orgId: string; role: string; isAdmin: boolean; projectId: string; framework: FrameworkId; env: string }

export async function guardReadiness(req: NextRequest, params: { id: string; framework?: string }, opts: { adminOnly?: boolean; limitKey?: string } = {}): Promise<ReadinessCaller | { response: NextResponse }> {
  const identity = extractIdentity(req);
  if (!identity) return { response: unauthorized() };
  if (params.framework !== undefined && !isFramework(params.framework)) return { response: notFound('Framework') };
  if (opts.limitKey) {
    const rl = await checkRateLimit(`${identity.userId}:${opts.limitKey}`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
    if (!rl.allowed) return { response: tooManyRequests(rl.retryAfterSeconds) };
  }
  const access = await requireProjectAccess(req, identity.userId, params.id, { adminOnly: opts.adminOnly });
  if ('response' in access) return access;
  const env = req.nextUrl.searchParams.get('env') ?? 'production';
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(env)) return { response: badRequest('Unknown environment.') };
  return {
    userId: identity.userId, email: identity.email ?? identity.userId, orgId: access.orgId, role: access.role, isAdmin: access.role === 'owner' || access.role === 'admin',
    projectId: params.id, framework: (params.framework ?? 'soc2') as FrameworkId, env,
  };
}
