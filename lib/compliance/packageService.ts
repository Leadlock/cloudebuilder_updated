/** Builds the auditor package for one project and framework: renders the report, reads the evidence files, and zips them (lib/compliance/auditorPackage.ts). */
import { readinessRepository, evidenceControls } from '@/lib/repositories/readinessRepository';
import { buildProjectReport } from './service';
import { buildAuditorPackage } from './auditorPackage';
import { renderSoc2Docx } from './renderSoc2Docx';
import { renderSoc2Pdf } from './renderSoc2Pdf';
import { renderControlPdf } from './renderControlPdf';
import type { FrameworkId } from './types';

export async function packageForProject(a: { orgId: string; projectId: string; framework: FrameworkId; env?: string; preparedBy: string }) {
  const built = await buildProjectReport({ orgId: a.orgId, projectId: a.projectId, framework: a.framework, env: a.env, preparedBy: a.preparedBy });
  if (!built.ok) return built;
  const { report } = built;
  const base = `cloudbuilder-${a.framework}-readiness-${report.version}-${report.reportId}`.toLowerCase();
  const files = a.framework === 'soc2'
    ? [{ name: `${base}.docx`, bytes: await renderSoc2Docx(report) }, { name: `${base}.pdf`, bytes: await renderSoc2Pdf(report) }]
    : [{ name: `${base}.pdf`, bytes: await renderControlPdf(report) }];
  const rows = (await readinessRepository.evidence(a.projectId)).filter((e) => evidenceControls(e, a.framework).length > 0);
  const evidence = await Promise.all(rows.filter((e) => e.kind === 'file').map(async (e) => ({ id: e.id, bytes: await readinessRepository.evidenceFile(a.projectId, e.id) })));
  const evidenceDetail = Object.fromEntries(rows.map((e) => [e.id, { description: e.description, url: e.url }]));
  const snapshots = await readinessRepository.snapshots(a.projectId, a.framework, new Date(Date.now() - 365 * 86_400_000).toISOString());
  const pkg = await buildAuditorPackage({ report, files, evidence, evidenceDetail, snapshots, generatedAt: new Date() });
  return { ok: true as const, report, name: `${base}-auditor-package.zip`, ...pkg };
}
