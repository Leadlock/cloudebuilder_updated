/**
 * /api/projects/[id]/security-scans
 *
 * POST — run the assessment engine against the PERSISTED architecture for the
 *        environment and store an immutable, revision-bound snapshot.
 * GET  — list previous scans (history) for the project/environment.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, parseBody, tooManyRequests } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import { buildSnapshot, persistSnapshot, loadActiveReviews, listSnapshots } from '@/lib/services/AssessmentSnapshotService';
import { findingToIssue } from '@/lib/analysis';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  env:       z.string().optional().default('production'),
  versionId: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const rl = await checkRateLimit(`${identity.userId}:security-scans`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const { id: projectId } = await params;

    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const ctx = await resolveArchitecture(projectId, orgId, body.env);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      if (ctx.error === 'architecture_not_found') {
        return ok({ findings: [], score: null, scanId: null, assessment: null, message: 'No architecture saved yet — nothing was evaluated.' });
      }
      return notFound('Environment');
    }

    const reviews = await loadActiveReviews(projectId);
    const snapshot = buildSnapshot({
      project: { id: projectId, name: ctx.project.name, environment: body.env, region: ctx.project.region },
      arch: ctx.arch,
      createdBy: identity.userId,
      reviews,
    });
    const persisted = await persistSnapshot(snapshot);
    const a = snapshot.assessment;
    const security = a.findings.filter((f) => f.domain === 'SECURITY');

    return created({
      scanId: persisted ? snapshot.scanId : null,
      persisted,
      architectureId: snapshot.architecture.architectureId,
      architectureRevision: snapshot.architecture.revision,
      graphHash: snapshot.architecture.graphHash,
      rulesetVersion: a.rulesetVersion,
      score: a.securityScore.score,
      securityScore: a.securityScore,
      findingCount: security.length,
      findings: security.map((f) => ({ ...findingToIssue(f), title: f.title, description: f.description, resourceId: f.resourceIds[0] ?? null, provider: f.provider })),
      assessment: a,
      createdAt: snapshot.createdAt,
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/security-scans]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;
    const env = req.nextUrl.searchParams.get('env') ?? 'production';

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const ctx = await resolveArchitecture(projectId, orgId, env);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      return ok({ scans: [] });
    }
    const scans = await listSnapshots(projectId, ctx.arch.id).catch(() => []);
    return ok({ scans, currentRevision: ctx.arch.revision });
  } catch (err) {
    console.error('[GET /api/projects/:id/security-scans]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
