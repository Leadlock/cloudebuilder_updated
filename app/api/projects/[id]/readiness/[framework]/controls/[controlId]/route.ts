/**
 * PUT /api/projects/[id]/readiness/[framework]/controls/[controlId]
 *
 * Records what the team says about one control: who owns it, whether it is in place, a note, why it does not apply, or "I reviewed this".
 * Nothing here sets a score: the score comes from the checks and the evidence. Any change ends the sign-offs on the report (they were given on
 * something that has now changed).
 */
import { NextRequest } from 'next/server';
import { ok, notFound, badRequest, internalError, parseBody } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { applyControlUpdate, ControlUpdateSchema } from '@/lib/compliance/rules';
import { defsFor } from '@/lib/compliance/frameworks';
import { readinessRepository } from '@/lib/repositories/readinessRepository';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string; controlId: string }> }) {
  try {
    const p = await params;
    const caller = await guardReadiness(req, p);
    if ('response' in caller) return caller.response;
    if (!defsFor(caller.framework).some((d) => d.id === p.controlId)) return notFound('Control');
    const parsed = await parseBody(req, ControlUpdateSchema);
    if (!parsed.ok) return parsed.response;

    const cur = (await readinessRepository.controls(caller.projectId, caller.framework))[p.controlId];
    const now = new Date().toISOString();
    const result = applyControlUpdate(
      { status: cur?.status ?? null, owner: cur?.owner ?? '', note: cur?.note ?? '', naReason: cur?.naReason ?? '', reviewer: cur?.reviewer ?? '', ...(cur?.reviewedAt ? { reviewedAt: cur.reviewedAt } : {}) },
      parsed.data, { email: caller.email }, now,
    );
    if (!result.ok) return badRequest(result.message);
    await readinessRepository.saveControl(caller.projectId, caller.framework, { controlId: p.controlId, ...result.next }, caller.email);
    await readinessRepository.clearSignoffs(caller.projectId, caller.framework);
    return ok({ controlId: p.controlId, saved: true, signoffsCleared: true });
  } catch (err) {
    console.error('[PUT readiness control]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
