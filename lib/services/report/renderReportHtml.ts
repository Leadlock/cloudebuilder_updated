/**
 * Self-contained HTML rendering of the structured AssessmentReport (same
 * content as the PDF). Suitable for sharing, archiving, or printing; all
 * values are HTML-escaped.
 */
import type { AssessmentReport, RecommendationGroup } from '@/lib/engines/assessment/report/buildReport';
import type { Finding, Severity } from '@/lib/engines/assessment/types';
import { VERIFICATION_LABEL } from '@/lib/engines/assessment/references';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const SEV: Record<Severity, string> = { CRITICAL: '#9F1239', HIGH: '#C2410C', MEDIUM: '#A16207', LOW: '#1D4ED8', INFORMATIONAL: '#475569' };
const human = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
const score = (s: number | null) => (s === null ? 'Not scored' : `${s}/100`);
const date = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const statusClass = (v: string) => (/^(Pass|No issues|Technical evidence)/.test(v) ? 'ok' : /^(Gap|Critical|Gaps)/.test(v) ? 'bad' : /^(Warning|Issues|Partial)/.test(v) ? 'warn' : 'na');

function table(headers: string[], rows: string[][], empty = 'None.'): string {
  if (rows.length === 0) return `<p class="muted">${esc(empty)}</p>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
const sevBadge = (s: Severity) => `<span class="pill" style="background:${SEV[s]}">${s}</span>`;
const list = (items: string[], empty = 'None.') => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : `<p class="muted">${esc(empty)}</p>`);

function recTable(groups: RecommendationGroup[], empty: string) {
  return table(['Rule', 'Severity', 'Recommendation', 'Affected resources', 'Auto-Fix'],
    groups.map((g) => [esc(g.ruleId), sevBadge(g.severity), esc(g.recommendation), esc(Array.from(new Set(g.resources)).join(', ') || 'Architecture-wide'), esc(g.autoFix)]), empty);
}

function finding(f: Finding): string {
  return `<article class="finding" style="border-left-color:${SEV[f.severity]}">
  <div class="fhead">${sevBadge(f.severity)} <span class="pill" style="background:${f.status === 'FAIL' ? '#B91C1C' : '#A16207'}">${f.status}</span>${f.reviewStatus !== 'OPEN' ? ` <span class="pill" style="background:#6D28D9">${esc(human(f.reviewStatus))}</span>` : ''} <code>${esc(f.findingId)}</code></div>
  <h4>${esc(f.title)}</h4>
  <dl>
    <dt>Affected resource(s)</dt><dd>${esc(f.resourceLabels.join(', ') || 'Architecture-wide')}</dd>
    <dt>Provider / service</dt><dd>${esc(f.provider === 'aws' ? 'AWS' : 'Azure')} — ${esc(f.service)}${f.region ? ` — ${esc(f.region)}` : ''}</dd>
    <dt>Category / pillar</dt><dd>${esc(f.category)} — ${esc(human(f.pillar))}${f.practice ? ` (${esc(f.practice)})` : ''}</dd>
    <dt>Evidence basis</dt><dd>${f.provenance === 'DESIGN_TIME' ? 'Design-time configuration' : 'Discovered configuration (point-in-time)'}</dd>
  </dl>
  <p><strong>What CloudCraft observed:</strong> ${esc(f.observation)}</p>
  ${f.evidence.length ? table(['Evidence', 'Observed', 'Expected', 'Basis'], f.evidence.map((e) => [esc(e.label), esc(e.observed), esc(e.expected ?? '—'), esc(human(e.basis))])) : ''}
  <p><strong>Why this matters:</strong> ${esc(f.rationale)}</p>
  <p><strong>Risk:</strong> ${esc(f.risk)} <strong>Potential impact:</strong> ${esc(f.impact)}</p>
  <p><strong>Recommendation:</strong> ${esc(f.recommendation)}</p>
  ${f.manualSteps.length ? `<p class="muted">Manual remediation steps:</p><ol>${f.manualSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
  ${f.terraform ? `<p class="muted">Terraform: <code>${esc(f.terraform)}</code></p>` : ''}
  <p><strong>Auto-Fix:</strong> ${f.autoFix.available ? `${f.autoFix.safety === 'SAFE_AUTOFIX' ? 'Safe Auto-Fix' : 'Auto-Fix with review'} — ${esc(f.autoFix.description)}` : 'Manual remediation only'} <span class="muted">(${esc(f.autoFix.safetyReason)})</span></p>
  ${f.review ? `<p class="review">Review: ${esc(human(f.review.status))} by ${esc(f.review.approvedBy)} on ${esc(f.review.approvedAt.slice(0, 10))}${f.review.expiresAt ? `, review by ${esc(f.review.expiresAt.slice(0, 10))}` : ''} — “${esc(f.review.reason)}”. The finding remains technically failing.</p>` : ''}
  <p class="muted">References: ${f.references.filter((r) => r.identifier || r.url).map((r) => r.url ? `<a href="${esc(r.url)}">${esc(`${r.framework}${r.identifier ? ` ${r.identifier}` : ''}`)}</a>` : esc(`${r.framework} ${r.identifier}`)).join(' · ')}</p>
</article>`;
}

export function renderReportHtml(r: AssessmentReport): string {
  const m = r.meta; const ex = r.executive;
  const counts = (c: Record<Severity, number>) => `<div class="counts">${(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'] as Severity[]).map((s) => `<div><b style="color:${SEV[s]}">${c[s]}</b><span>${s}</span></div>`).join('')}</div>`;
  const sections: string[] = [];

  sections.push(`<section class="cover"><p class="brand">CLOUDCRAFT</p><h1>Architecture &amp; Security Assessment</h1><p class="project">${esc(m.projectName)}</p><span class="badge">DESIGN-TIME ASSESSMENT</span>
  ${table(['', ''], [
    ['Environment', esc(m.environment)], ['Provider(s)', esc(m.providers.join(', '))], ['Region(s)', esc(m.regions.join(', ') || 'Not specified')],
    ['Assessment date', esc(date(m.assessmentDate))], ['Architecture version', `Revision ${m.architectureRevision}`], ['Report ID', esc(m.reportId)],
  ])}
  <div class="callout warn"><b>Important.</b> This report is an automated, design-time technical assessment generated by CloudCraft from the architecture as modelled. It is not an audit, attestation, certification or compliance opinion.</div></section>`);

  sections.push(`<section><h2>1. Document Control</h2>${table(['Field', 'Value'], [
    ['Report ID', esc(m.reportId)], ['Report format version', esc(m.reportFormatVersion)], ['Generated', esc(date(m.generatedAt))], ['Assessment snapshot (scan) ID', `<code>${esc(m.scanId)}</code>`],
    ['Architecture revision', String(m.architectureRevision)], ['Graph hash', `<code>${esc(m.graphHash)}</code>`], ['Content SHA-256', `<code>${esc(m.contentSha256)}</code>`],
    ['Engine / ruleset', `${esc(m.engine)} / ${esc(m.rulesetVersion)}`], ['Analysis mode', esc(m.analysisMode)],
  ])}</section>`);

  sections.push(`<section><h2>2. Executive Summary</h2><p>${esc(ex.overview)}</p>
  ${table(['Measure', 'Result', 'Coverage', 'Rating'], [
    ['Security score', `<b>${score(ex.security.score)}</b>`, `${ex.security.coverage.coveragePct ?? 0}%`, esc(ex.security.rating)],
    ['All checks', `<b>${score(ex.overall.score)}</b>`, `${ex.overall.coverage.coveragePct ?? 0}%`, esc(ex.overall.rating)],
  ])}
  ${ex.security.capApplied ? `<p class="muted">${esc(ex.security.capApplied)}</p>` : ''}
  ${ex.security.lowCoverage ? '<div class="callout warn"><b>Low assessment coverage.</b> Less than 60% of applicable security checks could be evaluated; the score reflects only evaluated checks.</div>' : ''}
  <h3>Open findings by severity</h3>${counts(ex.counts)}
  <h3>Well-Architected summary</h3>${ex.wellArchitected.map((p) => `<p><b>${esc(p.framework)}</b></p>${table(['Pillar', 'Status', 'Score', 'Coverage'], p.pillars.map((x) => [esc(x.label), `<span class="${statusClass(x.status)}">${esc(x.status)}</span>`, score(x.score), x.coverage === null ? '—' : `${x.coverage}%`]))}`).join('')}
  <h3>SOC 1 readiness summary</h3><p>${ex.soc1.observed} area(s) with technical evidence observed, ${ex.soc1.gaps} with gaps, ${ex.soc1.partial} partially evaluated, ${ex.soc1.notEvaluated} not evaluated. All areas require organizational evidence and independent auditor assessment.</p>
  <h3>High-impact checks passed</h3>${list(ex.strengths, 'No critical- or high-severity security checks passed in the evaluated configuration.')}
  <h3>Major risks</h3>${list(ex.majorRisks, 'No critical or high severity failures in the evaluated checks.')}
  <h3>Immediate priorities</h3>${list(ex.immediatePriorities, 'No immediate remediation items.')}</section>`);

  sections.push(`<section><h2>3. Architecture Overview</h2>
  ${table(['Providers', 'Regions', 'Resources', 'Connections'], [[esc(m.providers.join(', ')), esc(m.regions.join(', ') || '—'), String(r.architecture.resourceCount), String(r.architecture.edges.length)]])}
  <h3>Resource summary</h3>${table(['Provider', 'Resource type', 'Count'], r.architecture.resourceSummary.map((x) => [esc(x.provider), esc(x.type), String(x.count)]))}
  <h3>Data flow summary</h3>${table(['From', 'To', 'Connection'], r.architecture.dataFlows.map((f) => [esc(f.from), esc(f.to), esc(f.label)]), 'No connections are modelled.')}</section>`);

  sections.push(`<section><h2>4. Assessment Scope</h2><h3>What was evaluated</h3>${list(r.scope.evaluated)}<h3>What was not evaluated</h3>${list(r.scope.notEvaluated)}<h3>Data sources</h3>${list(r.scope.dataSources)}<h3>Limitations</h3>${list(r.scope.limitations)}</section>`);

  sections.push(`<section><h2>5. Well-Architected Review</h2>${r.wellArchitected.map((prov) => `<h3>${esc(prov.framework)}</h3>${prov.pillars.map((p) => `
    <h4 class="${statusClass(p.status)}">${esc(p.label)} — ${esc(p.status)}</h4>
    <p class="muted">Score ${score(p.score.score)} · Coverage ${p.score.coverage.coveragePct ?? '—'}${p.score.coverage.coveragePct === null ? '' : '%'} (${p.score.coverage.evaluated} evaluated, ${p.score.coverage.notEvaluated + p.score.coverage.insufficientData} not evaluated)</p>
    ${p.strengths.length ? `<p><b>Strengths</b></p>${list(p.strengths.slice(0, 4))}` : ''}
    ${p.findings.length ? table(['Finding ID', 'Severity', 'Finding', 'Resources'], p.findings.map((f) => [`<code>${esc(f.findingId)}</code>`, sevBadge(f.severity), esc(f.title), esc(f.resourceLabels.join(', ') || 'Architecture-wide')])) : `<p class="muted">${p.status === 'Insufficient evidence' ? 'Insufficient architecture evidence to assess this pillar.' : 'No findings in the evaluated checks.'}</p>`}`).join('')}`).join('')}</section>`);

  sections.push(`<section><h2>6. Security Assessment</h2>${counts(r.security.counts)}${r.security.findings.length ? r.security.findings.map(finding).join('') : '<p>No security findings in the evaluated checks.</p>'}</section>`);

  sections.push(`<section><h2>7. SOC 1 Readiness Analysis</h2><div class="callout bad"><b>Not a SOC 1 attestation.</b> ${esc(r.soc1.disclaimer)}</div>
  ${table(['Control area', 'Status', 'Evidence types'], r.soc1.areas.map((a) => [`${esc(a.id)} ${esc(a.name)}`, `<span class="${statusClass(a.status)}">${esc(a.status)}</span>`, esc(a.evidenceTypes.map(human).join(', '))]))}
  ${r.soc1.areas.map((a) => `<h4 class="${statusClass(a.status)}">${esc(a.id)} ${esc(a.name)} — ${esc(a.status)}</h4><p class="muted">Objective: ${esc(a.objective)}</p>
    <p><b>Architecture evidence (design-time configuration)</b></p>${a.architectureEvidence.length ? list(a.architectureEvidence) : '<p class="muted">None.</p>'}
    <p><b>Discovered cloud evidence</b></p>${a.discoveredEvidence.length ? list(a.discoveredEvidence) : '<p class="muted">None — no discovered configuration supported this area.</p>'}
    <p><b>User-provided evidence</b></p>${a.userProvidedEvidence.length ? list(a.userProvidedEvidence) : '<p class="muted">None recorded. CloudCraft does not collect organizational evidence.</p>'}
    ${a.gaps.length ? `<p><b>Technical gaps / not evaluated</b></p>${list(a.gaps)}` : ''}
    ${a.recommendedActions.length ? `<p><b>Recommended actions</b></p>${list(a.recommendedActions)}` : ''}
    <p><b>Organizational evidence required</b></p>${list(a.organizationalEvidenceRequired)}
    <p><b>Auditor assessment required:</b> ${esc(a.auditorAssessmentRequired)}</p>
    <p><b>Conclusion: not concluded.</b> ${esc(a.conclusionReason)}</p>
    <p class="muted">Evidence limitations: ${esc(a.limitations)}</p>`).join('')}
  <h3>Organizational controls CloudCraft cannot evaluate</h3>${list(r.soc1.organizationalControls)}</section>`);

  sections.push(`<section><h2>8. Best-Practice Recommendations</h2><h3>Required remediation</h3>${recTable(r.bestPractices.required, 'None.')}<h3>Recommended improvements</h3>${recTable(r.bestPractices.recommended, 'None.')}<h3>Optional optimizations</h3>${recTable(r.bestPractices.optional, 'None.')}</section>`);
  sections.push(`<section><h2>9. Remediation Plan</h2><h3>Immediate</h3>${recTable(r.remediationPlan.immediate, 'Nothing requires immediate action.')}<h3>Short term</h3>${recTable(r.remediationPlan.shortTerm, 'None.')}<h3>Long term</h3>${recTable(r.remediationPlan.longTerm, 'None.')}</section>`);
  sections.push(`<section><h2>10. Auto-Fix Summary</h2>${table(['Category', 'Open findings'], [
    ['Eligible for safe Auto-Fix', String(r.autoFix.safe.length)], ['Auto-Fix after review', String(r.autoFix.reviewRequired.length)], ['Manual remediation only', String(r.autoFix.manual.length)],
    ['Resolved since previous assessment', r.comparison ? String(r.autoFix.resolvedSincePrevious.length) : 'No previous assessment'],
  ])}${table(['Finding ID', 'Safety', 'Proposed change', 'Resource'], [...r.autoFix.safe, ...r.autoFix.reviewRequired].map((f) => [`<code>${esc(f.findingId)}</code>`, f.autoFix.safety === 'SAFE_AUTOFIX' ? 'Safe' : 'Review required', esc(f.autoFix.description), esc(f.resourceLabels.join(', '))]), 'No open findings are eligible for Auto-Fix.')}
  ${r.autoFix.history.length ? `<h3>Auto-Fix change history</h3>${table(['Timestamp', 'Change', 'By'], r.autoFix.history.map((h) => [esc(date(h.timestamp)), esc(h.summary), esc(h.author)]))}` : ''}</section>`);
  sections.push(`<section><h2>11. Resource Security Inventory</h2>${table(['Resource', 'Type', 'Provider', 'Region', 'Open', 'Encryption', 'Exposure', 'Identity', 'Backup', 'Monitoring'],
    r.inventory.map((x) => [esc(x.resource), esc(x.type), esc(x.provider), esc(x.region), String(x.openFindings), ...[x.encryption, x.exposure, x.identity, x.backup, x.monitoring].map((v) => `<span class="${statusClass(v)}">${esc(v)}</span>`)]))}</section>`);
  sections.push(`<section><h2>12. Framework / Control Mapping</h2>${table(['Finding', 'Well-Architected', 'Security guidance', 'SOC 1 area'], r.mapping.map((x) => [`<code>${esc(x.findingId)}</code><br>${esc(x.title)}`, esc(x.wellArchitected), esc(x.securityGuidance), esc(x.soc1)]), 'No findings to map.')}</section>`);
  if (r.comparison) {
    const c = r.comparison;
    sections.push(`<section><h2>13. Comparison With Previous Assessment</h2>${table(['Measure', 'Value'], [
      ['Previous assessment', `${esc(date(c.previousCreatedAt))} (revision ${c.previousRevision})`], ['Security score', `${score(c.securityScore.previous)} → ${score(c.securityScore.current)}`],
      ['Coverage', `${c.coverage.previous ?? '—'}% → ${c.coverage.current ?? '—'}%`], ['New / resolved / unchanged', `${c.newFindings.length} / ${c.resolvedFindings.length} / ${c.unchangedCount}`], ['Regressions', String(c.regressions.length)],
    ])}${c.rulesetChanged ? '<p class="warn">The ruleset version changed between assessments.</p>' : ''}
    <h3>New findings</h3>${table(['Finding ID', 'Severity', 'Title'], c.newFindings.map((f) => [`<code>${esc(f.findingId)}</code>`, sevBadge(f.severity), esc(f.title)]))}
    <h3>Resolved findings</h3>${table(['Finding ID', 'Severity', 'Title'], c.resolvedFindings.map((f) => [`<code>${esc(f.findingId)}</code>`, sevBadge(f.severity), esc(f.title)]))}</section>`);
  }
  sections.push(`<section><h2>Appendix A — Rule Reference</h2>${table(['Rule ID', 'Provider', 'Service', 'Check', 'Severity', 'Control refs'], r.appendix.rules.map((x) => [esc(x.id), esc(x.provider), esc(x.service), esc(x.title), sevBadge(x.severity), esc(x.references)]))}</section>`);
  sections.push(`<section><h2>Appendix B — Official References</h2>${table(['Framework', 'Identifier', 'Title', 'Verification'], r.appendix.references.map((x) => [esc(x.framework), esc(x.identifier ?? '—'), x.url ? `<a href="${esc(x.url)}">${esc(x.title)}</a>` : esc(x.title), esc(VERIFICATION_LABEL[x.verification])]))}</section>`);
  sections.push(`<section><h2>Appendix C — Methodology &amp; Definitions</h2>${list(r.appendix.methodology)}${table(['Term', 'Definition'], r.appendix.definitions.map((d) => [esc(d.term), esc(d.definition)]))}</section>`);
  sections.push(`<section><h2>Appendix D — Controls Not Evaluated</h2>${table(['ID', 'Control', 'Resources', 'Why not evaluated / evidence needed'], r.appendix.notEvaluated.map((x) => [`<code>${esc(x.id)}</code>`, esc(x.control), esc(x.resources), `${esc(x.availability)}<br>${esc(x.requiredData)}`]), 'All applicable checks were evaluated.')}</section>`);
  sections.push(`<section><h2>Appendix E — Limitations</h2>${list(r.appendix.limitations)}</section>`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.title)} — ${esc(m.projectName)}</title>
<style>
:root{--navy:#0B2545;--accent:#1F5FAD;--text:#1F2937;--muted:#64748B;--rule:#D6DEE8;--zebra:#F4F7FA}
body{font:14px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:var(--text);background:#fff;margin:0}
main{max-width:960px;margin:0 auto;padding:32px 20px}
section{margin:0 0 40px;page-break-before:always}section:first-child{page-break-before:auto}
h1{font-size:30px;color:#fff;margin:4px 0}h2{color:var(--navy);border-bottom:2px solid var(--accent);padding-bottom:4px}h3{color:var(--navy);margin-top:22px}h4{margin:18px 0 4px}
.cover{background:var(--navy);color:#dbe6f3;padding:32px;border-radius:6px}.cover table td{color:var(--text);background:#fff}.brand{letter-spacing:4px;color:#9FB6D3;margin:0}.project{font-size:18px}.badge{display:inline-block;background:#F59E0B;color:var(--navy);font-weight:700;padding:4px 10px;border-radius:4px;font-size:12px;margin-bottom:14px}
table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-size:12.5px}th{background:var(--navy);color:#fff;text-align:left;padding:6px}td{padding:6px;border-bottom:1px solid var(--rule);vertical-align:top}tbody tr:nth-child(even) td{background:var(--zebra)}
.pill{display:inline-block;color:#fff;font-size:11px;font-weight:700;padding:1px 7px;border-radius:3px}
.muted{color:var(--muted)}.ok{color:#15803D}.bad{color:#B91C1C}.warn{color:#A16207}.na{color:var(--muted)}
.callout{padding:12px 14px;border-left:4px solid var(--accent);background:#EEF3F9;margin:12px 0}.callout.warn{border-color:#B45309}.callout.bad{border-color:#B91C1C}
.counts{display:flex;gap:10px;flex-wrap:wrap}.counts div{border:1px solid var(--rule);border-radius:6px;padding:8px 14px;text-align:center;min-width:90px}.counts b{display:block;font-size:22px}.counts span{font-size:11px;color:var(--muted)}
.finding{border:1px solid var(--rule);border-left:4px solid;border-radius:4px;padding:12px 16px;margin:14px 0;page-break-inside:avoid}.finding h4{margin:6px 0;color:var(--navy);font-size:16px}
.finding dl{display:grid;grid-template-columns:170px 1fr;gap:2px 10px;margin:6px 0}.finding dt{color:var(--muted);font-weight:600}.finding dd{margin:0}.review{color:#6D28D9}
code{font-size:12px;background:#F1F5F9;padding:1px 4px;border-radius:3px;word-break:break-all}
footer{color:var(--muted);font-size:12px;border-top:1px solid var(--rule);padding-top:10px}
@media print{main{max-width:none}a{color:inherit}}
</style></head><body><main>${sections.join('\n')}
<footer>${esc(m.reportId)} · Ruleset ${esc(m.rulesetVersion)} · Architecture revision ${m.architectureRevision} · Design-time assessment — not an audit opinion.</footer></main></body></html>`;
}
