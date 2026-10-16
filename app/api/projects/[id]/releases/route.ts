/**
 * POST /api/projects/[id]/releases — plan the deployment of a whole project (Frontend, Backend, API, Database) to an Azure VM from inside CloudCraft.
 * GET  /api/projects/[id]/releases?environment=... — the releases of this project's environment, newest first.
 *
 * Planning is read-only: the deployment files are generated HERE from the project's settings (the browser never supplies files), their Terraform is
 * planned against the connected account, and the plan is stored for approval exactly like any Terraform plan (same hash, same confirmation, same
 * single-use approval). Nothing is created in the cloud until the release is run (.../releases/[rid]/run).
 * See docs/IN_APP_DEPLOYMENT_DESIGN.md.
 */
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { ok, created, forbidden, internalError, badRequest, tooManyRequests, parseBody } from '@/lib/api/response';
import { StateBackendSchema } from '@/lib/terraform/execution/backendSchema';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { planLimit, planRateKey } from '@/lib/terraform/execution/limits';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { PlanGuardrailError } from '@/lib/terraform/execution/planGuardrails';
import { PlanBlockedError } from '@/lib/terraform/execution/TerraformExecutionService';
import { TerraformNotInstalledError } from '@/lib/terraform/execution/cli';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';
import { coerceProject, ProjectInputError } from '@/lib/deploy/project/projectInput';
import { BundleError } from '@/lib/deploy/project/bundle';
import { planRelease } from '@/lib/deploy/project/infra';
import { PgSourceStore } from '@/lib/deploy/project/sourceStore';
import { readZip, ZipError } from '@/lib/deploy/project/zip';
import type { SourceInput } from '@/lib/deploy/project/bundle';
import { newRelease } from '@/lib/deploy/project/orchestrator';
import { PgReleaseStore } from '@/lib/deploy/project/pgReleaseStore';
import { publicRelease, releaseGate } from '@/lib/deploy/project/routeGate';

export const dynamic = 'force-dynamic';

const Body = z.object({
  environment: z.string().min(1).max(40).default('production'),
  cloudAccountId: z.string().min(1).max(200),
  stateBackend: StateBackendSchema,
  /** The project's settings. Checked and rebuilt from the project's own defaults by coerceProject; secrets never travel here. */
  project: z.unknown(),
  /** Uploaded code per service built from it: the ids POST .../releases/sources returned. */
  sources: z.record(z.string(), z.string().min(1).max(100)).refine((r) => Object.keys(r).every((k) => ['frontend', 'backend', 'api'].includes(k)), 'Uploaded code can be given for frontend, backend or api only').optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const gate = await releaseGate(req, projectId);
    if (!gate.ok) return gate.response;
    const { identity, orgId } = gate;

    const parsed = await parseBody(req, Body);
    if (!parsed.ok) return parsed.response;
    const { environment, cloudAccountId, stateBackend } = parsed.data;

    let project;
    try { project = coerceProject(parsed.data.project); }
    catch (err) { return badRequest(err instanceof ProjectInputError ? err.message : 'The project settings are not valid.'); }

    // A plan runs terraform on the server; keep it from being used as a resource-exhaustion lever.
    const { limit, windowMs } = planLimit();
    const rl = await checkRateLimit(planRateKey(identity.userId), limit, windowMs);
    if (!rl.allowed) {
      await recordTerraformAudit({ action: 'release', outcome: 'denied', orgId, projectId, userId: identity.userId, detail: 'rate limited' });
      return tooManyRequests(rl.retryAfterSeconds);
    }

    // Uploaded code: it must be this project's, for that service, and not expired. Its bytes are read again here with the same checks as at upload.
    const own: Record<string, SourceInput> = {};
    const refs: Record<string, { id: string; sha256: string }> = {};
    for (const [layer, id] of Object.entries(parsed.data.sources ?? {})) {
      const stored = await new PgSourceStore().get(id);
      if (!stored || stored.orgId !== orgId || stored.projectId !== projectId || stored.layer !== layer) return badRequest(`The uploaded code for the ${layer} was not found or has expired. Upload it again.`);
      try { own[layer] = { sha256: stored.sha256, files: readZip(stored.zip).files }; } catch (err) { return badRequest(`The uploaded code for the ${layer} cannot be used: ${err instanceof ZipError ? err.message : 'it could not be read'}`); }
      refs[layer] = { id, sha256: stored.sha256 };
    }

    const store = new PgReleaseStore();
    try {
      const { bundle, plan } = await planRelease({
        projectId, orgId, environment, cloudAccountId, stateBackend: stateBackend as TerraformStateBackendConfig, project, sources: own,
        user: { id: identity.userId, name: 'Cloud Administrator', email: identity.email ?? 'admin@cloudcraft.io', role: identity.role ?? 'admin' },
      });
      const previous = await store.latestSucceeded(projectId, environment);
      const release = newRelease({
        id: randomUUID(), orgId, projectId, environment, cloudAccountId, project, bundle, createdBy: identity.userId,
        previousReleaseId: previous?.id ?? null, planId: plan.planId, planHash: plan.planHash, sources: refs, now: Date.now(),
      });
      await store.save(release);
      await recordTerraformAudit({ action: 'release', outcome: 'requested', orgId, projectId, userId: identity.userId, planId: plan.planId, planHash: plan.planHash, detail: `release ${release.id} planned: ${plan.summary.toAdd} to add, ${plan.summary.toChange} to change` });
      return created({
        release: publicRelease(release),
        plan: { planId: plan.planId, planHash: plan.planHash, summary: plan.summary, expiresAt: plan.expiresAt },
        cost: bundle.cost, warnings: bundle.warnings,
      });
    } catch (err) {
      if (err instanceof BundleError) return badRequest(err.message, { errors: err.errors });
      if (err instanceof PlanGuardrailError) { await recordTerraformAudit({ action: 'release', outcome: 'blocked', orgId, projectId, userId: identity.userId, detail: err.message }); return badRequest(err.message, { guardrails: err.report }); }
      if (err instanceof PlanBlockedError) { await recordTerraformAudit({ action: 'release', outcome: 'blocked', orgId, projectId, userId: identity.userId, detail: err.message }); return badRequest(err.message); }
      if (err instanceof TerraformNotInstalledError) return internalError(err.message);
      const statusCode = (err as { statusCode?: number })?.statusCode;
      const message = err instanceof Error ? err.message : 'Planning the release failed';
      if (statusCode === 403) return forbidden(message);
      if (statusCode) return badRequest(message);
      throw err;
    }
  } catch (err) {
    console.error('[POST /api/projects/:id/releases]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const gate = await releaseGate(req, projectId);
    if (!gate.ok) return gate.response;
    const environment = req.nextUrl.searchParams.get('environment') ?? 'production';
    const releases = await new PgReleaseStore().list(projectId, environment, 20);
    return ok({ releases: releases.filter((r) => r.orgId === gate.orgId).map(publicRelease) });
  } catch (err) {
    console.error('[GET /api/projects/:id/releases]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
