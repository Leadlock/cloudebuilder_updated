/**
 * POST /api/cloud-accounts/[id]/discover — trigger a discovery run
 *
 * Security:
 * - Credentials are loaded server-side by the worker, never here, never in
 *   the request or response body.
 * - Discovery result (resources) contains no credentials.
 * - Org isolation is enforced before any credential access.
 *
 * Reliability: discovery execution is durable. The run row is created here
 * and the job is enqueued via pg-boss (lib/jobs/discoveryJob.ts) BEFORE this
 * handler returns — the job is persisted in Postgres, not held in this
 * process's memory. A separate long-running worker process
 * (workers/discoveryWorker.ts) picks it up, with automatic retries on
 * transient failure. This survives the web process restarting or being
 * evicted after the response is sent, which a bare fire-and-forget
 * in-process Promise cannot.
 */
import { NextRequest } from 'next/server';
import {
  created, notFound, forbidden, unauthorized, internalError,
} from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { discoveryRepository } from '@/lib/repositories/discoveryRepository';
import { enqueueDiscoveryJob } from '@/lib/jobs/discoveryJob';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id } = await ctx.params;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return forbidden();

    // Authorization check: must be org member
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    // Verify account belongs to this org (org isolation)
    const account = await cloudAccountRepository.findById(id, orgId);
    if (!account) return notFound('CloudAccount');

    // Confirm credentials exist before enqueuing — the worker will load and
    // decrypt them itself when it actually processes the job.
    const credentialsJson = await cloudAccountRepository.getCredentials(id, orgId);
    if (!credentialsJson) return notFound('CloudAccount credentials');

    // Parse optional regions from body
    let regions: string[] | undefined;
    try {
      const body = await req.json();
      if (Array.isArray(body?.regions) && body.regions.length > 0) {
        regions = body.regions.map((r: unknown) => String(r).trim()).filter(Boolean);
      }
    } catch {
      // Body is optional
    }

    // Create the run record in 'pending' state
    const run = await discoveryRepository.create(id);

    // Durably enqueue the job — persisted in Postgres before we respond.
    await enqueueDiscoveryJob({ runId: run.id, accountId: id, orgId, regions });

    return created({ runId: run.id, status: 'pending' });
  } catch (err) {
    console.error(
      '[POST /api/cloud-accounts/[id]/discover]',
      err instanceof Error ? err.message : String(err),
    );
    return internalError();
  }
}
