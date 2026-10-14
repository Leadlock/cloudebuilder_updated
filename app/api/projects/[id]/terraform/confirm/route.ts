/**
 * POST /api/projects/[id]/terraform/confirm — confirm a deploy (apply) or teardown (destroy) with your own login password.
 * Body: { action, planId, planHash, password }
 *
 * On success a single-use approval for exactly this plan is recorded, good for a few minutes; running the plan spends it.
 * Only available when the server's approval mode is "password" (the default). Only an owner/admin may confirm.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, tooManyRequests, apiError, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { requireProjectAccess } from '@/lib/api/projectAccess';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { approvalMode } from '@/lib/terraform/execution/approvals';
import { describePlanForApproval } from '@/lib/terraform/execution/approvalPlan';
import { confirmWithPassword } from '@/lib/terraform/execution/passwordConfirm';
import { verifyAccountPassword } from '@/lib/auth/verifyAccountPassword';
import { totpEnabled, verifyTotpCode } from '@/lib/api/totpStore';

export const dynamic = 'force-dynamic';

const Body = z.object({
  action: z.enum(['apply', 'destroy']),
  planId: z.string().min(1).max(200),
  planHash: z.string().min(1).max(200),
  password: z.string().min(1).max(512),
  code: z.string().trim().max(32).optional(),
}).strict();

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
    if (approvalMode() !== 'password') return badRequest('This server does not use password confirmation (CLOUDCRAFT_TERRAFORM_APPROVAL is not "password").');

    const parsed = await parseBody(req, Body);
    if (!parsed.ok) return parsed.response;
    const { action, planId, planHash, password, code } = parsed.data;

    const plan = describePlanForApproval({ orgId, projectId, action, planId, planHash });
    if (!plan.ok) return plan.status === 404 ? notFound(plan.message) : badRequest(plan.message);

    const result = await confirmWithPassword(
      { orgId, projectId, userId: identity.userId, action, planId, planHash, summary: plan.summary, password, code },
      { checkPassword: (userId, pw) => verifyAccountPassword({ userId, email: identity.email, password: pw }), totp: { enabled: totpEnabled, verify: verifyTotpCode } },
    );
    if (!result.ok) {
      await recordTerraformAudit({ action: 'approval', outcome: 'denied', orgId, projectId, userId: identity.userId, planId, planHash, detail: `${action} password confirmation refused: ${result.code}` });   // never the password
      if (result.code === 'locked') return tooManyRequests(result.retryAfterSeconds);
      if (result.code === 'wrong_password') return apiError('WRONG_PASSWORD', result.message, 403);
      if (result.code === 'unavailable') return apiError('SERVICE_UNAVAILABLE', result.message, 503);
      if (result.code === 'needs_code') return apiError('CODE_REQUIRED', result.message, 400);
      return badRequest(result.message);
    }
    await recordTerraformAudit({ action: 'approval', outcome: 'allowed', orgId, projectId, userId: identity.userId, planId, planHash, detail: `${action} confirmed with password: ${plan.summary}` });
    return ok({ approval: result.approval });
  } catch (err) {
    console.error('[POST /api/projects/:id/terraform/confirm]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
