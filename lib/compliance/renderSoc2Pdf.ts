/**
 * The SOC 2 Type 1 readiness report as a PDF (server only), for reading and review. The Word version (renderSoc2Docx) is the one to edit and hand to the CPA firm;
 * this one carries the same content in the same order, so what is reviewed here is what is edited there. It shares its layout with the control reports.
 */
import { Page, K, P, CW, s, longDate, controls, addFooters, type Doc } from './renderControlPdf';
import { SOC2_CATEGORY_LABEL, SOC2_CATEGORY_RANGE, SOC2_CRITERIA_BY_ID } from './soc2/criteria';
import { SCORE_LABEL, SCORE_MEANING, type Score } from './types';
import { EVIDENCE_WINDOW_DAYS } from './scoring';
import { periodRows, periodSentence } from './snapshots';
import { configSummary } from './configuration';
import { bridgeLetter, representationLetter } from './soc2Letters';
import { categoryRows, conclusion, consistencyChecks, controlLibrary, cpaItems, criterionRows, gapRegister, independence, remediationTracker, worksheetRows, TO_RECORD } from './soc2Extras';
import type { ReadinessReport } from './report';

const TBD = '[to be completed by management]';
const providersOf = (r: ReadinessReport) => r.system.providers.map((x) => (x === 'aws' ? 'Amazon Web Services' : 'Microsoft Azure'));
const openOf = (r: ReadinessReport) => r.findings.filter((f) => f.status === 'open' || f.status === 'in_progress');
const STATUS = { open: 'Open', in_progress: 'In progress', closed: 'Closed', risk_accepted: 'Risk accepted' } as const;

function cover(p: Page, r: ReadinessReport) {
  const d = p.doc;
  d.rect(0, 0, P.w, 330).fillColor(K.navy).fill(); d.rect(0, 330, P.w, 5).fillColor(K.teal).fill();
  d.font('Helvetica-Bold').fontSize(9).fillColor('#9FC5E8').text('SOC 2 TYPE 1 READINESS', P.m, 120, { characterSpacing: 2 });
  d.font('Helvetica-Bold').fontSize(31).fillColor(K.white).text('SOC 2 Type 1 readiness report', P.m, 142, { width: CW });
  d.font('Helvetica').fontSize(15).fillColor('#D7E3F1').text(s(`${r.company}  |  ${r.system.name}`), P.m, d.y + 8, { width: CW });
  const facts: Array<[string, string]> = [['Control status as of', longDate(r.asOf)], ['Trust services categories', r.categories.map((c) => SOC2_CATEGORY_LABEL[c]).join(', ')], ['Version', `${r.version}  (draft for management and CPA review)`], ['Report ID', r.reportId], ['Prepared by', r.preparedBy || TBD], ['Generated', `${longDate(r.generatedAt)} with CloudBuilder`]];
  facts.forEach(([k, v], i) => {
    const x = P.m + (i % 2) * (CW / 2); const y = 372 + Math.floor(i / 2) * 50;
    d.font('Helvetica').fontSize(8).fillColor(K.muted).text(s(k.toUpperCase()), x, y, { characterSpacing: 1 });
    d.font('Helvetica-Bold').fontSize(12).fillColor(K.text).text(s(v), x, y + 13, { width: CW / 2 - 16 });
  });
  d.y = 560;
  p.box('This is a readiness report that the company prepared with CloudBuilder. It is not a SOC 2 report, it gives no opinion on the company, and it does not say the company meets any standard. A SOC 2 report can only be issued by an independent CPA firm after its own examination. Use this report to find and fix gaps first, and to give the CPA firm a clear starting point.', '#CA8A04', '#FFF7E0');
}


const bullets = (p: Page, xs: string[]) => xs.forEach((x) => p.text(`- ${x}`, { after: 3 }));
const lead = (p: Page, t: string) => p.text(t, { color: K.muted, after: 6 });

function summary(p: Page, r: ReadinessReport) {
  const d = p.doc; const sm = r.summary;
  p.h1('1. Executive Summary');
  const y0 = d.y;
  d.roundedRect(P.m, y0, CW, 78, 6).fillColor(K.band).fill(); d.rect(P.m, y0, 5, 78).fillColor(K.ready[r.readiness]!).fill();
  d.font('Helvetica').fontSize(8).fillColor(K.muted).text('OVERALL DESIGN READINESS', P.m + 18, y0 + 11, { characterSpacing: 1 });
  d.font('Helvetica-Bold').fontSize(19).fillColor(K.ready[r.readiness]!).text(s(r.readiness), P.m + 18, y0 + 25, { width: 170 });
  d.font('Helvetica-Bold').fontSize(9).fillColor(K.text).text(s(`As of ${longDate(r.asOf)}`), P.m + 200, y0 + 11, { width: CW - 216 });
  d.font('Helvetica').fontSize(9.5).fillColor(K.text).text(s(conclusion(r)), P.m + 200, y0 + 25, { width: CW - 216, lineGap: 2 });
  d.y = y0 + 96;
  p.h2('Results at a glance', 100);
  p.table([{ h: 'Result', w: 2 }, { h: 'Meaning (readiness score)', w: 6.4 }, { h: 'Controls', w: 1, align: 'right' }], [
    ...([4, 3, 2, 1, 0] as Score[]).map((n) => [`${n}  ${SCORE_LABEL[n]}`, SCORE_MEANING[n], String(sm.byScore[n])]),
    ['Not assessed', 'Nobody has assessed the control, so it is not scored. It keeps the report from being called ready.', String(sm.notAssessed)], ['Not applicable', 'Out of scope with a written reason.', String(sm.notApplicable)], ['Total', '', String(sm.total)],
  ], { size: 8.5, color: (row, i) => (i === 0 && /^\d/.test(row[0]!) ? K.score[Number(row[0]![0])] : undefined) });
  p.h2('Principal findings', 90);
  p.table([{ h: 'Finding', w: 1 }, { h: 'Severity', w: 1 }, { h: 'Summary', w: 5 }, { h: 'Owner', w: 1.7 }, { h: 'Target date', w: 1.4 }], openOf(r).slice(0, 5).map((f) => [f.id, f.severity, f.title, f.owner || 'No owner', f.targetDate ?? 'No date']), { size: 8.5, empty: 'No open findings.' });
  p.h2('Recommendation', 80);
  p.text(MEANING[r.readiness]!, { after: 4 });
  cpaItems(r).filter((c) => c.state !== 'Done').slice(0, 6).forEach((c) => p.text(`- ${c.label}. ${c.detail}`, { size: 9, after: 3 }));
}
const MEANING: Record<string, string> = {
  Ready: 'Every control in scope operates and no serious finding is open. Ask the CPA firm to begin.',
  'Ready with conditions': 'Every control is at least implemented, but some are not yet shown to operate, or findings are still open. Close the findings below before the CPA firm starts.',
  'Not ready': 'At least one control is missing, only informal, or has a serious open finding. Fix these first.',
  Incomplete: 'Some controls have not been assessed, so no conclusion can be drawn yet. Assign owners and answer for every control.',
};

function scope(p: Page, r: ReadinessReport) {
  const sys = r.system; const cs = configSummary(r.configuration);
  p.h1('2. Scope, Objectives and Limitations');
  p.h2('2.1 Objective', 60);
  p.text(`To assess, as of ${longDate(r.asOf)}, whether the controls of ${r.company} for ${sys.name} are designed and in place, so that gaps can be fixed before an independent CPA firm begins a SOC 2 Type 1 examination, and so that the firm has a clear starting point. Type 1 is about the design of controls at one date. It does not say the controls worked over a period.`, { after: 4 });
  p.h2('2.2 System boundary', 80);
  p.table([{ h: '', w: 2 }, { h: '', w: 6 }], [
    ['System', `${sys.name}${sys.description ? `: ${sys.description}` : ''}`], ['Environment', sys.environment || TBD], ['Cloud providers', providersOf(r).join(' and ') || TBD], ['Regions', sys.regions.join(', ') || TBD],
    ['Main components', sys.services.join('; ') || TBD], ['Third-party services', sys.thirdParties.length ? sys.thirdParties.map((x) => `${x.vendor} (${x.use})`).join('; ') : 'None drawn in the design'],
    ['Configuration examined', cs.settings ? `${cs.settings} settings on ${cs.resources} resources, ${cs.fromAccount} read from the cloud account. See Appendix G.` : 'No resource settings were examined.'],
  ], { size: 9 });
  p.h2('2.3 Criteria assessed', 90);
  p.table([{ h: 'Category', w: 3 }, { h: 'Criteria', w: 2 }, { h: 'Included', w: 4.4 }], [
    ...(['security', 'availability', 'confidentiality'] as const).map((c) => [SOC2_CATEGORY_LABEL[c] + (c === 'security' ? ' (Common Criteria)' : ''), SOC2_CATEGORY_RANGE[c], r.categories.includes(c) ? `Yes (${r.defs.filter((d) => SOC2_CRITERIA_BY_ID.get(d.group)?.category === c).length} controls)` : `No: ${r.exclusions.find((e) => e.category === SOC2_CATEGORY_LABEL[c])?.reason || TBD}`]),
    ['Processing Integrity', 'PI1.1 to PI1.5', 'No: not assessed by CloudBuilder. The company and the CPA firm decide whether it is needed.'], ['Privacy', 'P1.0 to P8.1', 'No: not assessed by CloudBuilder. The company and the CPA firm decide whether it is needed.'],
  ]);
  p.text("The criteria are the AICPA trust services criteria. The names and one-line meanings used here are written in plain words and are not the AICPA's text; the CPA firm works from the official criteria, so confirm every reference against them.", { size: 8.5, color: K.muted, after: 4 });
  p.h2('2.4 Limitations', 80);
  bullets(p, ['This report is an internal readiness assessment. It is not an assurance report and it gives no opinion on the system.', 'The external opinion is issued by an independent CPA firm after its own examination.', 'Evidence was reviewed as provided by control owners. Items not provided are reported as limitations (section 2.6), never assumed to exist.', 'Design conclusions relate only to the date stated. Later changes are outside this assessment.']);
  p.h2('2.5 Significant changes during the period', 90);
  p.text('Record every change to the system, its services, its providers, its people or its controls up to the assessment date, including changes the company did not treat as significant, so the CPA firm can judge that. CloudBuilder does not record changes yet: list them here, using the architecture version history as a starting point.', { after: 4 });
  p.table([{ h: 'Date', w: 1 }, { h: 'Change', w: 3 }, { h: 'Systems affected', w: 2 }, { h: 'Criteria', w: 1.2 }, { h: 'Control impact', w: 1.6 }, { h: 'Reviewed by', w: 1.2 }], [[TO_RECORD, '', '', '', '', '']], { size: 8 });
  p.h2('2.6 Limitations register', 90);
  lead(p, 'Every item that was not provided, could not be tested, or limits a conclusion. A limitation stays open until the evidence is provided or the conclusion is revised.');
  p.table([{ h: 'ID', w: 0.8 }, { h: 'Item not provided or not testable', w: 3 }, { h: 'Control', w: 1.1 }, { h: 'Effect on conclusion', w: 3 }, { h: 'Owner', w: 1.1 }, { h: 'Resolved', w: 1.1 }], r.limitations.map((l) => [l.id, l.item, l.controlId ?? 'Report', l.effect, '[to be assigned]', '']), { size: 7.8, empty: 'No limitations recorded.' });
}

function method(p: Page, r: ReadinessReport) {
  const ind = independence(r);
  p.h1('3. Methodology and Scoring');
  p.h2('3.1 Steps performed for each control', 70);
  p.text('Confirm the control objective, owner, frequency and criteria mapping. Document the control activity well enough that someone else could repeat it. Inspect design and implementation: run the checks CloudBuilder can run on the architecture and on the cloud account, review the evidence attached, and record a walkthrough with the owner. Record the score, the confidence and what would raise the score. Have someone other than the owner review it.', { after: 4 });
  p.h2('3.2 Scoring scale', 120);
  p.table([{ h: 'Score', w: 1 }, { h: 'Status', w: 1.4 }, { h: 'Required condition', w: 6.4 }], [...([0, 1, 2, 3, 4] as Score[]).map((n) => [String(n), SCORE_LABEL[n], SCORE_MEANING[n]]), ['N/A', 'Not applicable', 'Out of scope with a written reason (at least 10 characters). Review it with the CPA firm.']], { size: 8.5, color: (row, i) => (i === 0 && /^\d$/.test(row[0]!) ? K.score[Number(row[0])] : undefined) });
  p.text('Not assessed. A control nobody has answered for is recorded as Not assessed. It is never shown as 0, 3 or 4. An in-scope control that is not assessed prevents an overall readiness conclusion.', { size: 9, after: 3 });
  p.text("Scoring caps. A control whose check fails is capped at 2 until the check passes. A control resting only on the owner's statement is capped at 1. A score of 4 needs a live check or a system export and a review by someone who does not own the control.", { size: 9, after: 4 });
  p.h2('3.3 Evidence confidence', 100);
  p.table([{ h: 'Level', w: 1.4 }, { h: 'Meaning', w: 7.4 }], [['High', 'A check read the setting from the cloud account, or a system export backs it, and an independent person reviewed it.'], ['Medium', 'Evidence is credible but includes manual preparation, a check on the design only, or a single item.'], ['Low', "Rests on the owner's word alone, or is incomplete, undated, or not reproducible."]], { size: 8.5 });
  p.text(`Evidence date rule: evidence counts as current if it is dated no more than ${EVIDENCE_WINDOW_DAYS} days before the assessment date, is not expired, and shows the control as it stood. Older evidence is listed as a limitation and does not support a score.`, { size: 9, after: 4 });
  p.h2('3.4 Independence', 100);
  p.text('The reviewer of a control must not be its owner. CloudBuilder refuses a review by the owner, and the reviewer of the whole report cannot be the person who prepared it. A company that has CloudBuilder-assisted preparation does not sign off its own control design: the independent reviewer named in section 9 signs.', { after: 4 });
  p.table([{ h: 'Assessed controls', w: 1.4 }, { h: 'Reviewed by someone else', w: 1.8 }, { h: 'Not yet reviewed', w: 1.4 }, { h: 'Reviewer is the owner', w: 1.6 }], [[String(ind.assessed), String(ind.independentlyReviewed), String(ind.notYetReviewed), ind.sameAsOwner.length ? ind.sameAsOwner.join(', ') : '0']], { size: 9 });
}

function results(p: Page, r: ReadinessReport) {
  p.h1('4. Results by Control Domain');
  lead(p, 'Summary by trust services category, the grouping the CPA firm reads. Counts and averages exclude not-assessed and not-applicable controls.');
  p.table([{ h: 'Category', w: 2.2 }, { h: 'Criteria in scope', w: 1.3, align: 'right' }, { h: 'Controls', w: 1, align: 'right' }, { h: 'Average', w: 1.1, align: 'right' }, { h: 'Not assessed', w: 1.2, align: 'right' }, { h: 'Open findings', w: 1.2, align: 'right' }],
    categoryRows(r).map((c) => [c.category, String(c.criteria), String(c.controls), c.average === null ? 'n/a' : String(c.average), String(c.notAssessed), String(c.openFindings)]), { size: 9 });
  p.h2('Summary by criterion, for management use', 100);
  p.table([{ h: 'Criterion', w: 3.2 }, { h: 'Controls', w: 0.9, align: 'right' }, { h: 'Average', w: 0.9, align: 'right' }, { h: 'Confidence', w: 1.1 }, { h: 'Key observation', w: 3.4 }], criterionRows(r).map((c) => [c.criterion, String(c.controls), c.average === null ? 'n/a' : String(c.average), c.confidence, c.observation]), { size: 7.8 });
}

function controlSection(p: Page, r: ReadinessReport) {
  p.h1('5. Control-Level Design Assessment');
  lead(p, `${r.results.length} controls${r.summary.notApplicable ? ` (${r.summary.notApplicable} marked not applicable)` : ''}, grouped by criterion. For each control: who owns it, how it scores, what supports the score, and what would raise it.`);
  controls(p, r, { heading: false });
  p.h2('5.2 Privacy criteria control detail', 80);
  p.text('Privacy is not in scope of this report: CloudBuilder does not assess the privacy criteria. If the company and the CPA firm decide to include Privacy, record each criterion and its controls here, and confirm the references against the official criteria.', { color: K.muted });
}

function findings(p: Page, r: ReadinessReport) {
  p.h1('6. Findings and Remediation');
  lead(p, 'A finding is raised for every control that is missing, informal, only partly implemented, or has a failing check. Each records the condition, the criterion affected, the cause and effect, and a recommendation.');
  if (r.findings.length === 0) p.text('No findings.', { color: K.muted });
  const d = p.doc;
  for (const f of r.findings) {
    p.ensure(110); const y = d.y;
    p.pill(f.severity.toUpperCase(), P.m, y, K.white, K.sev[f.severity]!);
    d.font('Helvetica-Bold').fontSize(8.5).fillColor(K.muted).text(s(`${f.id}   ${f.controlId}  ${f.group}   |   ${STATUS[f.status]}`), P.m + 62, y + 3, { lineBreak: false });
    d.y = y + 17; p.text(f.title, { bold: true, size: 10, color: K.navy, after: 1 });
    p.text(`Condition: ${f.condition}`, { size: 9, after: 1 }); p.text(`Cause: ${f.cause}`, { size: 9, color: K.muted, after: 1 }); p.text(`Effect: ${f.effect}`, { size: 9, color: K.muted, after: 1 });
    p.text(`Recommendation: ${f.recommendation}`, { size: 9, bold: true, after: 8 });
  }
  p.h2('6.2 Prior-period findings follow-up', 110);
  lead(p, 'List every finding from the previous internal or external report. Each one shows whether the fix was made, with evidence, and whether it was retested in the current period. A finding that recurs is raised again above. CloudBuilder does not hold earlier reports, so record them here.');
  p.table([{ h: 'Prior finding', w: 1.1 }, { h: 'Prior report, date', w: 1.4 }, { h: 'Original condition', w: 2.6 }, { h: 'Remediation', w: 2 }, { h: 'Evidence of closure', w: 1.8 }, { h: 'Status now', w: 1.1 }, { h: 'Retested by, date', w: 1.3 }], [[TO_RECORD, '', '', '', '', '', '']], { size: 7.8 });
}

function response(p: Page, r: ReadinessReport) {
  p.h1('7. Management Response and Remediation Plan');
  lead(p, "Management responds to each finding. A finding is closed only after the corrective action is retested and the evidence is filed. Closing needs someone other than the finding's owner.");
  p.table([{ h: 'Finding', w: 1 }, { h: 'Management response', w: 3.6 }, { h: 'Action owner', w: 1.5 }, { h: 'Milestones', w: 1.5 }, { h: 'Acceptance criteria', w: 1.6 }, { h: 'Retest date and result', w: 1.6 }],
    r.findings.map((f) => [f.id, f.managementResponse || TBD, f.owner || 'No owner', TO_RECORD, TO_RECORD, f.retestedAt ? `${f.retestedAt.slice(0, 10)}: ${f.status === 'closed' ? 'passed' : 'not closed'}` : 'Not retested']), { size: 7.8, empty: 'No findings to respond to.' });
}

function cpa(p: Page, r: ReadinessReport) {
  p.h1('8. Readiness for CPA Review');
  lead(p, 'CloudBuilder prepares this report to help the CPA firm plan its own examination. The CPA firm decides what it relies on and performs its own testing. A check is marked Done only when the data shows it.');
  p.h2('8.1 Consistency checks before the CPA firm begins', 100);
  p.table([{ h: 'Check', w: 1.8 }, { h: 'What is compared', w: 2.8 }, { h: 'Result', w: 1 }, { h: 'Detail', w: 3.2 }], consistencyChecks(r).map((c) => [c.check, c.compared, c.result, c.detail]), { size: 7.6, color: (row, i) => (i === 2 ? (row[2] === 'Pass' ? K.score[3] : row[2] === 'Fail' ? K.score[0] : row[2] === 'Note' ? K.score[2] : K.none) : undefined) });
  p.h2('8.2 Items the CPA firm will request', 100);
  p.table([{ h: 'Item', w: 4 }, { h: 'Where', w: 1.2 }, { h: 'State', w: 0.9 }, { h: 'Detail', w: 3.2 }], cpaItems(r).map((c) => [c.label, c.where, c.state, c.detail]), { size: 7.8, color: (row, i) => (i === 2 ? (row[2] === 'Done' ? K.score[3] : row[2] === 'Open' ? K.score[1] : K.score[2]) : undefined) });
  p.h2('8.3 Questions for the CPA firm', 100);
  bullets(p, ['Which categories will the report cover, and is the cloud provider carved out or included as a subservice organisation?', 'What date should the Type 1 report be as of, and is evidence dated within a year of it acceptable?', 'How will controls that rest on a statement alone be treated, and what evidence would you rather see?', 'How should findings that are still open on the report date be described?']);
  p.h1('9. Sign-off');
  lead(p, 'By signing, each person confirms the role stated. None of these signatures is an opinion of the CPA firm. The independent reviewer must not operate any control in scope.');
  const sg = (k: 'preparer' | 'reviewer' | 'management', label: string) => { const x = r.signoffs.find((y) => y.role === k); return [label, x ? x.name : 'Not signed', x ? 'Recorded in CloudBuilder' : '', x ? longDate(x.signedAt) : '']; };
  p.table([{ h: 'Role', w: 3 }, { h: 'Name', w: 2.4 }, { h: 'Signature', w: 2 }, { h: 'Date', w: 1.4 }], [sg('preparer', `Prepared by (${r.preparedBy || 'company'})`), sg('reviewer', 'Independent reviewer'), sg('management', 'Management acknowledgement (CEO or CISO)'), ['Received by the CPA firm', '', '', '']]);
  p.h2('Document control', 80);
  p.table([{ h: 'Version', w: 1 }, { h: 'Date', w: 1.5 }, { h: 'By', w: 2 }, { h: 'Change', w: 4 }], r.history.map((h) => [h.version, h.date, h.by, h.change]));
}

function appendices(p: Page, r: ReadinessReport) {
  const sys = r.system; const providers = providersOf(r); const cats = r.categories.map((c) => SOC2_CATEGORY_LABEL[c]).join(', '); const cs = configSummary(r.configuration);
  const orgs = [...providers.map((x) => ({ name: x, what: 'Cloud hosting: physical security, environment, network and host infrastructure', cloud: true })), ...sys.thirdParties.map((x) => ({ name: x.vendor, what: `${x.use}. Data held: ${x.dataHeld || 'not stated'}`, cloud: false }))];

  p.h1('Appendix A. Control Matrix');
  lead(p, 'One row for each control. This is the list the CPA firm tests against. Edit the activity so that it matches what the company really does.');
  p.table([{ h: 'Control', w: 0.9 }, { h: 'Criterion', w: 0.9 }, { h: 'What is done', w: 4.6 }, { h: 'Owner role', w: 1.4 }, { h: 'How often', w: 1.2 }, { h: 'Evidence to show', w: 2.8 }], r.defs.map((d) => [d.id, d.group, `${d.title}. ${d.activity ?? ''}`, d.ownerRole, d.frequency ?? '', d.evidence.join('; ')]), { size: 7 });

  p.h1('Appendix B. Control Assessment Worksheet');
  lead(p, "One row for each control, filled in with what CloudBuilder knows. The population source and the walkthrough are recorded by the team. Keep the worksheet with the control's evidence.");
  p.table([{ h: 'Control, criterion', w: 2.2 }, { h: 'Objective and activity', w: 4 }, { h: 'Owner, frequency', w: 1.4 }, { h: 'Population, walkthrough', w: 1.4 }, { h: 'Score, confidence', w: 1.2 }, { h: 'Basis; next step', w: 2.6 }, { h: 'Reviewer', w: 1.1 }],
    worksheetRows(r).map((w) => [w.control, `${w.objective} ${w.activity}`, w.ownerFrequency, `${w.population}`, w.score, `${w.basis}. ${w.nextStep}`, w.reviewer]), { size: 6.6 });

  p.h1('Appendix C. Walkthrough Workpaper');
  lead(p, 'One walkthrough per control: who was interviewed, what was observed, and which documents were inspected. A design conclusion needs the walkthrough and at least one design document. CloudBuilder does not record walkthroughs yet; complete the cells below.');
  p.table([{ h: 'Control', w: 1 }, { h: 'Participant', w: 1.8 }, { h: 'Date', w: 1 }, { h: 'Documents inspected', w: 2.6 }, { h: 'What was observed', w: 2.6 }, { h: 'Design conclusion', w: 1.8 }, { h: 'Preparer, reviewer', w: 1.4 }], r.results.map((x) => [x.id, x.owner || '', '', '', '', '', '']), { size: 7.2 });

  p.h1('Appendix D. Evidence Index');
  lead(p, 'Every piece of evidence attached to a control, with who added it, when it was produced, the period it covers and its full SHA-256 fingerprint. The CPA firm uses the fingerprint to confirm a file has not changed; two files never share one.');
  p.table([{ h: 'Evidence', w: 0.8 }, { h: 'Control', w: 1.1 }, { h: 'Description', w: 2.4 }, { h: 'Source', w: 1.1 }, { h: 'Date', w: 1 }, { h: 'Period', w: 0.9 }, { h: 'Prepared by', w: 1.2 }, { h: 'SHA-256 of the file as filed', w: 3.4 }],
    r.evidenceIndex.map((e) => [e.ref, e.controls.join(', '), `${e.title}${e.fileName ? ` (${e.fileName})` : ''}`, e.origin === 'system' ? 'System export' : 'By hand', e.collectedAt, e.validUntil ? `to ${e.validUntil}` : 'Point in time', e.uploadedBy ?? '', e.sha256 ?? (e.kind === 'link' ? 'Link, no file' : e.kind === 'note' ? 'Written note, no file' : 'none')]), { size: 6.4, empty: 'No evidence has been attached yet.' });

  p.h1('Appendix E. Finding Template');
  lead(p, 'The fields recorded for every finding (section 6). Use this when a finding is raised outside CloudBuilder.');
  p.table([{ h: 'Field', w: 2.4 }, { h: 'Entry', w: 6 }], [['Finding ID', '[F-xxx]'], ['Control and criterion', '[CTL-xx, CCx.x]'], ['Severity', '[High / Medium / Low]'], ['Condition', '[What was found]'], ['Cause', '[Why it happened]'], ['Effect', '[What it weakens]'], ['Recommendation', '[What to do]'], ['Management response', '[What was done, or why the risk is accepted]'], ['Action owner and target date', '[Name; date]'], ['Milestones and acceptance criteria', '[Steps; what shows it is fixed]'], ['Retest evidence', '[Evidence ID; retested by; date; result]'], ['Status', '[Open / In progress / Closed / Risk accepted]']], { size: 8.5 });

  p.h1('Appendix F. Gap Register and Remediation Tracker');
  lead(p, 'Gaps found during readiness work and the remediation of each one. A gap closes only after retest evidence is filed. Keep closed items for the whole engagement.');
  p.h2('F.1 Gap register', 80);
  p.table([{ h: 'Gap', w: 1.3 }, { h: 'Control', w: 0.9 }, { h: 'Criterion', w: 0.9 }, { h: 'Gap description', w: 4.4 }, { h: 'Owner', w: 1.4 }, { h: 'Target', w: 1.1 }, { h: 'Status', w: 1 }], gapRegister(r).map((g) => [g.id, g.control, g.criterion, g.description, g.owner, g.target, g.status]), { size: 7, empty: 'No gaps.' });
  p.h2('F.2 Remediation tracker', 80);
  p.table([{ h: 'Finding', w: 1 }, { h: 'Action', w: 3.6 }, { h: 'Owner', w: 1.4 }, { h: 'Evidence of closure', w: 2 }, { h: 'Retest date', w: 1 }, { h: 'Result', w: 1.3 }, { h: 'Closed by, date', w: 1.4 }], remediationTracker(r).map((x) => [x.id, x.action, x.owner, x.closure, x.retestDate, x.retestResult, x.closedBy]), { size: 7, empty: 'No findings.' });

  p.h1('Appendix G. System Configuration');
  lead(p, cs.settings === 0 ? 'No resource settings were examined.' : `The settings of every resource that the assessment examined: ${cs.settings} settings on ${cs.resources} resources. "Design" means the value was set in CloudBuilder; "Discovered" was read from the cloud account; "Live" was verified through the provider. ${cs.failing} fail their check, ${cs.unclear} could not be decided, and ${cs.differing} differ between the design and the cloud account. Values that could hold a secret are never shown.`);
  p.table([{ h: 'Resource', w: 1.8 }, { h: 'Type, region', w: 1.7 }, { h: 'Setting', w: 2 }, { h: 'Observed', w: 1.5 }, { h: 'Expected', w: 1.5 }, { h: 'Result', w: 0.8 }, { h: 'Source', w: 1.1 }, { h: 'In account', w: 1.1 }],
    r.configuration.map((c) => [`${c.resource} (${c.provider})`, `${c.type}, ${c.region}`, c.setting, c.observed, c.expected || '-', c.result, `${c.source}${c.readAt ? ` ${c.readAt.slice(0, 10)}` : ''}`, c.accountValue ?? '']), { size: 7, empty: 'No resource settings were examined.', color: (row, i) => (i === 5 ? (row[5] === 'Pass' ? K.score[3] : row[5] === 'Fail' ? K.score[0] : K.score[2]) : undefined) });

  p.h1('Appendix H. Draft System Description Outline and Draft Management Assertion');
  lead(p, "Drafts for management to write, review and sign. CloudBuilder does not author management's assertion or sign the system description. The CPA firm assesses both, and the final wording is agreed with the CPA firm.");
  p.h2('H.1 System description outline', 80);
  p.table([{ h: 'Heading', w: 2.4 }, { h: 'Draft', w: 6 }], [
    ['Services provided', sys.description ? `${sys.name}: ${sys.description}` : `${TBD}: what the system does for customers.`],
    ['Commitments and requirements', `${TBD}: the service commitments made to customers (availability, security, confidentiality) and the requirements that follow.`],
    ['Infrastructure', providers.length ? `Hosted on ${providers.join(' and ')}${sys.regions.length ? ` in ${sys.regions.join(', ')}` : ''}. Components: ${sys.services.join('; ') || 'none listed'}. Settings are in Appendix G.` : TBD],
    ['Software', TBD], ['People', `${TBD}: the teams that operate the system and their roles (see the owners in Appendix A).`], ['Procedures', `${TBD}: the policies and procedures behind the controls in Appendix A.`],
    ['Data', `${TBD}: the kinds of customer and company data the system holds.`], ['System boundary', `${sys.environment ? `The ${sys.environment} environment. ` : ''}${TBD}: what is inside and outside the boundary.`],
    ['Criteria and controls', `${cats}. The controls are in Appendix A.`], ['Subservice organisations', orgs.map((o) => o.name).join('; ') || TBD],
    ['Complementary controls', 'See Appendix I.'], ['Significant changes and incidents', `${TBD}: changes to the system and any incidents up to ${longDate(r.asOf)}.`],
  ], { size: 8.5 });
  p.h2('H.2 Draft management assertion', 90);
  lead(p, 'Management writes and signs this. CloudBuilder does not sign it and does not say it is true. The wording below is a starting point; the CPA firm confirms the final text.');
  p.box(`We, the management of ${r.company}, are responsible for designing, implementing and operating controls over ${sys.name}. We confirm, to the best of our knowledge and belief, that as of ${longDate(r.asOf)}: (1) the description of ${sys.name} fairly presents the system as it was designed and implemented on that date; and (2) the controls described were suitably designed to meet the applicable trust services criteria (${cats}), if they operated as described. [The CPA firm confirms the final wording.]`);
  p.text(`Signed: ${TBD}.   Name and title: ${TBD}.   Date: ${TBD}.`, { after: 6 });

  p.h1('Appendix I. Complementary Controls Register');
  lead(p, 'Every control that the description assumes customers operate (CUECs), and every control that a provider must operate (CSOCs). The CPA firm checks each one against customer contracts and provider reports. Each needs a status of Confirmed or Gap; a gap closes only with evidence. The entries below are suggestions: management confirms what applies.');
  p.h2('I.1 Complementary user entity controls (CUECs)', 80);
  p.table([{ h: 'ID', w: 0.9 }, { h: 'CUEC as stated in the description', w: 4.4 }, { h: 'Criteria', w: 1.1 }, { h: 'In customer contracts', w: 1.8 }, { h: 'How communicated', w: 1.6 }, { h: 'Status', w: 1.1 }],
    ['Customers keep their own sign-in credentials secure and use a second factor where offered.', 'Customers review the access given to their own users and remove it when it is no longer needed.', 'Customers tell the company promptly about suspected security incidents affecting their data.', 'Customers configure the service as the documentation describes.'].map((x, i) => [`CUEC-${i + 1}`, x, i < 2 ? 'CC6.1, CC6.2' : i === 2 ? 'CC7.3' : 'CC2.3', TO_RECORD, TO_RECORD, 'Not confirmed']), { size: 7.6 });
  p.h2('I.2 Complementary subservice organisation controls (CSOCs)', 80);
  p.table([{ h: 'ID', w: 1 }, { h: 'Provider and CSOC', w: 4.4 }, { h: 'Criteria', w: 1.1 }, { h: 'Provider report (period)', w: 1.8 }, { h: 'Our complementary control', w: 1.6 }, { h: 'Status', w: 1.1 }],
    providers.flatMap((p0, i) => ['Physical access to the data centres is controlled by the provider.', "Power, cooling and network connectivity of the data centres are the provider's responsibility.", 'The underlying host and virtualization layer is secured and patched by the provider.'].map((x, k) => [`CSOC-${i + 1}.${k + 1}`, `${p0}: ${x}`, k === 0 ? 'CC6.4' : k === 1 ? 'A1.2' : 'CC6.6, CC7.1', TO_RECORD, TO_RECORD, 'Not confirmed'])), { size: 7.6, empty: 'No cloud provider in the design.' });
  p.text('Confirm each criterion reference against the official criteria before use.', { size: 8.5, color: K.muted, after: 4 });

  p.h1('Appendix J. Subservice Organisation Review');
  lead(p, 'The review of each subservice organisation that supports in-scope services. It supports vendor and business partner risk (CC9.2). Complete it for every provider, whether carved out or included.');
  p.h2('J.1 Provider summary', 80);
  p.table([{ h: 'Provider and service', w: 3 }, { h: 'Carve-out or inclusive', w: 1.5 }, { h: 'Report type, period', w: 1.4 }, { h: 'Covers audit period?', w: 1.2 }, { h: 'Bridge letter', w: 1.1 }, { h: 'Opinion, exceptions', w: 1.3 }, { h: 'Reviewed by, date', w: 1.2 }],
    orgs.map((o) => [`${o.name}. ${o.what}`, o.cloud ? 'Usually carve-out; the CPA firm confirms' : TO_RECORD, TO_RECORD, TO_RECORD, TO_RECORD, TO_RECORD, TO_RECORD]), { size: 7.2, empty: 'No provider in the design.' });
  p.h2('J.2 Complementary controls relied on, and gaps', 80);
  p.table([{ h: 'Provider', w: 1.8 }, { h: 'Control relied on', w: 2.8 }, { h: 'Our evidence it operates', w: 1.8 }, { h: 'Gap in provider report', w: 1.6 }, { h: 'Compensating action', w: 1.6 }, { h: 'Status', w: 1 }], providers.map((x) => [x, 'Physical and environmental controls, and host infrastructure', TO_RECORD, TO_RECORD, TO_RECORD, 'Not reviewed']), { size: 7.4, empty: 'No provider in the design.' });
  p.h2('J.3 Review conclusion', 70);
  p.text(`[State whether the providers' controls are adequately covered for the criteria in scope, the gaps that remain, and who accepted the residual risk.] ${TBD}.`, { color: K.muted });

  const letter = (title: string, lines: string[]) => { p.h1(title); lines.forEach((ln) => (ln === '' ? (p.doc.y += 6) : p.text(ln, { size: 9.5, after: 3 }))); };
  letter('Appendix K. Bridge Letter Template', bridgeLetter(r));
  letter('Appendix L. Management Representation Letter Template', representationLetter(r));

  p.h1('Appendix M. Control Library (Type 1 starting set)');
  lead(p, "A starting set of controls mapped to the criteria. Use it to build Appendix A. Adapt each activity to the company, record any criterion with no control as a gap, and do not add a control to Appendix A without an evidence source. This list is a starting point and does not replace the CPA firm's own review.");
  p.table([{ h: 'Criterion', w: 2.2 }, { h: 'Control activity (starting point)', w: 5 }, { h: 'Typical owner', w: 1.3 }, { h: 'Typical evidence', w: 3 }], controlLibrary().map((x) => [x.criterion, x.activity, x.owner, x.evidence]), { size: 7 });
}

function periodAppendix(p: Page, r: ReadinessReport) {
  p.h1('Appendix N. Operating over time (Type 2 preparation)');
  lead(p, 'A Type 1 report is about one date. A Type 2 report asks whether controls kept operating across a period. CloudBuilder takes dated snapshots of every control on a schedule, and this section shows what they say. It is preparation, not a Type 2 result: the CPA firm does its own testing of the period.');
  if (!r.period) { p.text('No snapshots are available.', { color: K.muted }); return; }
  const a = r.period;
  p.box(periodSentence(a));
  if (a.gaps.length) { p.h2('Gaps in the record', 70); p.table([{ h: 'From', w: 2 }, { h: 'To', w: 2 }, { h: 'Days', w: 1, align: 'right' }], a.gaps.slice(0, 20).map((g) => [g.from, g.to, String(g.days)])); }
  const { rows, more } = periodRows(a, (id) => r.defs.find((d) => d.id === id)?.title ?? id);
  p.h2('Controls that did not operate in every snapshot', 90);
  p.table([{ h: 'Control', w: 0.9 }, { h: 'Title', w: 4 }, { h: 'Operating', w: 1.3 }, { h: 'Failing', w: 1, align: 'right' }, { h: 'Lowest', w: 1, align: 'right' }, { h: 'Latest', w: 1, align: 'right' }], rows, { size: 8, empty: 'Every assessed control operated in every snapshot.' });
  if (more) p.text(`${more} more are not shown.`, { color: K.muted, size: 8.5 });
}

export async function renderSoc2Pdf(r: ReadinessReport): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc: Doc = new PDFDocument({ size: 'A4', margins: { top: P.top, bottom: P.bottom - 20, left: P.m, right: P.m }, bufferPages: true, info: { Title: `SOC 2 Type 1 readiness report: ${r.company}`, Author: 'CloudBuilder', Subject: `${r.system.name} as of ${r.asOf}`, Keywords: r.reportId } });
  const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const p = new Page(doc);
  cover(p, r);
  summary(p, r); scope(p, r); method(p, r); results(p, r); controlSection(p, r); findings(p, r); response(p, r); cpa(p, r); appendices(p, r); periodAppendix(p, r);
  addFooters(doc, r);
  doc.end();
  return done;
}
