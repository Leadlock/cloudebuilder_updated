/**
 * POST /api/projects/[id]/releases/[rid]/cancel — stop a release that has not finished. A step that is already running finishes (what it did is not undone);
 * nothing after it runs. Nothing that was created is removed.
 */
import { NextRequest } from 'next/server';
import { ok, internalError, apiError } from '@/lib/api/response';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { PgReleaseStore } from '@/lib/deploy/project/pgReleaseStore';
import { findRelease, publicRelease, releaseGate } from '@/lib/deploy/project/routeGate';
import { cancelRelease, ReleaseError } from '@/lib/deploy/project/orchestrator';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const { id: projectId, rid } = await params;
    const gate = await releaseGate(req, projectId);
    if (!gate.ok) return gate.response;
    const store = new PgReleaseStore();
    const found = await findRelease(store, gate, rid);
    if (!('id' in found)) return found;
    try {
      const r = await cancelRelease(store, found.id, Date.now());
      await recordTerraformAudit({ action: 'release', outcome: 'allowed', orgId: gate.orgId, projectId, userId: gate.identity.userId, planId: r.planId, planHash: r.planHash, detail: `release ${r.id} cancelled` });
      return ok({ release: publicRelease(r) });
    } catch (err) {
      if (err instanceof ReleaseError) return apiError('CONFLICT', err.message, err.status);
      throw err;
    }
  } catch (err) {
    console.error('[POST /api/projects/:id/releases/:rid/cancel]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
