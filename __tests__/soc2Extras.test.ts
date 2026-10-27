import { changeRows, csocRows, cuecRows, limitationRegister, priorFindingRows, providerRows, findingPlan, categoryRows, consistencyChecks, controlLibrary, cpaItems, criterionRows, gapRegister, independence, remediationTracker, worksheetRows, conclusion } from '@/lib/compliance/soc2Extras';
import { configRows, configSummary } from '@/lib/compliance/configuration';
import { buildReadinessReport } from '@/lib/compliance/report';
import { fixtureInput, fixtureReport } from './helpers/complianceFixture';
import type { Evaluation } from '@/lib/engines/assessment/types';

const report = fixtureReport('soc2');
const check = (r: typeof report, name: string) => consistencyChecks(r).find((c) => c.check === name)!;

describe('results by category', () => {
  it('has one row per category in scope, and the counts add up to the controls in scope', () => {
    const rows = categoryRows(report);
    expect(rows.map((r) => r.category)).toEqual(['Security', 'Availability']);
    expect(rows.reduce((a, r) => a + r.controls, 0)).toBe(report.summary.total - report.summary.notApplicable);
    expect(rows.reduce((a, r) => a + r.openFindings, 0)).toBe(report.findings.filter((f) => f.status === 'open' || f.status === 'in_progress').length);
    expect(rows[0]!.criteria).toBeGreaterThan(20);
  });
  it('the criterion table carries a short observation for every criterion', () => {
    const rows = criterionRows(report);
    expect(rows.length).toBe(report.summary.groups.length);
    expect(rows.every((r) => r.observation.length > 5)).toBe(true);
  });
});

describe('consistency checks', () => {
  it('every check has a result, and Type 2 checks are marked not applicable', () => {
    const c = consistencyChecks(report);
    expect(c.length).toBe(16);
    expect(new Set(c.map((x) => x.result))).toEqual(expect.objectContaining({}));
    expect(c.filter((x) => x.result === 'Not applicable').map((x) => x.check)).toEqual(['Tests fit controls', 'Procedures stated', 'No inquiry-only operating tests', 'Results supported']);
  });
  it('counts agree and every criterion in scope is covered', () => {
    expect(check(report, 'Counts agree').result).toBe('Pass');
    expect(check(report, 'Criteria covered').result).toBe('Pass');
    expect(check(report, 'Mapping agrees').result).toBe('Pass');
  });
  it('fingerprints pass when every file has its own, and fail when two share one', () => {
    expect(check(report, 'Evidence fingerprints').result).toBe('Pass');
    const files = report.evidenceIndex.filter((e) => e.kind === 'file');
    const shared = { ...report, evidenceIndex: report.evidenceIndex.map((e) => (e.kind === 'file' ? { ...e, sha256: files[0]!.sha256 } : e)) };
    expect(check(shared, 'Evidence fingerprints')).toMatchObject({ result: 'Fail', detail: expect.stringMatching(/shared by more than one/) });
    const none = { ...report, evidenceIndex: report.evidenceIndex.map((e) => (e.kind === 'file' ? { ...e, sha256: undefined } : e)) };
    expect(check(none, 'Evidence fingerprints').result).toBe('Fail');
  });
  it('a category left out without a reason fails the carve-out check', () => {
    expect(check(report, 'Carve-outs agree').result).toBe('Pass');
    const r = buildReadinessReport({ ...fixtureInput('soc2'), exclusions: {} });
    expect(check(r, 'Carve-outs agree').result).toBe('Fail');
  });
  it('the architecture check fails when the account differs from the design, and is a note when nothing was read from the account', () => {
    expect(check(report, 'Architecture agrees').result).toBe('Fail');
    const designOnly = buildReadinessReport({ ...fixtureInput('soc2'), configuration: fixtureInput('soc2').configuration!.filter((c) => c.source === 'Design' && !c.accountValue) });
    expect(check(designOnly, 'Architecture agrees').result).toBe('Note');
    const agrees = buildReadinessReport({ ...fixtureInput('soc2'), configuration: fixtureInput('soc2').configuration!.filter((c) => !c.accountValue) });
    expect(check(agrees, 'Architecture agrees').result).toBe('Pass');
  });
  it('old or undated evidence fails the evidence check', () => {
    const r = { ...report, evidenceIndex: report.evidenceIndex.map((e, i) => (i === 0 ? { ...e, collectedAt: '2024-01-01' } : e)) };
    expect(check(r, 'Evidence complete').result).toBe('Fail');
  });
  it('terminology fails when a note claims certification', () => {
    const r = { ...report, results: report.results.map((x, i) => (i === 0 ? { ...x, note: 'We are SOC 2 compliant.' } : x)) };
    expect(check(r, 'Terminology').result).toBe('Fail');
    expect(check(report, 'Terminology').result).toBe('Pass');
  });
});

describe('independence, items for the CPA, gaps', () => {
  it('counts independent reviews, and flags a reviewer who is the owner', () => {
    const i = independence(report);
    expect(i.independentlyReviewed + i.notYetReviewed + i.sameAsOwner.length).toBe(i.assessed);
    const r = { ...report, results: report.results.map((x) => (x.score !== null && x.owner ? { ...x, reviewer: x.owner } : x)) };
    expect(independence(r).sameAsOwner.length).toBeGreaterThan(0);
  });
  it('the CPA list ticks only what the data shows', () => {
    const items = cpaItems(report);
    expect(items.map((x) => x.state)).toContain('Confirm');
    expect(items.find((x) => x.label.startsWith("Management's assertion"))!.state).toBe('Open');
    expect(items.find((x) => x.label.startsWith('All findings'))!.state).toBe('Open');
    expect(items.find((x) => x.label.startsWith('Gap register'))!.state).toBe('Done');
  });
  it('the gap register has a row for every finding and for every control nobody assessed', () => {
    const g = gapRegister(report);
    const notAssessed = report.results.filter((x) => x.score === null && x.scoreLabel === 'Not assessed' && !report.findings.some((f) => f.controlId === x.id)).length;
    expect(g.length).toBe(report.findings.length + notAssessed);
    expect(new Set(g.map((x) => x.id)).size).toBe(g.length);
    expect(remediationTracker(report).length).toBe(report.findings.length);
  });
});

describe('worksheet, library and conclusion', () => {
  it('has a worksheet row for every control, with what is not recorded yet marked as such', () => {
    const w = worksheetRows(report);
    expect(w).toHaveLength(report.results.length);
    expect(w[0]!.walkthrough).toBe('Priya Nair (HR), 2026-10-08');
    expect(w[1]!.walkthrough).toBe('[to be recorded]');
    expect(w[0]!.population).toMatch(/HR system joiner list/);
  });
  it('the library is the whole starting set, whatever is in scope', () => {
    expect(controlLibrary()).toHaveLength(63);
  });
  it('the conclusion states the verdict, coverage and findings without claiming assurance', () => {
    const c = conclusion(report);
    expect(c).toMatch(/Some controls have not been assessed/);
    expect(c).toMatch(/\d+% of the \d+ controls in scope/);
    expect(c).not.toMatch(/certified|compliant|attested/i);
  });
});

describe('the configuration appendix data', () => {
  const ev = (over: Partial<Evaluation>): Evaluation => ({ findingId: 'x', ruleId: 'AWS-RDS-002', ruleVersion: '1', provider: 'aws', resourceIds: ['n1'], resourceLabels: ['orders-db'], status: 'FAIL', severity: 'HIGH', observation: 'o', evidence: [{ label: 'Storage encryption', observed: 'Disabled', expected: 'Enabled', basis: 'CONFIGURATION', source: 'DESIGN' }], provenance: 'DESIGN_TIME', ...over } as Evaluation);
  const nodes = [{ id: 'n1', label: 'orders-db', resourceType: 'aws_rds_instance', provider: 'aws', region: 'eu-west-1' }];
  it('lists each examined setting once, with the worst result and the strongest source', () => {
    const rows = configRows(nodes, [ev({}), ev({ status: 'PASS', evidence: [{ label: 'Storage encryption', observed: 'Enabled', expected: 'Enabled', basis: 'CONFIGURATION', source: 'LIVE' }], provenance: 'LIVE_VERIFIED' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource: 'orders-db', type: 'Rds instance', region: 'eu-west-1', setting: 'Storage encryption', result: 'Fail', provider: 'AWS' });
  });
  it('skips answers to questions, results that were not evaluated, and resources that are not in the design', () => {
    const q = ev({ evidence: [{ label: 'Do you test restores?', observed: 'No', basis: 'QUESTIONNAIRE' }] });
    const ne = ev({ status: 'NOT_EVALUATED' });
    const arch = ev({ resourceIds: ['ARCH'] });
    expect(configRows(nodes, [q, ne, arch])).toEqual([]);
  });
  it('records a value the account holds that differs from the design', () => {
    const rows = configRows(nodes, [ev({ evidence: [{ label: 'Backup retention', observed: '7 days', expected: '7 days or more', basis: 'CONFIGURATION', source: 'DESIGN', discoveredValue: '1 day' }], status: 'PASS' })]);
    expect(rows[0]!.accountValue).toBe('1 day');
    expect(configSummary(rows)).toMatchObject({ resources: 1, settings: 1, differing: 1, designOnly: 1 });
  });
});

describe('what the team recorded, merged with what CloudBuilder knows', () => {
  const blank = buildReadinessReport({ ...fixtureInput('soc2'), team: undefined, architectureHistory: undefined });
  it('the significant-changes log is the team\'s entries first, then the architecture history marked as not reviewed', () => {
    const rows = changeRows(report);
    expect(rows.map((r) => r.source)).toEqual(['team', 'team', 'history', 'history']);
    expect(rows[0]!.date <= rows[1]!.date).toBe(true);
    expect(rows[2]).toMatchObject({ reviewedBy: '[not reviewed]' });
    expect(rows[2]!.change).toMatch(/^Architecture saved: Add Auth0 sign-in/);
    expect(changeRows(blank)).toEqual([]);
  });
  it('limitations get the owner and resolved date the team gave them, and "to be assigned" otherwise', () => {
    const l = limitationRegister(report);
    expect(l.find((x) => x.id === 'L-01')).toMatchObject({ owner: 'Sam Okafor' });
    expect(l.find((x) => x.id === 'L-02')).toMatchObject({ owner: '[to be assigned]' });
  });
  it('complementary controls start as suggestions, take the team\'s status, and keep any the team added', () => {
    const c = cuecRows(report);
    expect(c.map((x) => x.status)).toEqual(['Confirmed', 'Not confirmed', 'Gap', 'Not confirmed']);
    expect(c[2]!.note).toMatch(/incident contact/);
    expect(csocRows(report).find((x) => x.id === 'CSOC-1.1')).toMatchObject({ status: 'Confirmed', a: expect.stringMatching(/AWS SOC 2 Type 2/) });
    expect(csocRows(blank).every((x) => x.status === 'Not confirmed')).toBe(true);
  });
  it('providers show the review where one is recorded and a prompt where not', () => {
    const p = providerRows(report);
    expect(p.find((x) => x.name === 'Amazon Web Services')).toMatchObject({ recorded: true, treatment: 'Carve-out', covers: 'No', reviewed: 'Dana Li, 2026-10-20' });
    expect(p.find((x) => x.name === 'Auth0')).toMatchObject({ recorded: false, reviewed: '[to be recorded]' });
  });
  it('prior findings and remediation plans come through', () => {
    expect(priorFindingRows(report)[0]![0]).toBe('PF-3');
    expect(findingPlan(report, 'CTL-23').milestones).toMatch(/Maintenance window/);
    expect(findingPlan(report, 'CTL-24').milestones).toBe('[to be recorded]');
  });
  it('the checks that waited for this information now react to it', () => {
    expect(check(blank, 'Provider agrees').result).toBe('Note');
    expect(check(report, 'Provider agrees')).toMatchObject({ result: 'Pass', detail: expect.stringMatching(/Northwind Pen Tests Ltd, annually/) });
    expect(check(report, 'Complementary controls agree')).toMatchObject({ result: 'Fail', detail: expect.stringMatching(/1 complementary control\(s\) are marked Gap/) });
    expect(check(blank, 'Complementary controls agree').result).toBe('Note');
    expect(check(report, 'Subservice reports').result).toBe('Note');
    const noBridge = buildReadinessReport({ ...fixtureInput('soc2'), team: { ...fixtureInput('soc2').team!, providers: { 'Amazon Web Services': { ...fixtureInput('soc2').team!.providers['Amazon Web Services']!, data: { treatment: 'Carve-out', coversPeriod: 'No', bridgeLetter: '' } } } } });
    expect(check(noBridge, 'Subservice reports').result).toBe('Fail');
  });
  it('the CPA list reflects prior findings and provider reviews', () => {
    const items = cpaItems(report);
    expect(items.find((x) => x.label.startsWith('Prior-period'))!.state).toBe('Done');
    expect(items.find((x) => x.label.startsWith('Prior-period'))!.state).not.toBe('Open');
    expect(cpaItems(blank).find((x) => x.label.startsWith('Prior-period'))!.state).toBe('Confirm');
    expect(items.find((x) => x.label.startsWith('Provider reports'))!.state).toBe('Open');
  });
});
