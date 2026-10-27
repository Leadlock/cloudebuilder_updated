/**
 * PUT /api/projects/[id]/readiness/soc2/engagement   (owner or admin)
 *
 * The facts about the engagement that several parts of the report share: the CPA firm (named in the letters), the vulnerability scan and penetration-test provider and
 * frequency (so every mention agrees), and the assessment date the report is about (otherwise the day it is generated).
 */
import { NextRequest } from 'next/server';
import { ok, notFound, internalError, parseBody } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { EngagementSchema } from '@/lib/compliance/entries';
import { loadEngagement } from '@/lib/compliance/service';
import { readinessRepository } from '@/lib/repositories/readinessRepository';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params);
    if ('response' in caller) return caller.response;
    if (caller.framework !== 'soc2') return notFound('Engagement settings for this framework');
    return ok({ engagement: await loadEngagement(caller.projectId) });
  } catch (err) {
    console.error('[GET readiness engagement]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params, { adminOnly: true });
    if ('response' in caller) return caller.response;
    if (caller.framework !== 'soc2') return notFound('Engagement settings for this framework');
    const parsed = await parseBody(req, EngagementSchema);
    if (!parsed.ok) return parsed.response;
    const { assessmentDate, ...rest } = parsed.data;
    await readinessRepository.updateSettings(caller.projectId, 'soc2', { ...rest, assessmentDate: assessmentDate ?? '' }, caller.email);
    await readinessRepository.clearSignoffs(caller.projectId, 'soc2');
    return ok({ engagement: await loadEngagement(caller.projectId), signoffsCleared: true });
  } catch (err) {
    console.error('[PUT readiness engagement]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
