/**
 * POST /api/projects/[id]/terraform/unlock — look at, and (when it is provably safe) release, a Terraform state lock
 * that an interrupted run left behind.
 *
 *   action "inspect"  who holds the lock, since when, and whether CloudCraft is willing to release it (changes nothing)
 *   action "release"  releases the lock with the given id, after re-checking that it is still that lock and still safe
 *
 * Same access rules as plan/apply/destroy. The safety rules themselves live in lib/terraform/execution/lockRelease.ts.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { StateBackendSchema } from '@/lib/terraform/execution/backendSchema';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, apiError, tooManyRequests, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { inspectStateLock, releaseStateLock } from '@/lib/terraform/execution/lockRelease';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { TerraformNotInstalledError } from '@/lib/terraform/execution/cli';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';

export const dynamic = 'force-dynamic';

const RequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect'), cloudAccountId: z.string().min(1), stateBackend: StateBackendSchema }),
  z.object({ action: z.literal('release'), cloudAccountId: z.string().min(1), stateBackend: StateBackendSchema, lockId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'Invalid lock id') }),
]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required');
    if (identity.role !== 'admin') return forbidden('Access denied: only Administrators can inspect or release state locks.');

    const { id: projectId } = await params;
    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const denied = await terraformExecutionDenied(identity.userId, orgId);
    if (denied) {
      await recordTerraformAudit({ action: 'unlock', outcome: 'denied', orgId, projectId, userId: identity.userId, detail: denied });
      return forbidden(denied);
    }
    const rl = checkRateLimit(`${identity.userId}:terraform-unlock`, 20, 10 * 60_000);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const ctx = await resolveArchitecture(projectId, orgId, 'production');
    if ('error' in ctx && ctx.error === 'project_not_found') return notFound('Project');

    const target = { orgId, projectId, cloudAccountId: body.cloudAccountId, stateBackend: body.stateBackend as TerraformStateBackendConfig };

    if (body.action === 'inspect') {
      const inspection = await inspectStateLock(target);
      await recordTerraformAudit({ action: 'unlock', outcome: 'requested', orgId, projectId, userId: identity.userId, detail: inspection.locked ? `lock ${inspection.lock?.id ?? '?'} checked (${inspection.releasable ? 'releasable' : 'not releasable'})` : 'state is not locked' });
      return ok(inspection);
    }

    try {
      await releaseStateLock({ ...target, lockId: body.lockId });
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      const message = err instanceof Error ? err.message : 'Could not release the lock';
      await recordTerraformAudit({ action: 'unlock', outcome: 'blocked', orgId, projectId, userId: identity.userId, detail: `${body.lockId}: ${message}` });
      if (statusCode === 409) return apiError('CONFLICT', message, 409);
      throw err;
    }
    await recordTerraformAudit({ action: 'unlock', outcome: 'succeeded', orgId, projectId, userId: identity.userId, detail: `released lock ${body.lockId}` });
    return ok({ released: true });
  } catch (err) {
    if (err instanceof TerraformNotInstalledError) return badRequest(err.message);
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const message = err instanceof Error ? err.message : 'Lock check failed';
    if (statusCode === 404) return notFound(message);
    console.error('[POST /api/projects/:id/terraform/unlock]', message.slice(0, 500));
    return internalError(message.slice(0, 2000));
  }
}
