/**
 * GET /api/auditor/view   Authorization: Bearer ca_…
 *
 * What an auditor sees through a read-only link: the readiness report for the one framework the link was made for, and the evidence linked to it (without the files).
 */
import { NextRequest } from 'next/server';
import { ok, notFound, internalError } from '@/lib/api/response';
import { authenticateAuditor } from '@/lib/compliance/auditorAuth';
import { buildProjectReport } from '@/lib/compliance/service';
import { readinessRepository } from '@/lib/repositories/readinessRepository';
import { evidenceControls } from '@/lib/compliance/evidenceInput';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const a = await authenticateAuditor(req);
    if ('response' in a) return a.response;
    const built = await buildProjectReport({ orgId: a.orgId, projectId: a.projectId, framework: a.framework, preparedBy: `Read by auditor ${a.access.name}` });
    if (!built.ok) return notFound('Report');
    const evidence = (await readinessRepository.evidence(a.projectId))
      .map((e) => ({ id: e.id, title: e.title, description: e.description, kind: e.kind, origin: e.origin, collectedAt: e.collectedAt, validUntil: e.validUntil, url: e.url, fileName: e.fileName, sizeBytes: e.sizeBytes, sha256: e.sha256, controls: evidenceControls(e, a.framework) }))
      .filter((e) => e.controls.length > 0);
    return ok({ report: built.report, evidence, access: { name: a.access.name, expiresAt: a.access.expiresAt, framework: a.framework } });
  } catch (err) {
    console.error('[GET auditor view]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
