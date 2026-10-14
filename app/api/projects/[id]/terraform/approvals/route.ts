/**
 * GET  /api/projects/[id]/terraform/approvals — the approval requests for this project (any member may look).
 * POST /api/projects/[id]/terraform/approvals — ask for approval of a plan (apply) or a teardown preview (destroy).
 *
 * A plan or teardown can only run with an approval for exactly that plan (see lib/terraform/execution/approvals.ts); this is
 * how one is asked for. Another owner/admin then decides it at .../approvals/[approvalId].
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, tooManyRequests, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { requireProjectAccess } from '@/lib/api/projectAccess';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { totpEnabled } from '@/lib/api/totpStore';
import { approvalMode, requestApproval, listApprovals } from '@/lib/terraform/execution/approvals';
import { verifyPlanForApply } from '@/lib/terraform/execution/TerraformExecutionService';
import { peekPreparedDestroy } from '@/lib/terraform/execution/destroyPlans';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  action: z.enum(['apply', 'destroy']),
  planId: z.string().min(1).max(200),
  planHash: z.string().min(1).max(200),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;
    const access = await requireProjectAccess(req, identity.userId, projectId);
    if ('response' in access) return access.response;
    const approvals = await listApprovals(projectId, access.orgId);
    // Whether to ask for an authenticator code too. Unreadable counts as off here (it is only the form); the confirm route itself fails closed.
    const totp = await totpEnabled(identity.userId).catch(() => false);
    return ok({ mode: approvalMode(), you: identity.userId, totpEnabled: totp, approvals });
  } catch (err) {
    console.error('[GET /api/projects/:id/terraform/approvals]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;
    const access = await requireProjectAccess(req, identity.userId, projectId, { adminOnly: true });
    if ('response' in access) return access.response;
    const { orgId } = access;

    const denied = await terraformExecutionDenied(identity.userId, orgId, identity.email);
    if (denied) {
      await recordTerraformAudit({ action: 'approval', outcome: 'denied', orgId, projectId, userId: identity.userId, detail: denied });
      return forbidden(denied);
    }
    if (approvalMode() === 'off') return badRequest('Approval is switched off on this server, so there is nothing to request.');
    if (approvalMode() === 'password') return badRequest('This server confirms with your password instead of an approval request. Use Confirm with password.');

    const rl = await checkRateLimit(`${identity.userId}:terraform-approval`, 30, 10 * 60_000);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const { action, planId, planHash } = parsed.data;

    // The request must be for a plan that really exists, in this project and organisation, and is unchanged.
    let summary: string;
    if (action === 'apply') {
      let record;
      try { record = verifyPlanForApply(planId, planHash); } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode ?? 400;
        const message = err instanceof Error ? err.message : 'Plan verification failed';
        return statusCode === 404 ? notFound(message) : badRequest(message);
      }
      if (record.orgId !== orgId || record.projectId !== projectId) return notFound('Plan');
      summary = `${record.summary.toAdd} to add, ${record.summary.toChange} to change, ${record.summary.toDestroy} to destroy`;
    } else {
      const prepared = peekPreparedDestroy(planId);
      if (!prepared || prepared.orgId !== orgId || prepared.projectId !== projectId) return notFound('The teardown preview has expired. Preview it again.');
      if (prepared.planHash !== planHash) return badRequest('The teardown preview changed. Preview it again.');
      summary = `Tear down ${prepared.resources.length} resource(s) in the ${prepared.environment} state`;
    }

    const { approval, created: isNew } = await requestApproval({ orgId, projectId, action, planId, planHash, requestedBy: identity.userId, summary });
    await recordTerraformAudit({ action: 'approval', outcome: 'requested', orgId, projectId, userId: identity.userId, planId, planHash, detail: `${action} approval ${isNew ? 'requested' : 'already open'}: ${summary}` });
    return isNew ? created({ approval }) : ok({ approval });
  } catch (err) {
    console.error('[POST /api/projects/:id/terraform/approvals]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
