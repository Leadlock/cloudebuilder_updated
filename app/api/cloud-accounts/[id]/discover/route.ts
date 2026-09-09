/**
 * POST /api/cloud-accounts/[id]/discover — trigger a discovery run
 *
 * Security:
 * - Credentials are loaded server-side; never in the request body.
 * - Discovery result (resources) contains no credentials.
 * - Org isolation is enforced before any credential access.
 *
 * ⚠ RELIABILITY LIMITATION (known, not yet resolved):
 * Discovery executes as an unawaited Promise ("fire-and-forget") inside a
 * Next.js Serverless/Edge Function request handler.
 *
 * This is NOT production-safe because:
 *  1. The Node.js runtime may be frozen or evicted after the HTTP response is
 *     sent, terminating the background Promise mid-flight before it can write
 *     results to the database.
 *  2. There is no retry mechanism; a transient AWS/Azure error leaves the run
 *     permanently in the "running" state with no way to resume it.
 *  3. No back-pressure or concurrency cap — many simultaneous discovery
 *     triggers will run all at once with no queue.
 *
 * Production fix (Phase 3):
 *  Replace runDiscoveryAsync with a durable job queue (e.g. pg-boss, BullMQ,
 *  or a dedicated worker process) so that the job is persisted before the
 *  HTTP response is returned and is guaranteed to complete independently of
 *  the web process lifecycle.
 *
 * Until that migration is done, this endpoint is safe for development and
 * low-concurrency internal use only.
 */
import { NextRequest } from 'next/server';
import {
  ok, created, notFound, forbidden, unauthorized, internalError,
} from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { discoveryRepository } from '@/lib/repositories/discoveryRepository';
import { createDiscoveryProvider } from '@/lib/cloud/provider';
import type { CloudCredentials } from '@/lib/cloud/types';

export const dynamic = 'force-dynamic';

async function resolveOrgId(req: NextRequest): Promise<string> {
  const orgId = req.nextUrl.searchParams.get('orgId') ?? '';
  if (orgId) return orgId;
  if (process.env.NODE_ENV === 'development') {
    const ctx = await orgRepository.ensureDevContext();
    return ctx.orgId;
  }
  return '';
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id } = await ctx.params;
    const orgId = await resolveOrgId(req);
    if (!orgId) return forbidden();

    // Authorization check: must be org member
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    // Verify account belongs to this org (org isolation)
    const account = await cloudAccountRepository.findById(id, orgId);
    if (!account) return notFound('CloudAccount');

    // Load credentials server-side — never returned
    const credentialsJson = await cloudAccountRepository.getCredentials(id, orgId);
    if (!credentialsJson) return notFound('CloudAccount credentials');

    let credentials: CloudCredentials;
    try {
      credentials = JSON.parse(credentialsJson) as CloudCredentials;
    } catch {
      return internalError('Stored credentials are malformed');
    }

    // Create the run record in 'pending' state
    const run = await discoveryRepository.create(id);

    // Run discovery asynchronously — do not block the HTTP response
    // The run is persisted; client polls GET /discover for completion
    void runDiscoveryAsync(run.id, id, orgId, credentials);

    return created({ runId: run.id, status: 'pending' });
  } catch (err) {
    console.error(
      '[POST /api/cloud-accounts/[id]/discover]',
      err instanceof Error ? err.message : String(err),
    );
    return internalError();
  }
}

/**
 * Executes the discovery job and persists the result.
 * All errors are caught and persisted as failed run status.
 * Credentials are used only within this function scope.
 */
async function runDiscoveryAsync(
  runId: string,
  accountId: string,
  orgId: string,
  credentials: CloudCredentials,
): Promise<void> {
  await discoveryRepository.markRunning(runId);

  const provider = await createDiscoveryProvider(credentials);
  try {
    const result = await provider.discoverAll();

    if (result.status === 'completed') {
      await discoveryRepository.markCompleted(runId, result.resources, result.summary);
      // Update account status to active after successful discovery
      await cloudAccountRepository.updateStatus(accountId, orgId, 'active');
      console.info(
        `[Discovery] Run ${runId} completed. Account: ${accountId}. Resources: ${result.resources.length}`,
      );
    } else {
      const errorMsg = result.error ?? 'Discovery failed with unknown error';
      await discoveryRepository.markFailed(runId, errorMsg);
      console.error(`[Discovery] Run ${runId} failed. Account: ${accountId}. Error: ${errorMsg}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Log without credentials
    console.error(`[Discovery] Run ${runId} threw unexpectedly. Account: ${accountId}. Error: ${message}`);
    await discoveryRepository.markFailed(runId, message);
  } finally {
    await provider.dispose();
  }
}
