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
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { verifyPlanForApply } from '@/lib/terraform/execution/TerraformExecutionService';
import { enqueueApplyJob, getApplyJobStatus } from '@/lib/jobs/terraformApplyJob';
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

    let record;
    try {
      record = verifyPlanForApply(planId, planHash);
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode ?? 400;
      const message = err instanceof Error ? err.message : 'Plan verification failed';
      if (statusCode === 404) return notFound(message);
      return badRequest(message);
    }

    if (record.orgId !== orgId) return forbidden('Plan does not belong to this organization');

    const applyRunId = randomUUID();
    const jobId = await enqueueApplyJob({
      applyRunId,
      planId: record.planId,
      accountId: record.cloudAccountId,
      orgId,
    });

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
    return ok(status);
  } catch (err) {
    console.error('[GET /api/projects/:id/terraform/apply]', err instanceof Error ? err.message : err);
    return internalError();
  }
}
