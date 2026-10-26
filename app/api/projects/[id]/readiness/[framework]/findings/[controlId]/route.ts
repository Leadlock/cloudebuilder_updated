/**
 * PUT /api/projects/[id]/readiness/[framework]/findings/[controlId]
 *
 * Management's side of a finding: owner, target date, status and response. Closing needs someone other than the owner (the re-test) and a written
 * response; accepting a risk needs an owner or admin of the organization. The finding itself is derived from the control, so it cannot be edited here.
 */
import { NextRequest } from 'next/server';
import { ok, notFound, badRequest, internalError, parseBody } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { applyFindingUpdate, FindingUpdateSchema } from '@/lib/compliance/rules';
import { defsFor } from '@/lib/compliance/frameworks';
import { readinessRepository } from '@/lib/repositories/readinessRepository';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string; controlId: string }> }) {
  try {
    const p = await params;
    const caller = await guardReadiness(req, p);
    if ('response' in caller) return caller.response;
    if (!defsFor(caller.framework).some((d) => d.id === p.controlId)) return notFound('Control');
    const parsed = await parseBody(req, FindingUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const cur = (await readinessRepository.findings(caller.projectId, caller.framework))[p.controlId];
    const result = applyFindingUpdate(
      { owner: cur?.owner ?? '', ...(cur?.targetDate ? { targetDate: cur.targetDate } : {}), status: cur?.status ?? 'open', managementResponse: cur?.managementResponse ?? '', acceptedBy: cur?.acceptedBy ?? '', retestedBy: cur?.retestedBy ?? '', ...(cur?.retestedAt ? { retestedAt: cur.retestedAt } : {}) },
      parsed.data, { email: caller.email, isAdmin: caller.isAdmin }, new Date().toISOString(),
    );
    if (!result.ok) return badRequest(result.message);
    await readinessRepository.saveFinding(caller.projectId, caller.framework, { controlId: p.controlId, ...result.next }, caller.email);
    await readinessRepository.clearSignoffs(caller.projectId, caller.framework);
    return ok({ controlId: p.controlId, saved: true, signoffsCleared: true });
  } catch (err) {
    console.error('[PUT readiness finding]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
