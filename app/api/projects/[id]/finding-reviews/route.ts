/**
 * /api/projects/[id]/finding-reviews
 *
 * GET  — list review decisions (accepted risk / false positive / not applicable).
 * POST — record a review decision for a finding that currently exists.
 *
 * A review never changes the technical evaluation: the finding keeps its
 * FAIL/WARNING status and still counts against the score; the review is shown
 * alongside it. Governance:
 *  - the finding's severity is determined server-side from the persisted
 *    architecture (never trusted from the client);
 *  - CRITICAL and HIGH findings can only be reviewed by org owners/admins;
 *  - a reason is always required; ACCEPTED_RISK requires an expiry ≤ 365 days.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { findingReviewRepository } from '@/lib/repositories/findingReviewRepository';
import { toCanvas } from '@/lib/domain/canvasMapping';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';

export const dynamic = 'force-dynamic';

const ADMIN_ROLES = new Set(['owner', 'admin']);
const MAX_EXPIRY_DAYS = 365;

const CreateSchema = z.object({
  env: z.string().optional().default('production'),
  findingId: z.string().min(3).max(120),
  status: z.enum(['ACCEPTED_RISK', 'FALSE_POSITIVE', 'NOT_APPLICABLE']),
  reason: z.string().trim().min(10, 'Provide a justification of at least 10 characters').max(2000),
  expiresAt: z.string().datetime().optional(),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    if (!(await getOrgRole(identity.userId, orgId))) return forbidden();
    const ctx = await resolveArchitecture(projectId, orgId, req.nextUrl.searchParams.get('env') ?? 'production');
    if ('error' in ctx && ctx.error === 'project_not_found') return notFound('Project');
    const reviews = await findingReviewRepository.listForProject(projectId, true).catch(() => []);
    return ok({ reviews });
  } catch (err) {
    console.error('[GET finding-reviews]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;
    const parsed = await parseBody(req, CreateSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const ctx = await resolveArchitecture(projectId, orgId, body.env);
    if ('error' in ctx) return ctx.error === 'project_not_found' ? notFound('Project') : badRequest('No saved architecture to review against.');

    const { nodes, edges } = toCanvas(ctx.arch.resources, ctx.arch.connections);
    const finding = runAssessment({ nodes, edges }).findings.find((f) => f.findingId === body.findingId);
    if (!finding) return notFound('Finding (it is not present in the saved architecture)');

    if ((finding.severity === 'CRITICAL' || finding.severity === 'HIGH') && !ADMIN_ROLES.has(role)) {
      return forbidden(`${finding.severity} findings can only be reviewed by an organization owner or admin.`);
    }

    const now = new Date();
    if (body.status === 'ACCEPTED_RISK') {
      if (!body.expiresAt) return badRequest('Accepted risk requires a review/expiry date.');
      const exp = new Date(body.expiresAt);
      if (exp <= now) return badRequest('Expiry date must be in the future.');
      if (exp.getTime() - now.getTime() > MAX_EXPIRY_DAYS * 86400_000) return badRequest(`Expiry must be within ${MAX_EXPIRY_DAYS} days.`);
    }

    const review = await findingReviewRepository.create({
      projectId,
      findingId: finding.findingId,
      ruleId: finding.ruleId,
      status: body.status,
      reason: body.reason,
      approvedBy: identity.email ?? identity.userId,
      approvedAt: now.toISOString(),
      expiresAt: body.expiresAt ?? null,
    });
    return created({ review, note: 'The finding remains technically failing; the review is recorded alongside it and does not change the score.' });
  } catch (err) {
    console.error('[POST finding-reviews]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
