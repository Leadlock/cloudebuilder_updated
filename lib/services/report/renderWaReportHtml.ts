/**
 * Self-contained HTML rendering of the dedicated Well-Architected report: pillar by pillar, with scores, strengths,
 * findings, an improvement roadmap and (optionally) validated AI commentary. All values are HTML-escaped.
 */
import { COMMENTARY_DISCLAIMER, waUnscoredNotice } from '@/lib/ai/reportCommentary';
import type { AssessmentReport, RecommendationGroup } from '@/lib/engines/assessment/report/buildReport';
import { waPillarViews, strongestAndWeakest, WA_REPORT_DISCLAIMER, type WaPillarView } from '@/lib/engines/assessment/report/waReportView';
import type { Finding, Severity } from '@/lib/engines/assessment/types';
import { REPORT_CSS, SEV, date, esc, human, list, score, sevBadge, statusClass, table } from './renderReportHtml';

const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'];
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

function pillarFinding(f: Finding): string {
  return `<article class="finding" style="border-left-color:${SEV[f.severity]}">
  <div class="fhead">${sevBadge(f.severity)} <code>${esc(f.findingId)}</code></div>
  <h4>${esc(f.title)}</h4>
  <p class="muted">${esc(f.resourceLabels.join(', ') || 'Architecture-wide')}${f.practice ? ` · ${esc(f.practice)}` : ''}</p>
  <p><strong>Observed:</strong> ${esc(f.observation)}</p>
  <p><strong>Why it matters:</strong> ${esc(f.risk || f.rationale)}</p>
  <p><strong>Recommendation:</strong> ${esc(f.recommendation)}</p>
  ${f.manualSteps.length ? `<ol>${f.manualSteps.slice(0, 6).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
</article>`;
}

function pillarSection(p: WaPillarView, ai: AssessmentReport['aiWaCommentary']): string {
  const aiPillar = ai?.pillars.find((x) => x.key === p.key);
  return `<h3 class="${statusClass(p.status)}">${esc(p.label)} <span class="muted">— ${esc(p.status)}</span></h3>
  <p class="muted">${p.evaluable ? `${esc(p.framework)} · Score ${score(p.score)} (${esc(p.rating)}) · Coverage ${pct(p.coveragePct)} — ${p.evaluated} of ${p.applicable} applicable checks evaluated · ${p.failed} failed · ${p.warnings} warnings · ${p.passed} passed` : `${esc(p.framework)} · Not scored — ${p.evaluated} of ${p.applicable} applicable checks could be evaluated`}</p>
  ${p.evaluable ? '' : `<div class="callout ${p.insufficient ? 'warn' : ''}"><b>${esc(waUnscoredNotice(p.insufficient).title)}.</b> ${esc(waUnscoredNotice(p.insufficient).text)}</div>`}
  ${p.strengths.length ? `<p><b>What the design does well</b></p>${list(p.strengths)}` : ''}
  ${p.evaluable && aiPillar && aiPillar.assessment ? `<div class="callout"><b>AI commentary:</b> ${esc(aiPillar.assessment)}${aiPillar.topFixes.length ? `<ul>${aiPillar.topFixes.map((f) => `<li>${esc(f.title)} (${esc(f.severity)}) — ${esc(f.fix)}</li>`).join('')}</ul>` : ''}</div>` : ''}
  ${p.findings.length ? p.findings.map(pillarFinding).join('') : (p.evaluable ? '<p class="muted">No open findings in the evaluated checks.</p>' : '')}`;
}

function recTable(groups: RecommendationGroup[], empty: string): string {
  return table(['Severity', 'Improvement', 'Pillar / rule', 'Affected resources'],
    groups.map((g) => [sevBadge(g.severity), esc(g.recommendation), `<code>${esc(g.ruleId)}</code>`, esc(Array.from(new Set(g.resources)).join(', ') || 'Architecture-wide')]), empty);
}

function aiSection(c: NonNullable<AssessmentReport['aiWaCommentary']>): string {
  return `<section><h2>AI-generated commentary</h2><div class="callout warn">${esc(COMMENTARY_DISCLAIMER)} Generated ${esc(date(c.generatedAt))}.</div>
  ${c.summary ? `<p>${esc(c.summary)}</p>` : ''}
  ${c.plan.length ? `<h3>Suggested order of work</h3><ol>${c.plan.map((s) => `<li><b>${esc(s.title)}</b> <span class="muted">(${esc(s.severity)}, ${esc(s.ruleId)})</span><br>${esc(s.action)}</li>`).join('')}</ol>` : ''}
  ${c.suggestions.length ? `<h3>Unverified AI suggestions</h3><p class="muted">Not backed by a finding.</p>${list(c.suggestions)}` : ''}</section>`;
}

export function renderWaReportHtml(r: AssessmentReport): string {
  const m = r.meta;
  const views = waPillarViews(r);
  const { strongest, weakest } = strongestAndWeakest(views);
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, views.reduce((n, v) => n + v.findings.filter((f) => f.severity === s).length, 0)])) as Record<Severity, number>;
  const frameworks = Array.from(new Set(views.map((v) => v.framework)));
  const sections: string[] = [];

  sections.push(`<section class="cover"><p class="brand">CLOUDCRAFT</p><h1>Well-Architected Review</h1><p class="project">${esc(m.projectName)}</p><span class="badge">DESIGN-TIME REVIEW</span>
  ${table(['', ''], [
    ['Environment', esc(m.environment)], ['Framework(s)', esc(frameworks.join('; '))], ['Region(s)', esc(m.regions.join(', ') || 'Not specified')],
    ['Review date', esc(date(m.assessmentDate))], ['Architecture version', `Revision ${m.architectureRevision}`], ['Report ID', esc(m.reportId)],
  ])}
  <div class="callout warn"><b>Important.</b> ${esc(WA_REPORT_DISCLAIMER)}</div></section>`);

  sections.push(`<section><h2>1. Executive Summary</h2>
  <p>Overall Well-Architected score <b>${score(r.executive.overall.score)}</b> (${esc(r.executive.overall.rating)}), assessment coverage ${pct(r.executive.overall.coverage.coveragePct)}.${strongest && weakest ? ` The strongest evaluated pillar is <b>${esc(strongest.label)}</b> (${score(strongest.score)}); the weakest is <b>${esc(weakest.label)}</b> (${score(weakest.score)}).` : ''}</p>
  ${table(['Pillar', 'Framework', 'Status', 'Score', 'Coverage', 'Open findings'], views.map((v) => [esc(v.label), esc(v.framework), `<span class="${statusClass(v.status)}">${esc(v.status)}</span>`, score(v.score), pct(v.coveragePct), String(v.findings.length)]))}
  <h3>Open findings by severity</h3><div class="counts">${SEVERITIES.map((s) => `<div><b style="color:${SEV[s]}">${counts[s]}</b><span>${s}</span></div>`).join('')}</div>
  ${r.executive.counts.CRITICAL > 0 || r.executive.counts.HIGH > 0 ? '<div class="callout bad"><b>Critical or high-severity findings are open.</b> See the improvement roadmap.</div>' : ''}
  ${views.some((v) => v.insufficient) ? `<div class="callout warn"><b>Pillars without enough evidence:</b> ${esc(views.filter((v) => v.insufficient).map((v) => v.label).join(', '))}. They are shown as "Insufficient evidence", never as passing.</div>` : ''}</section>`);

  sections.push(`<section><h2>2. Pillar Reviews</h2>${views.map((v) => pillarSection(v, r.aiWaCommentary)).join('')}</section>`);

  if (r.aiWaCommentary) sections.push(aiSection(r.aiWaCommentary));

  sections.push(`<section><h2>3. Improvement Roadmap</h2><h3>Immediate</h3>${recTable(r.remediationPlan.immediate, 'Nothing requires immediate action.')}<h3>Short term</h3>${recTable(r.remediationPlan.shortTerm, 'None.')}<h3>Long term</h3>${recTable(r.remediationPlan.longTerm, 'None.')}</section>`);

  sections.push(`<section><h2>4. Evidence Gaps</h2><p>Checks that could not be evaluated are not counted as passing. They need more architecture detail or discovered configuration.</p>
  ${table(['Check', 'Resources', 'Why not evaluated / evidence needed'], r.appendix.notEvaluated.slice(0, 30).map((x) => [esc(x.control), esc(x.resources), `${esc(x.availability)}<br><span class="muted">${esc(x.requiredData)}</span>`]), 'All applicable checks were evaluated.')}
  ${r.appendix.notEvaluated.length > 30 ? `<p class="muted">${r.appendix.notEvaluated.length - 30} more not shown; the full list is in the Architecture &amp; Security Assessment report.</p>` : ''}</section>`);

  sections.push(`<section><h2>5. Method &amp; Limitations</h2><p>${esc(WA_REPORT_DISCLAIMER)}</p>${list(r.appendix.methodology)}<h3>Limitations</h3>${list(r.appendix.limitations)}
  <h3>Framework references</h3>${list(Array.from(new Set(views.map((v) => `${v.framework} — ${human(v.pillar)}: ${v.referenceUrl}`))))}</section>`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Well-Architected Review — ${esc(m.projectName)}</title>
<style>
${REPORT_CSS}
</style></head><body><main>${sections.join('\n')}
<footer>${esc(m.reportId)} · Ruleset ${esc(m.rulesetVersion)} · Architecture revision ${m.architectureRevision} · Design-time review — not an official Well-Architected Framework review.</footer></main></body></html>`;
}
