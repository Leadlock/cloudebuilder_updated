/**
 * PDF rendering of the dedicated Well-Architected report (server only): cover, executive summary with a pillar
 * scorecard, one section per pillar, optional validated AI commentary, improvement roadmap, evidence gaps, method.
 * Built from report data with pdfkit — vector text and tables, not a screenshot.
 */
import { LIMITED_EVIDENCE_NOTE, pillarScoreText } from '@/lib/engines/assessment/report/waReportView';
import { COMMENTARY_DISCLAIMER, waUnscoredNotice } from '@/lib/ai/reportCommentary';
import type { AssessmentReport, RecommendationGroup } from '@/lib/engines/assessment/report/buildReport';
import { waPillarViews, strongestAndWeakest, WA_REPORT_DISCLAIMER, type WaPillarView } from '@/lib/engines/assessment/report/waReportView';
import type { Finding, Severity } from '@/lib/engines/assessment/types';
import { C, PAGE, Writer, finishPdf, fmtDate, openPdf, pdfSafe, scoreText, sevColor, statusColor } from './renderReportPdf';

const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'];
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

function pillarFindingBlock(w: Writer, f: Finding) {
  const d = w.doc;
  w.ensure(100);
  const y = d.y;
  d.rect(PAGE.m, y, PAGE.w - PAGE.m * 2, 0.8).fillColor(C.sev[f.severity]).fill();
  d.y = y + 6;
  let x = PAGE.m;
  x += w.pill(f.severity, C.sev[f.severity], x, d.y) + 4;
  d.font('Helvetica-Bold').fontSize(8.5).fillColor(C.muted).text(f.findingId, x + 2, d.y + 2, { lineBreak: false });
  d.y += 17; d.x = PAGE.m;
  d.font('Helvetica-Bold').fontSize(10.5).fillColor(C.navy).text(pdfSafe(f.title), PAGE.m, d.y, { width: PAGE.w - PAGE.m * 2 });
  d.moveDown(0.2);
  w.p(`${f.resourceLabels.join(', ') || 'Architecture-wide'}${f.practice ? ` · ${f.practice}` : ''}`, { size: 8.5, color: C.muted });
  w.p(`Observed: ${f.observation}`, { size: 9 });
  w.p(`Why it matters: ${f.risk || f.rationale}`, { size: 9 });
  w.p(`Recommendation: ${f.recommendation}`, { size: 9, bold: true });
  if (f.manualSteps.length) w.bullets(f.manualSteps.slice(0, 6), { size: 8.5 });
  d.moveDown(0.3);
}

function recTable(w: Writer, groups: RecommendationGroup[], empty: string) {
  w.table([
    { header: 'Severity', width: 14, render: sevColor }, { header: 'Improvement', width: 54 }, { header: 'Rule', width: 17 }, { header: 'Affected resources', width: 28 },
  ], groups.map((g) => [g.severity, g.recommendation, g.ruleId, Array.from(new Set(g.resources)).join(', ') || 'Architecture-wide']), { size: 8, empty });
}

function pillarSection(w: Writer, p: WaPillarView, ai: AssessmentReport['aiWaCommentary']) {
  w.h2(`${p.label} — ${p.status}`, true);
  w.p(p.evaluable
    ? `${p.framework} · Score ${pillarScoreText(p.score, p.limitedEvidence, p.evaluatedRules)} (${p.rating}) · Coverage ${pct(p.coveragePct)} — ${p.evaluated} of ${p.applicable} applicable checks evaluated · ${p.failed} failed · ${p.warnings} warnings · ${p.passed} passed`
    : `${p.framework} · Not scored — ${p.evaluated} of ${p.applicable} applicable checks could be evaluated`, { size: 8.5, color: statusColor(p.status) });
  if (!p.evaluable) { const n = waUnscoredNotice(p.insufficient); w.box(n.title, n.text, p.insufficient ? '#B45309' : C.accent); }
  if (p.strengths.length) { w.h3('What the design does well'); w.bullets(p.strengths, { size: 9 }); }
  const aiPillar = ai?.pillars.find((x) => x.key === p.key);
  // Only the model's own wording is labelled AI commentary; thin-evidence pillars already carry the fixed notice above.
  if (p.evaluable && aiPillar?.assessment) {
    w.box('AI commentary', `${aiPillar.assessment}${aiPillar.topFixes.map((f) => `\n- ${f.title} (${f.severity}): ${f.fix}`).join('')}`, C.accent);
  }
  if (p.findings.length) p.findings.forEach((f) => pillarFindingBlock(w, f));
  else if (p.evaluable) w.p('No open findings in the evaluated checks.', { color: C.muted, size: 9 });
}

export async function renderWaReportPdf(report: AssessmentReport): Promise<Buffer> {
  const { doc, w, done } = await openPdf(report, { title: 'Well-Architected Review', subject: 'Well-Architected Review (design-time)' });
  const m = report.meta;
  const views = waPillarViews(report);
  const { strongest, weakest } = strongestAndWeakest(views);
  const frameworks = Array.from(new Set(views.map((v) => v.framework)));
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, views.reduce((n, v) => n + v.findings.filter((f) => f.severity === s).length, 0)])) as Record<Severity, number>;

  // ── Cover ──
  doc.rect(0, 0, PAGE.w, 300).fillColor(C.navy).fill();
  doc.font('Helvetica').fontSize(11).fillColor('#9FB6D3').text('CLOUDCRAFT', PAGE.m, 70, { characterSpacing: 3 });
  doc.font('Helvetica-Bold').fontSize(28).fillColor('#FFFFFF').text('Well-Architected Review', PAGE.m, 100, { width: PAGE.w - PAGE.m * 2 });
  doc.font('Helvetica').fontSize(14).fillColor('#D5E1F0').text(pdfSafe(m.projectName), PAGE.m, doc.y + 10, { width: PAGE.w - PAGE.m * 2 });
  doc.roundedRect(PAGE.m, 250, 150, 22, 4).fillColor('#F59E0B').fill();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.navy).text('DESIGN-TIME REVIEW', PAGE.m + 12, 257);
  doc.y = 340; doc.x = PAGE.m;
  w.kv([
    ['Project', m.projectName],
    ['Environment', m.environment],
    ['Framework(s)', frameworks.join('; ') || '—'],
    ['Region(s)', m.regions.join(', ') || 'Not specified'],
    ['Review date', fmtDate(m.assessmentDate)],
    ['Architecture version', `Revision ${m.architectureRevision}`],
    ['Report ID', m.reportId],
    ['Overall score', `${scoreText(report.executive.overall.score)} (${report.executive.overall.rating}) — coverage ${pct(report.executive.overall.coverage.coveragePct)}`],
  ], 140);
  doc.y = PAGE.h - 150;
  w.box('Important', WA_REPORT_DISCLAIMER, '#B45309');

  w.newPage();
  const tocPage = w.pageIndex();

  // ── 1 Executive summary ──
  w.h1('1', 'Executive Summary');
  w.p(`Overall Well-Architected score ${scoreText(report.executive.overall.score)} (${report.executive.overall.rating}), assessment coverage ${pct(report.executive.overall.coverage.coveragePct)}.${strongest && weakest ? ` The strongest evaluated pillar is ${strongest.label} (${scoreText(strongest.score)}); the weakest is ${weakest.label} (${scoreText(weakest.score)}).` : ''}`);
  w.table([
    { header: 'Pillar', width: 30 }, { header: 'Framework', width: 20 }, { header: 'Status', width: 26, render: (r) => ({ color: statusColor(r[2]) }) }, { header: 'Score', width: 22 }, { header: 'Cov.', width: 11 }, { header: 'Open', width: 9, align: 'center' },
  ], views.map((v) => [v.label, v.provider.toUpperCase(), v.status, pillarScoreText(v.score, v.limitedEvidence, v.evaluatedRules, true), pct(v.coveragePct), String(v.findings.length)]), { size: 8.5 });
  if (views.some((v) => v.limitedEvidence)) w.p(LIMITED_EVIDENCE_NOTE, { size: 8, color: C.muted });
  w.h3('Open findings by severity');
  w.table(SEVERITIES.map((s) => ({ header: s, width: 20, align: 'center' as const, render: () => ({ color: C.sev[s], bold: true }) })), [SEVERITIES.map((s) => String(counts[s]))]);
  if (report.executive.counts.CRITICAL > 0 || report.executive.counts.HIGH > 0) w.box('Critical or high-severity findings are open', 'See the improvement roadmap for the order in which to address them.', C.fail);
  const thin = views.filter((v) => v.insufficient);
  if (thin.length) w.box('Pillars without enough evidence', `${thin.map((v) => v.label).join(', ')}. They are shown as "Insufficient evidence", never as passing.`, '#B45309');

  // ── 2 Pillar reviews ──
  w.h1('2', 'Pillar Reviews');
  for (const v of views) pillarSection(w, v, report.aiWaCommentary);

  // ── AI commentary (optional) ──
  let n = 3;
  if (report.aiWaCommentary) {
    const ai = report.aiWaCommentary;
    w.h1(String(n++), 'AI-Generated Commentary');
    w.box('AI-generated', `${COMMENTARY_DISCLAIMER} Generated ${fmtDate(ai.generatedAt)}.`, '#B45309');
    if (ai.summary) w.p(ai.summary);
    if (ai.plan.length) { w.h3('Suggested order of work'); w.bullets(ai.plan.map((s) => `${s.title} (${s.severity}, ${s.ruleId}) — ${s.action}`), { size: 8.5 }); }
    if (ai.suggestions.length) { w.h3('Unverified AI suggestions (not backed by a finding)'); w.bullets(ai.suggestions, { size: 8.5 }); }
  }

  // ── Roadmap ──
  w.h1(String(n++), 'Improvement Roadmap');
  w.h2('Immediate'); recTable(w, report.remediationPlan.immediate, 'Nothing requires immediate action.');
  w.h2('Short term'); recTable(w, report.remediationPlan.shortTerm, 'None.');
  w.h2('Long term'); recTable(w, report.remediationPlan.longTerm, 'None.');

  // ── Evidence gaps ──
  w.h1(String(n++), 'Evidence Gaps');
  w.p('Checks that could not be evaluated are not counted as passing. They need more architecture detail or discovered configuration.', { size: 8.5, color: C.muted });
  w.table([{ header: 'Check', width: 34 }, { header: 'Resources', width: 20 }, { header: 'Why not evaluated / evidence needed', width: 46 }],
    report.appendix.notEvaluated.slice(0, 30).map((x) => [x.control, x.resources, `${x.availability}\n${x.requiredData}`]), { size: 7.5, empty: 'All applicable checks were evaluated.' });
  if (report.appendix.notEvaluated.length > 30) w.p(`${report.appendix.notEvaluated.length - 30} more not shown; the full list is in the Architecture & Security Assessment report.`, { size: 8.5, color: C.muted });

  // ── Method ──
  w.h1(String(n++), 'Method & Limitations');
  w.p(WA_REPORT_DISCLAIMER, { size: 9 });
  w.bullets(report.appendix.methodology, { size: 8.5 });
  w.h3('Limitations'); w.bullets(report.appendix.limitations, { size: 8.5 });
  w.h3('Framework references');
  w.bullets(Array.from(new Set(views.map((v) => `${v.framework} — ${v.label}: ${v.referenceUrl}`))), { size: 8 });

  finishPdf(w, tocPage, 'Well-Architected Review');
  doc.end();
  return done;
}
