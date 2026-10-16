/**
 * POST /api/projects/[id]/releases/[rid]/run — start a planned release, or continue one that is waiting for secrets or failed after the infrastructure.
 *
 * A planned release only runs with an approval for exactly its plan (same id and hash, single use, given by an owner/admin), the same rule as any Terraform
 * apply: the approval is the one from POST .../terraform/confirm for this release's planId and planHash. The release then runs in the worker.
 */
import { NextRequest } from 'next/server';
import { created, forbidden, internalError, apiError, notFound, badRequest } from '@/lib/api/response';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { acquireProjectLock, releaseProjectLock } from '@/lib/terraform/execution/projectLock';
import { verifyPlanForApply } from '@/lib/terraform/execution/TerraformExecutionService';
import { consumeApproval, returnApproval } from '@/lib/terraform/execution/approvals';
import { enqueueReleaseJob } from '@/lib/jobs/projectReleaseJob';
import { PgReleaseStore } from '@/lib/deploy/project/pgReleaseStore';
import { findRelease, releaseGate } from '@/lib/deploy/project/routeGate';
import { approveRelease, ReleaseError } from '@/lib/deploy/project/orchestrator';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const { id: projectId, rid } = await params;
    const gate = await releaseGate(req, projectId);
    if (!gate.ok) return gate.response;
    const { identity, orgId } = gate;
    const store = new PgReleaseStore();
    const found = await findRelease(store, gate, rid);
    if (!('id' in found)) return found;
    const release = found;
    const audit = { action: 'release' as const, orgId, projectId, userId: identity.userId, planId: release.planId, planHash: release.planHash };

    const job = { releaseId: release.id, orgId, projectId, requestedBy: identity.userId };

    if (release.status === 'planned') {
      if (!release.planId || !release.planHash) return badRequest('This release has no plan.');
      let record;
      try { record = verifyPlanForApply(release.planId, release.planHash); }
      catch (err) {
        const message = err instanceof Error ? err.message : 'Plan verification failed';
        await recordTerraformAudit({ ...audit, outcome: 'blocked', detail: message });
        return (err as { statusCode?: number })?.statusCode === 404 ? notFound(message) : badRequest(message);
      }
      if (record.orgId !== orgId || record.projectId !== projectId) return forbidden('Plan does not belong to this project');
      // Two runs against the same state would race; one at a time per project.
      if (!acquireProjectLock(projectId)) {
        await recordTerraformAudit({ ...audit, outcome: 'blocked', detail: 'another run is already going for this project' });
        return apiError('CONFLICT', 'Another Terraform run or release is already going for this project. Wait for it to finish.', 409);
      }
      const approval = await consumeApproval({ orgId, projectId, action: 'apply', planId: release.planId, planHash: release.planHash, userId: identity.userId });
      if (!approval.ok) {
        releaseProjectLock(projectId);
        await recordTerraformAudit({ ...audit, outcome: 'blocked', detail: `approval: ${approval.code}` });
        return apiError('APPROVAL_REQUIRED', approval.reason, 403);
      }
      try {
        await approveRelease(store, release.id, { bundleHash: release.bundleHash, planHash: release.planHash }, Date.now());
        const jobId = await enqueueReleaseJob(job);
        await recordTerraformAudit({ ...audit, outcome: 'allowed', detail: `release ${release.id} queued${approval.approval ? ` (approved by ${approval.approval.decidedBy})` : ' (approval switched off)'}` });
        return created({ releaseId: release.id, jobId, status: 'approved' });
      } catch (err) {
        releaseProjectLock(projectId);
        if (approval.approval) await returnApproval(approval.approval.id).catch(() => undefined);   // the run never started: keep the approval usable
        const fresh = await store.get(release.id);
        if (fresh && fresh.status === 'approved') { fresh.status = 'planned'; fresh.updatedAt = Date.now(); await store.save(fresh); }
        if (err instanceof ReleaseError) return apiError('CONFLICT', err.message, err.status);
        throw err;
      }
    }

    if (release.status === 'waiting' || release.status === 'failed') {
      const infra = release.steps.find((s) => s.name === 'infrastructure');
      if (infra?.state !== 'done') return apiError('CONFLICT', 'The infrastructure was not created, and its plan is used up. Plan the release again.', 409);
      if (!acquireProjectLock(projectId)) return apiError('CONFLICT', 'Another Terraform run or release is already going for this project. Wait for it to finish.', 409);
      try {
        const jobId = await enqueueReleaseJob(job);
        await recordTerraformAudit({ ...audit, outcome: 'allowed', detail: `release ${release.id} continued from ${release.steps.find((s) => s.state !== 'done' && s.state !== 'skipped')?.name ?? 'the end'}` });
        return created({ releaseId: release.id, jobId, status: release.status });
      } catch (err) { releaseProjectLock(projectId); throw err; }
    }

    return apiError('CONFLICT', `This release is ${release.status}; it cannot be run.`, 409);
  } catch (err) {
    console.error('[POST /api/projects/:id/releases/:rid/run]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
