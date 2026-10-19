/**
 * POST /api/projects/[id]/terraform/approvals/[approvalId] — approve or reject a request.
 * Body: { decision: 'approve' | 'reject', comment?: string }
 *
 * Only an owner/admin of the organisation may decide. When the server requires a second person
 * (CLOUDBUILDER_TERRAFORM_APPROVAL=required) the requester cannot approve their own request — they can still reject (withdraw) it.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, notFound, forbidden, unauthorized, internalError, apiError, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { requireProjectAccess } from '@/lib/api/projectAccess';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { approvalMode, decideApproval, getApproval } from '@/lib/terraform/execution/approvals';

export const dynamic = 'force-dynamic';

const DecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().trim().max(500).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; approvalId: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId, approvalId } = await params;
    const access = await requireProjectAccess(req, identity.userId, projectId, { adminOnly: true });
    if ('response' in access) return access.response;
    const { orgId } = access;

    const denied = await terraformExecutionDenied(identity.userId, orgId, identity.email);
    if (denied) {
      await recordTerraformAudit({ action: 'approval', outcome: 'denied', orgId, projectId, userId: identity.userId, detail: denied });
      return forbidden(denied);
    }

    if (approvalMode() === 'password') return apiError('BAD_REQUEST', 'This server confirms with a password instead of approvals from other people.', 400);

    const parsed = await parseBody(req, DecisionSchema);
    if (!parsed.ok) return parsed.response;
    const { decision, comment } = parsed.data;

    // The request must belong to THIS project (a request id alone must never let someone decide another project's).
    const existing = await getApproval(approvalId, orgId);
    if (!existing || existing.projectId !== projectId) return notFound('Approval request');

    const result = await decideApproval({ id: approvalId, orgId, decidedBy: identity.userId, decision, comment });
    if (!result.ok) {
      await recordTerraformAudit({ action: 'approval', outcome: 'blocked', orgId, projectId, userId: identity.userId, planId: existing.planId, planHash: existing.planHash, detail: `${decision} refused: ${result.code}` });
      if (result.code === 'own_request') return forbidden(result.reason);
      if (result.code === 'not_found') return notFound('Approval request');
      return apiError('CONFLICT', result.reason, 409);
    }
    await recordTerraformAudit({
      action: 'approval', outcome: decision === 'approve' ? 'allowed' : 'denied', orgId, projectId, userId: identity.userId,
      planId: existing.planId, planHash: existing.planHash, detail: `${existing.action} ${decision === 'approve' ? 'approved' : 'rejected'} (requested by ${existing.requestedBy})`,
    });
    return ok({ approval: result.approval });
  } catch (err) {
    console.error('[POST /api/projects/:id/terraform/approvals/:approvalId]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
