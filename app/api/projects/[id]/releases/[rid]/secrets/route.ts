/**
 * POST /api/projects/[id]/releases/[rid]/secrets — the values a waiting release asked for. Body: { values: { NAME: "value" } }.
 *
 * Each value is written straight to the project's Key Vault with the connected account and is not kept: not in the release, not in a queue, not in a log,
 * and not in this response (which lists the names that are still missing). Only names the release is waiting for are accepted. When none is missing
 * the release is continued.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { created, internalError, apiError, badRequest, parseBody, ok } from '@/lib/api/response';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { acquireProjectLock, releaseProjectLock } from '@/lib/terraform/execution/projectLock';
import { enqueueReleaseJob } from '@/lib/jobs/projectReleaseJob';
import { PgReleaseStore } from '@/lib/deploy/project/pgReleaseStore';
import { findRelease, releaseGate } from '@/lib/deploy/project/routeGate';
import { provideSecrets, ReleaseError } from '@/lib/deploy/project/orchestrator';
import { releaseDriverFor, AccountError } from '@/lib/deploy/project/accountOps';
import { AzureError } from '@/lib/deploy/project/azureOps';
import { AwsError } from '@/lib/deploy/project/awsOps';

export const dynamic = 'force-dynamic';

const Body = z.object({ values: z.record(z.string().max(64), z.string().max(500)).refine((v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 50, 'Give between 1 and 50 values') }).strict();

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

    const audit = { action: 'release' as const, orgId, projectId, userId: identity.userId, planId: found.planId, planHash: found.planHash };
    try {
      const driver = await releaseDriverFor(found);
      const { missing } = await provideSecrets({ store, driver }, found.id, parsed.data.values);
      // Names only: never a value.
      await recordTerraformAudit({ ...audit, outcome: 'allowed', detail: `release ${found.id}: stored ${Object.keys(parsed.data.values).join(', ')}; ${missing.length === 0 ? 'none missing' : `still missing ${missing.join(', ')}`}` });
      if (missing.length > 0) return ok({ missing, continued: false });
      if (!acquireProjectLock(projectId)) return ok({ missing, continued: false, note: 'Another run is going for this project; continue the release when it has finished.' });
      try {
        const jobId = await enqueueReleaseJob({ releaseId: found.id, orgId, projectId, requestedBy: identity.userId });
        return created({ missing, continued: true, jobId });
      } catch (err) { releaseProjectLock(projectId); throw err; }
    } catch (err) {
      if (err instanceof ReleaseError) return err.status === 409 ? apiError('CONFLICT', err.message, 409) : badRequest(err.message);
      if (err instanceof AccountError) return apiError('BAD_REQUEST', err.message, err.status);
      if (err instanceof AzureError || err instanceof AwsError) return apiError('BAD_GATEWAY', err.message, 502);
      throw err;
    }
  } catch (err) {
    // The message of an unexpected error is logged, never the request: it holds the values.
    console.error('[POST /api/projects/:id/releases/:rid/secrets]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
