/**
 * Performance benchmark for security + Well-Architected analysis, Auto-Fix and reporting.
 * Usage: npx tsx --tsconfig tsconfig.json scripts/perf-assessment.ts [sizes...]
 * Builds realistic mixed AWS + Azure graphs (containment + connections) of N resources.
 */
import { graph } from './perfGraph';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { WellArchitectedRuleEngine } from '@/lib/engines/wellArchitected/WellArchitectedRuleEngine';
import { applySafeFixes, planAutoFix, safeFixCandidates } from '@/lib/engines/assessment/autofix';
import { buildReport } from '@/lib/engines/assessment/report/buildReport';
import { buildSnapshot } from '@/lib/services/AssessmentSnapshotService';
import { renderReportPdf } from '@/lib/services/report/renderReportPdf';
import { renderReportHtml } from '@/lib/services/report/renderReportHtml';
import type { DbArchitecture } from '@/lib/repositories/architectureRepository';

function time<T>(f: () => T, reps = 3): { ms: number; value: T } {
  let best = Infinity; let value!: T;
  for (let r = 0; r < reps; r++) { const t0 = performance.now(); value = f(); best = Math.min(best, performance.now() - t0); }
  return { ms: Math.round(best * 10) / 10, value };
}

async function main() {
  const sizes = process.argv.slice(2).map(Number).filter(Boolean);
  const rows: string[] = [];
  for (const n of sizes.length ? sizes : [25, 100, 250, 500]) {
    const { nodes, edges } = graph(n);
    const a = time(() => runAssessment({ nodes, edges }));
    const wa = time(() => new WellArchitectedRuleEngine().analyze({ architectureId: 'perf', nodes, edges }));
    const cands = safeFixCandidates(a.value.findings);
    const plan = time(() => planAutoFix(nodes, edges, cands[0].findingId), 3);
    const bulk = time(() => applySafeFixes(nodes, edges, cands.map((c) => c.findingId)), 1);
    const arch = { id: 'arch-perf', environmentId: 'env', revision: 1, createdAt: '', updatedAt: '',
      resources: nodes.map((x) => ({ id: x.id, resourceType: x.resourceType, provider: x.provider, label: x.label, positionX: x.position.x, positionY: x.position.y, configJson: JSON.stringify(x.config), region: null, groupId: x.parentId ?? null, locked: false, architectureId: 'arch-perf' })),
      connections: edges.map((e) => ({ id: e.id, sourceId: e.source, targetId: e.target, label: null, edgeType: null, architectureId: 'arch-perf' })),
    } as unknown as DbArchitecture;
    const snap = time(() => buildSnapshot({ project: { id: 'p', name: 'Perf', environment: 'production', region: 'us-east-1' }, arch, createdBy: 'u', reviews: [] }), 1);
    const rep = time(() => buildReport(snap.value), 1);
    const t0 = performance.now(); const pdf = await renderReportPdf(rep.value); const pdfMs = Math.round(performance.now() - t0);
    const html = time(() => renderReportHtml(rep.value), 1);
    rows.push(`| ${n} | ${a.value.evaluations.length} | ${a.value.findings.length} | ${a.ms} | ${wa.ms} | ${plan.ms} | ${cands.length} → ${bulk.ms} | ${snap.ms} | ${rep.ms} | ${pdfMs} (${Math.round(pdf.length / 1024)} KB) | ${html.ms} |`);
  }
  console.log('| Resources | Evaluations | Findings | Security+WA assessment (ms) | WA adapter (ms) | Auto-Fix preview (ms) | Bulk safe fixes: count → ms | Snapshot (ms) | Report model (ms) | PDF render (ms) | HTML render (ms) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(r);
}
void main();
