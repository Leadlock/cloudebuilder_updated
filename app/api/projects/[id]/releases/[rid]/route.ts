/**
 * GET /api/projects/[id]/releases/[rid] — where a release is: its steps, what was created, the last lines of progress and, while it waits for secrets,
 * which ones are still missing (names only).
 */
import { NextRequest } from 'next/server';
import { ok, internalError } from '@/lib/api/response';
import { PgReleaseStore } from '@/lib/deploy/project/pgReleaseStore';
import { findRelease, publicRelease, releaseGate } from '@/lib/deploy/project/routeGate';
import { missingSecrets } from '@/lib/deploy/project/orchestrator';
import { azureOpsForAccount } from '@/lib/deploy/project/accountOps';
import { APPLY_WORKER, workerStatus } from '@/lib/terraform/execution/applyProgress';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const { id: projectId, rid } = await params;
    const gate = await releaseGate(req, projectId);
    if (!gate.ok) return gate.response;
    const found = await findRelease(new PgReleaseStore(), gate, rid);
    if (!('id' in found)) return found;
    let missing: string[] | null = null;
    if (found.status === 'waiting' && found.outputs) {
      try { missing = await missingSecrets(found, await azureOpsForAccount(found.orgId, found.cloudAccountId)); } catch { missing = null; }
    }
    return ok({ release: publicRelease(found), missing, worker: workerStatus(APPLY_WORKER) });
  } catch (err) {
    console.error('[GET /api/projects/:id/releases/:rid]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
