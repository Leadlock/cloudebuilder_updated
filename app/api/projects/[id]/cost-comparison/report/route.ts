import { NextRequest } from 'next/server';
import { z } from 'zod';
import { created, forbidden, unauthorized, badRequest, internalError, parseBody, tooManyRequests, notFound } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { addPriceReport } from '@/lib/cost/quality/priceReports';
import { projectRepository } from '@/lib/repositories/projectRepository';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  resourceId: z.string().min(1).max(200),
  resourceType: z.string().min(1).max(100),
  provider: z.string().min(1).max(20),
  region: z.string().max(60).optional().default(''),
  monthlyUsd: z.number().finite(),
  pricingTier: z.string().max(40).nullable().optional(),
  pricingSource: z.string().max(100).nullable().optional(),
  assumptions: z.array(z.string().max(300)).max(12).optional().default([]),
  note: z.string().max(500).optional().default(''),
});

/** POST: a person says one price on the comparison screen looks wrong. Stored for the team; changes nothing on screen. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const rl = await checkRateLimit(`${identity.userId}:price-report`, 20, 60 * 60 * 1000);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const { id: projectId } = await params;
    const parsed = await parseBody(req, BodySchema);
    if (!parsed.ok) return parsed.response;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    // The project must belong to the caller's organization: a report is never filed against someone else's project.
    const project = await projectRepository.findById(projectId, orgId);
    if (!project) return notFound('Project');

    const b = parsed.data;
    const report = await addPriceReport({
      orgId, projectId, userId: identity.userId, resourceId: b.resourceId, resourceType: b.resourceType, provider: b.provider, region: b.region,
      monthlyUsd: b.monthlyUsd, pricingTier: b.pricingTier ?? null, pricingSource: b.pricingSource ?? null, assumptions: b.assumptions, note: b.note,
    });
    return created({ id: report.id });
  } catch (err) {
    console.error('[POST /api/projects/:id/cost-comparison/report]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
