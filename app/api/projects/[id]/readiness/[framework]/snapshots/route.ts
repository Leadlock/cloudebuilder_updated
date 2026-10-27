/**
 * /api/projects/[id]/readiness/[framework]/snapshots
 *
 * GET  — the dated snapshots of the controls (evidence over time) and what they show for the last year: how many, any gaps, which controls operated in every one.
 * POST — take a snapshot now. The worker also takes one every day for every project that uses the readiness reports.
 */
import { NextRequest } from 'next/server';
import { ok, created, notFound, badRequest, internalError } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { analyzePeriod, periodSentence } from '@/lib/compliance/snapshots';
import { takeSnapshot } from '@/lib/compliance/snapshotService';
import { readinessRepository } from '@/lib/repositories/readinessRepository';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params);
    if ('response' in caller) return caller.response;
    const to = new Date(); const from = new Date(to.getTime() - 365 * 86_400_000);
    const all = await readinessRepository.snapshots(caller.projectId, caller.framework, from.toISOString());
    const period = analyzePeriod(caller.framework, all, from, to);
    return ok({
      period: { ...period, sentence: periodSentence(period), controls: undefined },
      snapshots: all.slice(-120).reverse().map((s) => ({ id: s.id, takenAt: s.takenAt, trigger: s.trigger, readiness: s.readiness, scored: s.controls.filter((c) => c.score !== null).length, operating: s.controls.filter((c) => (c.score ?? 0) >= 3).length, failing: s.controls.filter((c) => c.failing.length > 0).length })),
    });
  } catch (err) {
    console.error('[GET readiness snapshots]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params, { limitKey: 'readiness-snapshot' });
    if ('response' in caller) return caller.response;
    const r = await takeSnapshot({ orgId: caller.orgId, projectId: caller.projectId, framework: caller.framework, trigger: 'manual', env: caller.env });
    if (!r.ok) return r.reason === 'project_not_found' ? notFound('Project') : badRequest('Save the architecture first: a snapshot is taken of the saved architecture.');
    return created({ id: r.id, readiness: r.readiness });
  } catch (err) {
    console.error('[POST readiness snapshot]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
