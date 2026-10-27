/**
 * Takes the dated snapshots that show controls kept operating (evidence over time). Called by the scheduled worker for every project that uses the
 * readiness reports, on demand from the panel, and whenever a report version is issued.
 */
import { db } from '@/src/prisma/db';
import { readinessRepository } from '@/lib/repositories/readinessRepository';
import { buildProjectReport } from './service';
import { controlsOf, summaryOf, type SnapshotTrigger } from './snapshots';
import type { FrameworkId } from './types';

export async function takeSnapshot(args: { orgId: string; projectId: string; framework: FrameworkId; trigger: SnapshotTrigger; env?: string }): Promise<{ ok: true; id: string; readiness: string } | { ok: false; reason: string }> {
  const built = await buildProjectReport({ orgId: args.orgId, projectId: args.projectId, framework: args.framework, env: args.env, preparedBy: 'CloudBuilder (scheduled snapshot)' });
  if (!built.ok) return { ok: false, reason: built.reason };
  const { report, input } = built;
  const id = await readinessRepository.addSnapshot(args.projectId, args.framework, { trigger: args.trigger, readiness: report.readiness, summary: summaryOf(report), controls: controlsOf(report), facts: input.facts ?? null });
  return { ok: true, id, readiness: report.readiness };
}

export interface SnapshotRunResult { projects: number; taken: number; skipped: number; failed: number }

/** One pass for the worker: every project with readiness activity, every framework it uses. A failure on one never stops the rest. */
export async function snapshotAllProjects(log: (m: string) => void = console.info): Promise<SnapshotRunResult> {
  const result: SnapshotRunResult = { projects: 0, taken: 0, skipped: 0, failed: 0 };
  for (const p of await readinessRepository.activeProjects()) {
    result.projects++;
    const row = await db.orm.public.Project.where({ id: p.projectId }).select('orgId').first() as { orgId: string } | null;
    if (!row) { result.skipped++; continue; }
    for (const framework of p.frameworks) {
      try {
        const r = await takeSnapshot({ orgId: row.orgId, projectId: p.projectId, framework, trigger: 'scheduled' });
        if (r.ok) result.taken++; else { result.skipped++; log(`[readiness snapshot] ${p.projectId} ${framework}: skipped (${r.reason})`); }
      } catch (err) { result.failed++; log(`[readiness snapshot] ${p.projectId} ${framework} failed: ${err instanceof Error ? err.message : err}`); }
    }
  }
  return result;
}
