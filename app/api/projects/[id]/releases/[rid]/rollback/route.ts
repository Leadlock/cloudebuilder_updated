/**
 * POST /api/projects/[id]/releases/[rid]/rollback — put an earlier release that succeeded back on the VM. Body: { confirm: true }.
 *
 * [rid] is the release to put back. Nothing is planned or built: its image tag and compose file are written to the VM again, the service is restarted and the
 * address is checked, by the same worker and with the same safeguards as any release. Nothing about the infrastructure changes.
 */
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { created, internalError, apiError, parseBody } from '@/lib/api/response';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { acquireProjectLock, releaseProjectLock } from '@/lib/terraform/execution/projectLock';
import { enqueueReleaseJob } from '@/lib/jobs/projectReleaseJob';
import { PgReleaseStore } from '@/lib/deploy/project/pgReleaseStore';
import { findRelease, publicRelease, releaseGate } from '@/lib/deploy/project/routeGate';
import { createRollbackRelease, ReleaseError } from '@/lib/deploy/project/orchestrator';

export const dynamic = 'force-dynamic';

const Body = z.object({ confirm: z.literal(true) }).strict();

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const { id: projectId, rid } = await params;
    const gate = await releaseGate(req, projectId);
    if (!gate.ok) return gate.response;
    const { identity, orgId } = gate;
    const store = new PgReleaseStore();
    const found = await findRelease(store, gate, rid);
    if (!('id' in found)) return found;
    const parsed = await parseBody(req, Body);
    if (!parsed.ok) return parsed.response;

    if (!acquireProjectLock(projectId)) return apiError('CONFLICT', 'Another Terraform run or release is already going for this project. Wait for it to finish.', 409);
    try {
      const rollback = await createRollbackRelease(store, { targetId: found.id, newId: randomUUID(), orgId, projectId, createdBy: identity.userId, now: Date.now() });
      await store.save(rollback);
      const jobId = await enqueueReleaseJob({ releaseId: rollback.id, orgId, projectId, requestedBy: identity.userId });
      await recordTerraformAudit({ action: 'release', outcome: 'allowed', orgId, projectId, userId: identity.userId, detail: `release ${rollback.id} puts release ${found.id} (${found.imageTag}) back` });
      return created({ release: publicRelease(rollback), jobId });
    } catch (err) {
      releaseProjectLock(projectId);
      if (err instanceof ReleaseError) return apiError(err.status === 404 ? 'NOT_FOUND' : 'CONFLICT', err.message, err.status);
      throw err;
    }
  } catch (err) {
    console.error('[POST /api/projects/:id/releases/:rid/rollback]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
