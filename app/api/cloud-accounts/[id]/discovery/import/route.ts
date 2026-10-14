/**
 * POST /api/cloud-accounts/[id]/discovery/import
 * Import a completed discovery run into a project's architecture canvas.
 *
 * Body: { runId: string, environmentId: string, merge?: boolean }
 */
import { NextRequest } from 'next/server';
import { refuseRestrictedFeature } from '@/lib/api/restrictedFeatureGuard';
import { z } from 'zod';
import {
  ok, notFound, forbidden, unauthorized, internalError, parseBody, badRequest,
} from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { resolveEnvironmentInOrg } from '@/lib/api/tenantScope';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { discoveryRepository } from '@/lib/repositories/discoveryRepository';
import { discoveryImportService } from '@/lib/services/DiscoveryImportService';

export const dynamic = 'force-dynamic';

const ImportSchema = z.object({
  runId:         z.string().min(1),
  environmentId: z.string().min(1),
  merge:         z.boolean().optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const closed = refuseRestrictedFeature(identity.email);
    if (closed) return closed;

    const { id } = await ctx.params;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return forbidden();

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    // Verify cloud account belongs to this org (isolation)
    const account = await cloudAccountRepository.findById(id, orgId);
    if (!account) return notFound('CloudAccount');

    const parsed = await parseBody(req, ImportSchema);
    if (!parsed.ok) return parsed.response;
    const { runId, environmentId: requestedEnvironment, merge } = parsed.data;

    // The target must be in THIS organisation: an environment id alone must never let a caller overwrite someone else's canvas.
    const target = await resolveEnvironmentInOrg(requestedEnvironment, orgId);
    if (!target) return notFound('Environment');
    const environmentId = target.environmentId;

    // Verify run belongs to this account
    const run = await discoveryRepository.findById(runId);
    if (!run || run.cloudAccountId !== id) return notFound('DiscoveryRun');
    if (run.status !== 'completed') {
      return badRequest(`Discovery run is not completed (status: ${run.status})`);
    }

    const result = await discoveryImportService.importRun(runId, environmentId, merge ?? false);
    if (!result) return notFound('DiscoveryRun or environment');

    return ok({
      resourceCount: result.resourceCount,
      summary: result.summary,
      nodeCount: result.nodes.length,
      nodes: result.nodes,
      edges: result.edges,
    });
  } catch (err) {
    console.error(
      '[POST /api/cloud-accounts/[id]/discovery/import]',
      err instanceof Error ? err.message : String(err),
    );
    return internalError();
  }
}
