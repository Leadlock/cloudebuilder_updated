/**
 * POST /api/projects/[id]/terraform/apply — confirm and durably execute a
 * previously generated plan.
 * GET  /api/projects/[id]/terraform/apply?jobId=... — poll apply status.
 *
 * The caller must echo back the EXACT planId + planHash returned by
 * POST .../terraform/plan — this is the hash-bound re-confirmation gate:
 * approving "a plan" isn't enough, it must be THIS plan, unchanged since
 * it was shown to the admin. Apply itself is enqueued as a durable job
 * (lib/jobs/terraformApplyJob.ts) and executed by a separate worker
 * process — never run inside this request handler, since `terraform
 * apply` can take many minutes and genuinely mutates real infrastructure.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, apiError, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { acquireProjectLock, releaseProjectLock } from '@/lib/terraform/execution/projectLock';
import { resolveOrgId } from '@/lib/api/phase2d';
import { verifyPlanForApply } from '@/lib/terraform/execution/TerraformExecutionService';
import { consumeApproval, returnApproval } from '@/lib/terraform/execution/approvals';
import { enqueueApplyJob, getApplyJobStatus } from '@/lib/jobs/terraformApplyJob';
import { APPLY_WORKER, diagnoseApply, newQueuedRecord, pruneRunProgress, readRunProgress, workerStatus, writeRunProgress } from '@/lib/terraform/execution/applyProgress';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  planId: z.string().min(1),
  planHash: z.string().min(1),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required to apply infrastructure changes');
    if (identity.role !== 'admin') {
      return forbidden('Access denied: Terraform apply is strictly restricted to Administrators.');
    }

    await params; // projectId not needed directly — the plan record already carries it

    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const { planId, planHash } = parsed.data;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const denied = await terraformExecutionDenied(identity.userId, orgId, identity.email);
    if (denied) {
      await recordTerraformAudit({ action: 'apply', outcome: 'denied', orgId, userId: identity.userId, planId, planHash, detail: denied });
      return forbidden(denied);
    }

    let record;
    try {
      record = verifyPlanForApply(planId, planHash);
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode ?? 400;
      const message = err instanceof Error ? err.message : 'Plan verification failed';
      await recordTerraformAudit({ action: 'apply', outcome: 'blocked', orgId, userId: identity.userId, planId, planHash, detail: message });
      if (statusCode === 404) return notFound(message);
      return badRequest(message);
    }

    if (record.orgId !== orgId) return forbidden('Plan does not belong to this organization');

    // Two applies against the same state would race; allow one at a time per project.
    if (!acquireProjectLock(record.projectId)) {
      await recordTerraformAudit({ action: 'apply', outcome: 'blocked', orgId, projectId: record.projectId, userId: identity.userId, planId: record.planId, planHash: record.planHash, detail: 'another apply is already running for this project' });
      return apiError('CONFLICT', 'Another Terraform apply is already running for this project. Wait for it to finish.', 409);
    }

    // A plan only runs with an approval for exactly this plan (same id and hash), given by an owner/admin and not yet used.
    const approval = await consumeApproval({ orgId, projectId: record.projectId, action: 'apply', planId: record.planId, planHash: record.planHash, userId: identity.userId });
    if (!approval.ok) {
      releaseProjectLock(record.projectId);
      await recordTerraformAudit({ action: 'apply', outcome: 'blocked', orgId, projectId: record.projectId, userId: identity.userId, planId: record.planId, planHash: record.planHash, detail: `approval: ${approval.code}` });
      return apiError('APPROVAL_REQUIRED', approval.reason, 403);
    }

    const applyRunId = randomUUID();
    // Shown at once: every planned resource as queued, and (if no worker is running) why nothing is happening.
    pruneRunProgress();
    writeRunProgress(newQueuedRecord({ runId: applyRunId, orgId, projectId: record.projectId }, (record.summary.resourceChanges ?? []).map((c) => ({ address: c.address, type: c.type }))));
    let jobId: string;
    try {
      jobId = await enqueueApplyJob({
        applyRunId,
        projectId: record.projectId,
        requestedBy: identity.userId,
        planId: record.planId,
        accountId: record.cloudAccountId,
        orgId,
      });
    } catch (enqueueErr) {
      releaseProjectLock(record.projectId);
      if (approval.approval) await returnApproval(approval.approval.id).catch(() => undefined);   // the run never started: keep the approval usable
      throw enqueueErr;
    }
    await recordTerraformAudit({ action: 'apply', outcome: 'allowed', orgId, projectId: record.projectId, userId: identity.userId, planId: record.planId, planHash: record.planHash, detail: approval.approval ? `apply queued (approved by ${approval.approval.decidedBy})` : 'apply queued (approval switched off)' });

    return created({ applyRunId, jobId, status: 'pending' });
  } catch (err) {
    console.error('[POST /api/projects/:id/terraform/apply]', err instanceof Error ? err.message : err);
    return internalError();
  }
}

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const jobId = req.nextUrl.searchParams.get('jobId');
    if (!jobId) return badRequest('jobId query parameter is required');

    const status = await getApplyJobStatus(jobId);

    // Real progress comes from the run's own record, and only for a caller in the organisation that owns the run.
    const runId = req.nextUrl.searchParams.get('applyRunId');
    let progress = runId ? readRunProgress(runId) : null;
    if (progress) {
      const orgId = await resolveOrgId(req, identity.userId);
      if (!orgId || progress.orgId !== orgId) progress = null;
    }
    const worker = workerStatus(APPLY_WORKER);
    return ok({ ...status, progress, worker, diagnosis: diagnoseApply({ jobState: status.state, progress, worker }) });
  } catch (err) {
    console.error('[GET /api/projects/:id/terraform/apply]', err instanceof Error ? err.message : err);
    return internalError();
  }
}
