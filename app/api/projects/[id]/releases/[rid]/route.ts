/**
 * GET /api/projects/[id]/releases/[rid] — where a release is: its steps, what was created, the last lines of progress and, while it waits for secrets,
 * which ones are still missing (names only).
 */
import { NextRequest } from 'next/server';
import { ok, internalError } from '@/lib/api/response';
import { PgReleaseStore } from '@/lib/deploy/project/pgReleaseStore';
import { findRelease, publicRelease, releaseGate } from '@/lib/deploy/project/routeGate';
import { missingSecrets, reconcileDestroyed } from '@/lib/deploy/project/orchestrator';
import { releaseDriverFor } from '@/lib/deploy/project/accountOps';
import { APPLY_WORKER, workerStatus } from '@/lib/terraform/execution/applyProgress';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const { id: projectId, rid } = await params;
    const gate = await releaseGate(req, projectId);
    if (!gate.ok) return gate.response;
    const store = new PgReleaseStore();
    const found = await findRelease(store, gate, rid);
    if (!('id' in found)) return found;
    // After a teardown the page asks (?reconcile=1): the releases that ran in a resource group that is gone are marked destroyed, as Azure says, not as the caller says.
    if (req.nextUrl.searchParams.get('reconcile') === '1' && found.outputs && found.status !== 'destroyed') {
      try { await reconcileDestroyed({ store, driver: await releaseDriverFor(found) }, found); } catch { /* the next look tries again */ }
      const fresh = await store.get(found.id);
      if (fresh) Object.assign(found, fresh);
    }
    let missing: string[] | null = null;
    if (found.status === 'waiting' && found.outputs) {
      try { missing = await missingSecrets(found, await releaseDriverFor(found)); } catch { missing = null; }
    }
    return ok({ release: publicRelease(found), missing, worker: workerStatus(APPLY_WORKER) });
  } catch (err) {
    console.error('[GET /api/projects/:id/releases/:rid]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
