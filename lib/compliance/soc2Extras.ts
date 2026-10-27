/**
 * The parts of the SOC 2 readiness report that are worked out from the report's own data: results by category, the consistency checks before the CPA firm starts,
 * independence of review, the gap register, the control worksheet and the control library. Pure functions of a ReadinessReport, so the Word and PDF reports show
 * the same figures and the same Pass or Fail, and each rule is tested on its own.
 */
import { EVIDENCE_WINDOW_DAYS } from './scoring';
import { summarize } from './model';
import { configSummary } from './configuration';
import { soc2Defs } from './frameworks';
import { FORBIDDEN_CLAIMS, type ReadinessReport } from './report';
import { isSamePerson } from './rules';
import { CSOC_SEEDS, CUEC_SEEDS } from './seeds';
import { SOC2_CATEGORY_LABEL, SOC2_CRITERIA, SOC2_CRITERIA_BY_ID, type Soc2Category } from './soc2/criteria';
import type { ControlResult } from './types';

const DAY = 86_400_000;
const openFinding = (f: { status: string }) => f.status === 'open' || f.status === 'in_progress';
const categoryOf = (group: string): Soc2Category => SOC2_CRITERIA_BY_ID.get(group)?.category ?? 'security';
export const TO_RECORD = '[to be recorded]';

// ── 4. Results by category and by criterion ───────────────────────────────────
export interface CategoryRow { category: string; criteria: number; controls: number; average: number | null; notAssessed: number; openFindings: number }

export function categoryRows(r: ReadinessReport): CategoryRow[] {
  const relabelled = r.results.map((x) => ({ ...x, group: SOC2_CATEGORY_LABEL[categoryOf(x.group)] }));
  const sm = summarize(relabelled);
  return r.categories.map((c) => {
    const label = SOC2_CATEGORY_LABEL[c];
    const g = sm.groups.find((x) => x.group === label);
    const ids = new Set(r.results.filter((x) => categoryOf(x.group) === c).map((x) => x.id));
    return {
      category: label, criteria: new Set(r.results.filter((x) => categoryOf(x.group) === c).map((x) => x.group)).size, controls: r.results.filter((x) => categoryOf(x.group) === c && x.scoreLabel !== 'Not applicable').length,
      average: g?.average ?? null, notAssessed: g?.notAssessed ?? 0, openFindings: r.findings.filter((f) => openFinding(f) && ids.has(f.controlId)).length,
    };
  });
}

export interface CriterionRow { criterion: string; controls: number; average: number | null; confidence: string; observation: string }
export function criterionRows(r: ReadinessReport): CriterionRow[] {
  return r.summary.groups.map((g) => {
    const top = r.findings.filter((f) => openFinding(f) && f.group === g.group).sort((a, b) => ['High', 'Medium', 'Low'].indexOf(a.severity) - ['High', 'Medium', 'Low'].indexOf(b.severity))[0];
    return {
      criterion: `${g.group}  ${SOC2_CRITERIA_BY_ID.get(g.group)?.name ?? ''}`.trim(), controls: g.controls, average: g.average, confidence: g.confidence,
      observation: top ? top.title : g.scored === 0 ? 'Not yet assessed.' : g.belowTarget === 0 ? 'Every assessed control operates.' : `${g.belowTarget} below 3, no open finding.`,
    };
  });
}

// ── 3.4 Independence ──────────────────────────────────────────────────────────
export interface IndependenceSummary { assessed: number; independentlyReviewed: number; notYetReviewed: number; sameAsOwner: string[] }
export function independence(r: ReadinessReport): IndependenceSummary {
  const assessed = r.results.filter((x) => x.score !== null);
  const sameAsOwner = assessed.filter((x) => x.reviewer && x.owner && isSamePerson(x.owner, { name: x.reviewer, email: x.reviewer })).map((x) => x.id);
  const reviewed = assessed.filter((x) => x.reviewer && !sameAsOwner.includes(x.id));
  return { assessed: assessed.length, independentlyReviewed: reviewed.length, notYetReviewed: assessed.length - reviewed.length - sameAsOwner.length, sameAsOwner };
}

// ── 8.1 Consistency checks ────────────────────────────────────────────────────
export type CheckResult = 'Pass' | 'Fail' | 'Note' | 'Not applicable';
export interface ConsistencyCheck { check: string; compared: string; result: CheckResult; detail: string }

export function consistencyChecks(r: ReadinessReport): ConsistencyCheck[] {
  const c = (check: string, compared: string, result: CheckResult, detail: string): ConsistencyCheck => ({ check, compared, result, detail });
  const out: ConsistencyCheck[] = [];
  const all: Soc2Category[] = ['security', 'availability', 'confidentiality'];
  const excluded = all.filter((x) => !r.categories.includes(x));
  const labelsInScope = r.categories.map((x) => SOC2_CATEGORY_LABEL[x]);

  const stray = r.defs.filter((d) => !r.categories.includes(categoryOf(d.group)));
  out.push(c('Criteria agree', 'The categories in scope, the controls listed and the criteria used in the report',
    stray.length === 0 && r.categories.includes('security') ? 'Pass' : 'Fail',
    stray.length === 0 ? `${labelsInScope.join(', ')} are in scope, and every control belongs to one of them.` : `${stray.length} control(s) belong to a category that is out of scope.`));

  const missingWhy = excluded.filter((x) => !r.exclusions.some((e) => e.category === SOC2_CATEGORY_LABEL[x] && e.reason.trim().length >= 10));
  out.push(c('Carve-outs agree', 'Each excluded category is excluded everywhere, with a reason, and none is tested',
    missingWhy.length === 0 ? 'Pass' : 'Fail', excluded.length === 0 ? 'No category is excluded.' : missingWhy.length === 0 ? `${excluded.map((x) => SOC2_CATEGORY_LABEL[x]).join(', ')} excluded with a written reason; none of its controls is assessed.` : `No reason is recorded for excluding ${missingWhy.map((x) => SOC2_CATEGORY_LABEL[x]).join(', ')}.`));

  const cs = configSummary(r.configuration);
  out.push(c('Architecture agrees', 'The saved architecture, the system description and the settings the controls rely on',
    cs.differing > 0 ? 'Fail' : cs.settings === 0 || cs.fromAccount === 0 ? 'Note' : 'Pass',
    cs.settings === 0 ? 'No resource settings were examined (the architecture may be empty).' : cs.differing > 0 ? `${cs.differing} setting(s) differ between the design and the cloud account. See Appendix G.` : cs.fromAccount === 0 ? `All ${cs.settings} settings come from the design only; none was read from the cloud account. See Appendix G.` : `${cs.fromAccount} of ${cs.settings} settings were read from the cloud account and none differs from the design.`));

  const eng = r.team.engagement;
  out.push(c('Provider agrees', 'Vulnerability scanning and penetration testing name the same provider and frequency wherever they appear', eng.scanProvider ? 'Pass' : 'Note',
    eng.scanProvider ? `Recorded once, here: ${eng.scanProvider}${eng.scanFrequency ? `, ${eng.scanFrequency}` : ''}. Use these words wherever the scan or test is mentioned (the system description and the control matrix).` : 'The scan and penetration-test provider is not recorded. Record it in the engagement settings, then use the same words in the system description and the control matrix.'));

  const ids = r.defs.map((d) => d.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  const unknown = r.defs.filter((d) => !SOC2_CRITERIA_BY_ID.has(d.group));
  out.push(c('Mapping agrees', 'Each control maps to one criterion that exists, with no duplicate control', dup.length === 0 && unknown.length === 0 ? 'Pass' : 'Fail',
    dup.length === 0 && unknown.length === 0 ? `${r.defs.length} controls, each mapped to one criterion.` : `${dup.length} duplicate control(s), ${unknown.length} mapped to a criterion that does not exist.`));

  for (const [name, what] of [['Tests fit controls', 'Each test checks the control beside it'], ['Procedures stated', 'Each procedure states its nature, timing and extent'], ['No inquiry-only operating tests', 'Operating conclusions rest on inspection or reperformance'], ['Results supported', 'Each "no exceptions" result traces to a complete population']] as const) {
    out.push(c(name, what, 'Not applicable', 'This is a Type 1 readiness report about design at one date. It applies to a Type 2 examination.'));
  }

  const asOf = Date.parse(r.asOf);
  const bad = r.evidenceIndex.filter((e) => !e.collectedAt || !e.uploadedBy || asOf - Date.parse(e.collectedAt) > EVIDENCE_WINDOW_DAYS * DAY || (e.validUntil && Date.parse(e.validUntil) < asOf));
  out.push(c('Evidence complete', 'Each item is dated, within the window, unexpired and has a named person who added it', bad.length === 0 ? 'Pass' : 'Fail',
    r.evidenceIndex.length === 0 ? 'No evidence is attached yet.' : bad.length === 0 ? `All ${r.evidenceIndex.length} items are dated within ${EVIDENCE_WINDOW_DAYS} days of ${r.asOf} and unexpired.` : `${bad.length} item(s) are undated, older than ${EVIDENCE_WINDOW_DAYS} days, expired or have no named person.`));
  if (r.evidenceIndex.length === 0) out[out.length - 1]!.result = 'Note';

  const comp = [...cuecRows(r), ...csocRows(r)];
  const unconfirmed = comp.filter((x) => x.status === 'Not confirmed').length; const gapsOpen = comp.filter((x) => x.status === 'Gap').length;
  out.push(c('Complementary controls agree', 'Each customer-side and provider-side control in the description appears in Appendix I with a status', gapsOpen > 0 ? 'Fail' : unconfirmed > 0 ? 'Note' : 'Pass',
    gapsOpen > 0 ? `${gapsOpen} complementary control(s) are marked Gap. A gap closes only with evidence.` : unconfirmed > 0 ? `${unconfirmed} of ${comp.length} have not been confirmed yet. Mark each one Confirmed or Gap.` : `All ${comp.length} are confirmed.`));
  const provs = providerRows(r);
  const notReviewed = provs.filter((x) => !x.recorded); const notBridged = provs.filter((x) => x.recorded && x.covers === 'No' && !/\d/.test(x.bridge));
  out.push(c('Subservice reports', 'Each provider report covers the period, with bridge letters for any gap', notBridged.length > 0 ? 'Fail' : notReviewed.length > 0 ? 'Note' : 'Pass',
    notBridged.length > 0 ? `${notBridged.map((x) => x.name).join(', ')}: the report does not cover the audit period and no bridge letter dates are recorded.` : notReviewed.length > 0 ? `${notReviewed.length} of ${provs.length} provider(s) have no review recorded (Appendix J): ${notReviewed.map((x) => x.name).join(', ')}.` : provs.length === 0 ? 'No provider is drawn in the design.' : `All ${provs.length} provider reviews are recorded.`));

  const sm = r.summary;
  const byCat = categoryRows(r);
  const counted = sm.byScore[0] + sm.byScore[1] + sm.byScore[2] + sm.byScore[3] + sm.byScore[4] + sm.notAssessed + sm.notApplicable;
  const catTotal = byCat.reduce((a, x) => a + x.controls, 0);
  const countsOk = counted === r.results.length && catTotal === sm.total - sm.notApplicable;
  out.push(c('Counts agree', 'The counts in the summary and the category table match the control rows', countsOk ? 'Pass' : 'Fail', countsOk ? `${r.results.length} controls: ${sm.total - sm.notApplicable} in scope, ${sm.notApplicable} not applicable.` : `The summary counts ${counted}, the category table ${catTotal}, the control rows ${r.results.length - sm.notApplicable}.`));
  if (countsOk && sm.notAssessed > 0) out[out.length - 1]!.detail += ` ${sm.notAssessed} in-scope control(s) are not assessed, and the report says so.`;

  const covered = new Set(r.defs.map((d) => d.group));
  const uncovered = SOC2_CRITERIA.filter((x) => r.categories.includes(x.category) && !covered.has(x.id));
  out.push(c('Criteria covered', 'Every criterion in scope has at least one control, or a recorded gap', uncovered.length === 0 ? 'Pass' : 'Fail', uncovered.length === 0 ? `All ${[...covered].length} criteria in scope have at least one control.` : `No control for ${uncovered.map((x) => x.id).join(', ')}.`));

  const files = r.evidenceIndex.filter((e) => e.kind === 'file');
  const noHash = files.filter((e) => !e.sha256 || !/^[0-9a-f]{64}$/i.test(e.sha256));
  const seen = new Map<string, number>(); files.forEach((e) => { if (e.sha256) seen.set(e.sha256, (seen.get(e.sha256) ?? 0) + 1); });
  const shared = [...seen.values()].filter((n) => n > 1).length;
  out.push(c('Evidence fingerprints', 'Each file has its own SHA-256 fingerprint, and no two files share one', noHash.length === 0 && shared === 0 ? (files.length ? 'Pass' : 'Note') : 'Fail',
    files.length === 0 ? 'No evidence files are attached yet.' : noHash.length === 0 && shared === 0 ? `All ${files.length} files have a distinct fingerprint. The auditor package re-checks each one against the stored file.` : `${noHash.length} file(s) have no valid fingerprint; ${shared} fingerprint(s) are shared by more than one file.`));

  const prose = [...r.results.flatMap((x) => [x.note, x.nextStep]), ...r.findings.flatMap((f) => [f.managementResponse, f.condition]), ...r.limitations.map((l) => l.item)].filter(Boolean);
  const hits = prose.filter((s) => FORBIDDEN_CLAIMS.test(s));
  out.push(c('Terminology', 'No text claims a certification, an attestation, SOC 2 compliance or approval by a CPA firm', hits.length === 0 ? 'Pass' : 'Fail', hits.length === 0 ? 'No such wording was found in the report text or in the notes and responses entered by the team.' : `${hits.length} text(s) make a claim of that kind. Remove them.`));
  return out;
}

// ── 8.2 Items the CPA firm will request ───────────────────────────────────────
export interface CpaItem { label: string; where: string; state: 'Done' | 'Open' | 'Confirm'; detail: string }
export function cpaItems(r: ReadinessReport): CpaItem[] {
  const inScope = r.results.filter((x) => x.score !== null || x.scoreLabel === 'Not assessed');
  const noOwner = inScope.filter((x) => !x.owner.trim());
  const noFreq = r.defs.filter((d) => !d.frequency || d.evidence.length === 0);
  const files = r.evidenceIndex.filter((e) => e.kind === 'file');
  const unsupported = r.results.filter((x) => x.score !== null && x.score >= 2 && x.evidence.length === 0 && !x.signals.some((s) => s.result === 'pass' && s.basis !== 'answer'));
  const open = r.findings.filter(openFinding);
  const signed = (role: string) => r.signoffs.some((s) => s.role === role);
  const item = (label: string, where: string, ok: boolean | null, done: string, todo: string): CpaItem => ({ label, where, state: ok === null ? 'Confirm' : ok ? 'Done' : 'Open', detail: ok === null ? todo : ok ? done : todo });
  return [
    item('System description agrees with the architecture diagrams, the vendor list and the customer commitments', 'Appendix H, G', null, '', 'Management confirms this: CloudBuilder cannot see customer commitments.'),
    item('Control matrix is complete, with owners, frequencies and evidence sources', 'Appendix A', noOwner.length === 0 && noFreq.length === 0, 'Every control has an owner, a frequency and expected evidence.', `${noOwner.length} control(s) have no owner; ${noFreq.length} lack a frequency or expected evidence.`),
    item("Management's assertion is drafted and signed by management", 'Appendix H', signed('management'), 'Management has signed.', 'Not signed. Management writes and signs it; CloudBuilder does not.'),
    item('Evidence index is complete for every in-scope control, with a fingerprint for each file', 'Appendix D', unsupported.length === 0 && files.every((e) => !!e.sha256), 'No control rests on a statement alone, and every file has a fingerprint.', `${unsupported.length} control(s) rest on a statement alone${files.some((e) => !e.sha256) ? ', and some files have no fingerprint' : ''}.`),
    item('All findings are closed or formally risk-accepted by management', 'Sections 6 and 7', open.length === 0, 'No finding is open.', `${open.length} finding(s) are still open.`),
    item('Vulnerability scan and penetration test scope matches the system boundary; reports and retests of critical and high findings are filed', 'Appendices A, D', null, '', 'Not recorded in CloudBuilder. File the reports as evidence and link them to the controls.'),
    item('Gap register and remediation tracker are current', 'Appendix F', true, 'Built from the live data on the date of this report.', ''),
    item('Prior-period findings are followed up, with evidence of closure and retest', 'Section 6.2', r.team.priorFindings.length === 0 ? null : r.team.priorFindings.every((e) => e.data['statusNow'] === 'Closed'), 'Every prior finding is closed and retested.', r.team.priorFindings.length === 0 ? 'No earlier report is recorded. If there is one, list its findings; if not, say so to the CPA firm.' : 'Some prior findings are still open, recur, or are risk-accepted.'),
    item('Provider reports are reviewed, with bridge letters for any gap', 'Appendix J', providerRows(r).length > 0 && providerRows(r).every((x) => x.recorded), 'Every provider review is recorded.', 'One or more provider reviews are not recorded.'),
    item('The report is reviewed by someone independent of the controls', 'Section 9', signed('reviewer'), 'Signed.', 'Not signed.'),
  ];
}

// ── Appendix F. Gap register and remediation tracker ──────────────────────────
export interface GapRow { id: string; control: string; criterion: string; description: string; owner: string; target: string; status: string }
export function gapRegister(r: ReadinessReport): GapRow[] {
  const fromFindings = r.findings.map((f) => ({ id: f.id.replace(/^F-/, 'GAP-'), control: f.controlId, criterion: f.group, description: f.condition, owner: f.owner || 'No owner', target: f.targetDate ?? 'No date', status: ({ open: 'Open', in_progress: 'In progress', closed: 'Closed', risk_accepted: 'Risk accepted' } as const)[f.status] }));
  const inFindings = new Set(r.findings.map((f) => f.controlId));
  const notAssessed = r.results.filter((x) => x.score === null && x.scoreLabel === 'Not assessed' && !inFindings.has(x.id)).map((x) => ({ id: `GAP-${x.id}`, control: x.id, criterion: x.group, description: 'Nobody has assessed this control yet, so no conclusion can be drawn for its criterion.', owner: x.owner || 'No owner', target: 'No date', status: 'Open' }));
  return [...fromFindings, ...notAssessed];
}

export interface RemediationRow { id: string; action: string; owner: string; closure: string; retestDate: string; retestResult: string; closedBy: string }
export function remediationTracker(r: ReadinessReport): RemediationRow[] {
  return r.findings.map((f) => ({
    id: f.id, action: f.recommendation, owner: f.owner || 'No owner', closure: f.status === 'closed' ? (f.managementResponse || TO_RECORD) : TO_RECORD, retestDate: f.retestedAt?.slice(0, 10) ?? '',
    retestResult: f.status === 'closed' ? 'Passed' : f.status === 'risk_accepted' ? 'Not retested (risk accepted)' : 'Not retested', closedBy: f.status === 'closed' ? `${f.retestedBy}${f.retestedAt ? `, ${f.retestedAt.slice(0, 10)}` : ''}` : f.status === 'risk_accepted' && f.acceptedBy ? `Accepted by ${f.acceptedBy}` : '',
  }));
}

// ── Appendix B. Control assessment worksheet ──────────────────────────────────
export interface WorksheetRow { control: string; objective: string; activity: string; ownerFrequency: string; population: string; walkthrough: string; evidence: string; score: string; basis: string; nextStep: string; reviewer: string }
export function worksheetRows(r: ReadinessReport): WorksheetRow[] {
  return r.results.map((x: ControlResult) => {
    const d = r.defs.find((y) => y.id === x.id);
    const crit = SOC2_CRITERIA_BY_ID.get(x.group);
    const basis = x.signals.length ? [...new Set(x.signals.map((s) => ({ design: 'Design check', discovered: 'Read from the account', live: 'Live check', answer: "Team's answer", platform: 'CloudBuilder record' }[s.basis])))].join('; ') : x.evidence.length ? 'Inspected evidence' : 'Statement only';
    return {
      control: `${x.id}: ${x.title}\n${x.group}`, objective: crit?.asks ?? '', activity: d?.activity ?? '', ownerFrequency: `${x.owner || 'No owner'}\n${d?.frequency ?? ''}`, population: dash(walkthroughOf(r, x.id)?.['population']), walkthrough: walkthroughOf(r, x.id) ? `${walkthroughOf(r, x.id)!['participant']}, ${walkthroughOf(r, x.id)!['date']}` : TO_RECORD,
      evidence: x.evidence.map((e) => e.id).join(', ') || 'None', score: x.score === null ? x.scoreLabel : `${x.score} ${x.scoreLabel}\n${x.confidence}`, basis, nextStep: x.nextStep, reviewer: x.reviewer ? `${x.reviewer}${x.reviewedAt ? `\n${x.reviewedAt.slice(0, 10)}` : ''}` : TO_RECORD,
    };
  });
}

// ── Appendix M. Control library ───────────────────────────────────────────────
export interface LibraryRow { criterion: string; activity: string; owner: string; evidence: string }
/** The whole starting set (every category), not only what is in scope: it is what a company builds its own control matrix from. */
export function controlLibrary(): LibraryRow[] {
  return soc2Defs().map((d) => ({ criterion: `${d.group}  ${SOC2_CRITERIA_BY_ID.get(d.group)?.name ?? ''}`.trim(), activity: `${d.title}. ${d.activity ?? ''}`, owner: d.ownerRole, evidence: d.evidence.join('; ') }));
}

// ── 1. Executive summary ──────────────────────────────────────────────────────
export function conclusion(r: ReadinessReport): string {
  const sm = r.summary; const open = r.findings.filter(openFinding); const high = open.filter((f) => f.severity === 'High').length;
  const notReady = sm.byScore[0] + sm.byScore[1];
  const lead = { Ready: 'Every control in scope operates and no serious finding is open.', 'Ready with conditions': 'Every control is at least implemented, but some are not yet shown to operate or findings remain open.', 'Not ready': 'At least one control is missing or only informal, or a serious finding is open.', Incomplete: 'Some controls have not been assessed, so no conclusion can be drawn yet.' }[r.readiness];
  return `${lead} ${sm.coveragePct}% of the ${sm.total - sm.notApplicable} controls in scope have been assessed, with an average score of ${sm.average ?? 'n/a'} out of 4. ${notReady} ${notReady === 1 ? 'control is' : 'controls are'} missing or informal, and ${open.length} ${open.length === 1 ? 'finding is' : 'findings are'} open${high ? `, ${high} of them high` : ''}.`;
}

// ── What the team recorded, merged with what CloudBuilder knows ───────────────
export const providersOf = (r: ReadinessReport): string[] => r.system.providers.map((x) => (x === 'aws' ? 'Amazon Web Services' : 'Microsoft Azure'));
const dash = (v: string | undefined, fallback = TO_RECORD) => (v && v.trim() ? v : fallback);

export interface ChangeRow { date: string; change: string; systems: string; criteria: string; impact: string; reviewedBy: string; source: 'team' | 'history' }
/** The team's own log first; then the saved architecture versions in the year before the report date, marked as not yet reviewed. */
export function changeRows(r: ReadinessReport): ChangeRow[] {
  const team: ChangeRow[] = r.team.changes.map((e) => ({ date: e.data['date'] ?? '', change: e.data['change'] ?? '', systems: dash(e.data['systems'], ''), criteria: dash(e.data['criteria'], ''), impact: dash(e.data['impact'], ''), reviewedBy: dash(e.data['reviewedBy'], '[not reviewed]'), source: 'team' }));
  const history: ChangeRow[] = r.architectureHistory.map((h) => ({ date: h.date, change: `Architecture saved: ${h.label}${h.summary ? `. ${h.summary}` : ''} (by ${h.author})`, systems: TO_RECORD, criteria: TO_RECORD, impact: TO_RECORD, reviewedBy: '[not reviewed]', source: 'history' }));
  return [...team, ...history];
}

export function priorFindingRows(r: ReadinessReport): string[][] {
  return r.team.priorFindings.map((e) => [e.data['priorId'] ?? '', dash(e.data['report'], ''), e.data['condition'] ?? '', dash(e.data['remediation'], ''), dash(e.data['closureEvidence'], ''), e.data['statusNow'] ?? '', e.data['retestedBy'] ? `${e.data['retestedBy']}${e.data['retestedOn'] ? `, ${e.data['retestedOn']}` : ''}` : '']);
}

export interface LimitationRow { id: string; item: string; control: string; effect: string; owner: string; resolved: string }
export function limitationRegister(r: ReadinessReport): LimitationRow[] {
  return r.limitations.map((l) => { const n = r.team.limitationNotes[l.id]?.data; return { id: l.id, item: l.item, control: l.controlId ?? 'Report', effect: l.effect, owner: dash(n?.['owner'], '[to be assigned]'), resolved: n?.['resolvedOn'] ?? '' }; });
}

export interface ComplementaryRow { id: string; statement: string; criteria: string; a: string; b: string; status: 'Confirmed' | 'Gap' | 'Not confirmed'; note: string }
/** The suggested complementary controls, with what the team recorded laid over them, plus any the team added. */
export function cuecRows(r: ReadinessReport): ComplementaryRow[] {
  const seeded = CUEC_SEEDS.map(([statement, criteria], i): ComplementaryRow => { const k = `CUEC-${i + 1}`; const d = r.team.cuecs[k]?.data; return { id: k, statement: dash(d?.['statement'], statement), criteria: dash(d?.['criteria'], criteria), a: dash(d?.['contracts']), b: dash(d?.['communicated']), status: (d?.['status'] as ComplementaryRow['status']) || 'Not confirmed', note: d?.['note'] ?? '' }; });
  const extra = Object.entries(r.team.cuecs).filter(([k]) => !seeded.some((s) => s.id === k)).map(([k, e]): ComplementaryRow => ({ id: k, statement: dash(e.data['statement'], ''), criteria: dash(e.data['criteria'], ''), a: dash(e.data['contracts']), b: dash(e.data['communicated']), status: (e.data['status'] as ComplementaryRow['status']) || 'Not confirmed', note: e.data['note'] ?? '' }));
  return [...seeded, ...extra];
}
export function csocRows(r: ReadinessReport): ComplementaryRow[] {
  const seeded = providersOf(r).flatMap((prov, i) => CSOC_SEEDS.map(([statement, criteria], k): ComplementaryRow => { const id = `CSOC-${i + 1}.${k + 1}`; const d = r.team.csocs[id]?.data; return { id, statement: dash(d?.['statement'], `${prov}: ${statement}`), criteria: dash(d?.['criteria'], criteria), a: dash(d?.['report']), b: dash(d?.['ourControl']), status: (d?.['status'] as ComplementaryRow['status']) || 'Not confirmed', note: d?.['note'] ?? '' }; }));
  const extra = Object.entries(r.team.csocs).filter(([k]) => !seeded.some((s) => s.id === k)).map(([k, e]): ComplementaryRow => ({ id: k, statement: dash(e.data['statement'], ''), criteria: dash(e.data['criteria'], ''), a: dash(e.data['report']), b: dash(e.data['ourControl']), status: (e.data['status'] as ComplementaryRow['status']) || 'Not confirmed', note: e.data['note'] ?? '' }));
  return [...seeded, ...extra];
}

export interface ProviderRow { name: string; what: string; cloud: boolean; treatment: string; report: string; covers: string; bridge: string; opinion: string; reviewed: string; relied: string; evidence: string; gap: string; compensating: string; recorded: boolean }
/** Every provider in the design (the cloud providers and each third-party service), with the team's review laid over it. */
export function providerRows(r: ReadinessReport): ProviderRow[] {
  const base = [...providersOf(r).map((name) => ({ name, what: 'Cloud hosting: physical security, environment, network and host infrastructure', cloud: true })), ...r.system.thirdParties.map((x) => ({ name: x.vendor, what: `${x.use}. Data held: ${x.dataHeld || 'not stated'}`, cloud: false }))];
  return base.map((b) => {
    const e = r.team.providers[b.name]; const d = e?.data;
    return {
      ...b, recorded: !!e, treatment: d?.['treatment'] || (b.cloud ? 'Usually carve-out; the CPA firm confirms' : TO_RECORD), report: d?.['reportType'] ? `${d['reportType']}${d['period'] ? `, ${d['period']}` : ''}` : TO_RECORD,
      covers: d?.['coversPeriod'] || TO_RECORD, bridge: dash(d?.['bridgeLetter'], d?.['coversPeriod'] === 'Yes' ? 'Not needed' : TO_RECORD), opinion: dash(d?.['opinion']), reviewed: d?.['reviewedBy'] ? `${d['reviewedBy']}${d['reviewedOn'] ? `, ${d['reviewedOn']}` : ''}` : TO_RECORD,
      relied: dash(d?.['controlsRelied'], 'Physical and environmental controls, and host infrastructure'), evidence: dash(d?.['ourEvidence']), gap: dash(d?.['gap']), compensating: dash(d?.['compensating']),
    };
  });
}

export function findingPlan(r: ReadinessReport, controlId: string) {
  const d = r.team.findingPlans[controlId]?.data;
  return { milestones: dash(d?.['milestones']), acceptance: dash(d?.['acceptance']), closureEvidence: d?.['closureEvidence'] ?? '' };
}
export function walkthroughOf(r: ReadinessReport, controlId: string) { return r.team.walkthroughs[controlId]?.data; }
