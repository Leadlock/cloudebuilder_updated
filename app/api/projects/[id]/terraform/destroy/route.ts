/**
 * POST /api/projects/[id]/terraform/destroy — destroy/teardown real infrastructure
 * associated with this project and remote state backend.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { StateBackendSchema } from '@/lib/terraform/execution/backendSchema';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';

import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { executeDestroy } from '@/lib/terraform/execution/TerraformExecutionService';
import { TerraformNotInstalledError } from '@/lib/terraform/execution/cli';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  environment: z.string().default('production'),
  cloudAccountId: z.string().min(1),
  stateBackend: StateBackendSchema,
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required to destroy infrastructure');
    if (identity.role !== 'admin') {
      return forbidden('Access denied: Infrastructure teardown is strictly restricted to Administrators.');
    }

    const { id: projectId } = await params;
    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const { environment, cloudAccountId, stateBackend } = parsed.data;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const denied = await terraformExecutionDenied(identity.userId, orgId);
    if (denied) {
      await recordTerraformAudit({ action: 'destroy', outcome: 'denied', orgId, projectId, userId: identity.userId, detail: denied });
      return forbidden(denied);
    }
    await recordTerraformAudit({ action: 'destroy', outcome: 'requested', orgId, projectId, userId: identity.userId });

    const ctx = await resolveArchitecture(projectId, orgId, environment);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      if (ctx.error === 'architecture_not_found') return badRequest('No saved architecture to destroy for this environment');
      return notFound('Environment');
    }
    const { arch, project } = ctx;

    const user = {
      id: identity.userId,
      email: identity.email ?? 'admin@cloudcraft.io',
      name: 'Cloud Administrator',
      role: identity.role,
    };

    const result = await executeDestroy({
      projectId,
      orgId,
      environment,
      cloudAccountId,
      stateBackend: stateBackend as TerraformStateBackendConfig,
      user,
      resources: arch.resources,
      connections: arch.connections,
      architectureId: arch.id,
      projectName: project.name.replace(/\s+/g, '-').toLowerCase(),
    });

    await recordTerraformAudit({ action: 'destroy', outcome: 'succeeded', orgId, projectId, userId: identity.userId });
    return ok({
      status: 'success',
      message: result.message,
      outputTail: result.outputTail,
    });
  } catch (err) {
    if (err instanceof TerraformNotInstalledError) {
      return badRequest(err.message);
    }
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 403) return forbidden(err instanceof Error ? err.message : 'Forbidden');
    if (statusCode === 404) return notFound(err instanceof Error ? err.message : 'Resource not found');
    if (statusCode === 400) return badRequest(err instanceof Error ? err.message : 'Bad request');

    console.error('[POST /api/projects/:id/terraform/destroy]', err instanceof Error ? err.message : err);
    return internalError(err instanceof Error ? err.message : 'Teardown execution failed');
  }
}
