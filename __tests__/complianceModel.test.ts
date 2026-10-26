/** The engine around the scoring: signals from the assessment, summaries, derived findings and limitations, and the readiness verdict. */
import type { Evaluation } from '@/lib/engines/assessment/types';
import { deriveFindings, deriveLimitations, evaluateControls, readinessOf, summarize, type ControlDef } from '@/lib/compliance/model';
import { platformSignal, signalsFromEvaluations, type PlatformFacts } from '@/lib/compliance/signals';
import type { ControlRecord, EvidenceRef } from '@/lib/compliance/types';

const asOf = new Date('2026-10-26T00:00:00Z');
const ev = (ruleId: string, status: Evaluation['status'], extra: Partial<Evaluation> = {}): Evaluation => ({ ruleId, status, observation: `obs ${ruleId}`, severity: 'MEDIUM', provenance: 'DESIGN_TIME', ...extra } as Evaluation);
const def = (id: string, over: Partial<ControlDef> = {}): ControlDef => ({ id, group: 'G1', title: `Control ${id}`, ownerRole: 'Lead', evidence: ['x'], effect: `Weakens ${id}.`, ...over });
const rec = (controlId: string, over: Partial<ControlRecord> = {}): ControlRecord => ({ controlId, status: 'implemented', owner: 'Priya', note: '', naReason: '', reviewer: '', ...over });
const file = (daysAgo: number, over: Partial<EvidenceRef> = {}): EvidenceRef => ({ id: `e${daysAgo}`, title: 't', kind: 'file', origin: 'manual', collectedAt: new Date(asOf.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10), ...over });
const run = (defs: ControlDef[], p: { records?: Record<string, ControlRecord>; evidence?: Record<string, EvidenceRef[]>; evaluations?: Evaluation[]; facts?: PlatformFacts } = {}) =>
  evaluateControls(defs, { records: p.records ?? {}, evidence: p.evidence ?? {}, evaluations: p.evaluations ?? [], facts: p.facts, asOf });

describe('signals from the assessment', () => {
  it('turn results into one signal per check, with the strongest source behind a pass', () => {
    const s = signalsFromEvaluations([ev('AWS-S3-002', 'PASS'), ev('AWS-S3-002', 'PASS', { provenance: 'DISCOVERED_CONFIGURATION' }), ev('AWS-RDS-002', 'FAIL', { severity: 'HIGH' })], ['AWS-S3-002', 'AWS-RDS-002', 'AWS-EBS-001']);
    expect(s).toHaveLength(2);                                            // EBS has no results in this design: no signal
    expect(s[0]).toMatchObject({ ref: 'AWS-S3-002', result: 'pass', basis: 'discovered' });
    expect(s[1]).toMatchObject({ ref: 'AWS-RDS-002', result: 'fail', severity: 'HIGH' });
  });
  it('count a warning as a failure, a missing configuration as unclear, and say nothing for what was not evaluated', () => {
    const s = signalsFromEvaluations([ev('A', 'WARNING'), ev('B', 'INSUFFICIENT_DATA'), ev('C', 'NOT_EVALUATED'), ev('D', 'NOT_APPLICABLE')], ['A', 'B', 'C', 'D']);
    expect(s.map((x) => [x.ref, x.result])).toEqual([['A', 'fail'], ['B', 'unclear']]);
  });
  it('mark answers to questions as answers, never as a reading of the system', () => {
    const s = signalsFromEvaluations([ev('WAQ-AWS-OPS-01', 'PASS', { provenance: 'LIVE_VERIFIED' }), ev('AWS-EXT-SEC-05', 'FAIL')], ['WAQ-AWS-OPS-01', 'AWS-EXT-SEC-05']);
    expect(s.map((x) => x.basis)).toEqual(['answer', 'answer']);
  });
});

describe('platform facts', () => {
  const facts: PlatformFacts = { members: 4, mfaEnrolled: 3, approvalsLast90d: 5, auditEventsLast90d: 0, deployRestricted: false, lastAssessmentAt: '2026-10-20T00:00:00Z', lastDiscoveryAt: '2026-08-01T00:00:00Z' };
  it('say what CloudBuilder itself knows, and nothing it does not', () => {
    expect(platformSignal('mfa', facts, asOf)).toMatchObject({ result: 'fail', text: '1 of 4 organization members have no second sign-in factor.' });
    expect(platformSignal('mfa', { ...facts, mfaEnrolled: 4 }, asOf)!.result).toBe('pass');
    expect(platformSignal('approvals', facts, asOf)!.text).toContain('5 infrastructure changes were approved');
    expect(platformSignal('audit-log', facts, asOf)).toBeNull();
    expect(platformSignal('restricted-deploy', facts, asOf)!.result).toBe('fail');
    expect(platformSignal('recent-assessment', facts, asOf)!.result).toBe('pass');
    expect(platformSignal('recent-discovery', facts, asOf)!.result).toBe('unclear');
    expect(platformSignal('mfa', undefined, asOf)).toBeNull();
  });
});

describe('evaluating a set', () => {
  it('scores each control from the answer, the evidence and the checks together', () => {
    const defs = [def('A', { rules: ['AWS-S3-002'] }), def('B'), def('C')];
    const r = run(defs, { records: { A: rec('A'), B: rec('B', { status: 'planned' }) }, evidence: { A: [file(20)] }, evaluations: [ev('AWS-S3-002', 'PASS', { provenance: 'DISCOVERED_CONFIGURATION' })] });
    expect(r.map((x) => [x.id, x.score, x.scoreLabel])).toEqual([['A', 3, 'Operating'], ['B', 0, 'Missing'], ['C', null, 'Not assessed']]);
  });
});

describe('summary', () => {
  const defs = ['A', 'B', 'C', 'D'].map((id) => def(id, { group: id <= 'B' ? 'G1' : 'G2' }));
  const results = run(defs, { records: { A: rec('A'), B: rec('B', { status: 'none' }), C: rec('C', { status: 'not_applicable', naReason: 'No offices at all.' }) }, evidence: { A: [file(5)] } });
  const s = summarize(results);
  it('counts by score, separates not applicable from not assessed, and averages per group', () => {
    expect(s).toMatchObject({ total: 4, scored: 2, notApplicable: 1, notAssessed: 1, average: 1.5, coveragePct: 67 });
    expect(s.byScore).toEqual({ 0: 1, 1: 0, 2: 0, 3: 1, 4: 0 });
    expect(s.groups.map((g) => [g.group, g.controls, g.average, g.notAssessed])).toEqual([['G1', 2, 1.5, 0], ['G2', 2, null, 1]]);
  });
});

describe('findings', () => {
  const defs = [def('A', { rules: ['AWS-RDS-002'] }), def('B'), def('C'), def('D')];
  const results = run(defs, { records: { A: rec('A'), B: rec('B', { status: 'none' }), C: rec('C') }, evidence: { C: [file(5)] }, evaluations: [ev('AWS-RDS-002', 'FAIL', { severity: 'HIGH' })] });
  const findings = deriveFindings(defs, results, { B: { controlId: 'B', owner: 'Sam', targetDate: '2026-12-01', status: 'in_progress', managementResponse: 'Doing it.', acceptedBy: '', retestedBy: '' } });
  it('are raised for a failing check, a missing control and an unproven one, highest first, and not for an operating control or an unassessed one', () => {
    expect(findings.map((f) => [f.id, f.severity])).toEqual([['F-A', 'High'], ['F-B', 'High']]);
    expect(findings[0]!.condition).toContain('obs AWS-RDS-002');
    expect(findings[0]!.cause).toMatch(/does not meet/);
    expect(findings[1]).toMatchObject({ cause: 'The control has not been put in place.', effect: 'Weakens B.' });
  });
  it('carry what the team wrote', () => {
    expect(findings[1]).toMatchObject({ owner: 'Sam', targetDate: '2026-12-01', status: 'in_progress', managementResponse: 'Doing it.' });
    expect(findings[0]).toMatchObject({ status: 'open', managementResponse: '' });
  });
  it('rate an informal control medium and a partly supported one low', () => {
    const r = run([def('X'), def('Y')], { records: { X: rec('X'), Y: rec('Y') }, evidence: { Y: [file(400)] } });
    expect(deriveFindings([def('X'), def('Y')], r).map((f) => [f.id, f.severity])).toEqual([['F-X', 'Medium'], ['F-Y', 'Low']]);
  });
});

describe('limitations', () => {
  it('list what was not assessed, what rests on a claim, what is old, and that only the design was read', () => {
    const defs = [def('A'), def('B'), def('C'), def('D')];
    const r = run(defs, { records: { A: rec('A'), C: rec('C', { status: 'not_applicable', naReason: ' ' }) }, evidence: { D: [file(500)] } });
    const l = deriveLimitations(r, { cloudAccountRead: false });
    expect(l[0]!.item).toMatch(/architecture design only/);
    expect(l.map((x) => x.item).join('\n')).toMatch(/A Control A rests on a statement alone/);
    expect(l.map((x) => x.item).join('\n')).toMatch(/B Control B has not been assessed/);
    expect(l.map((x) => x.item).join('\n')).toMatch(/C Control C is marked not applicable without a reason/);
    expect(l.map((x) => x.id)).toEqual(l.map((_, i) => `L-${String(i + 1).padStart(2, '0')}`));
    expect(deriveLimitations(r, { cloudAccountRead: true })[0]!.item).not.toMatch(/design only/);
  });
});

describe('readiness', () => {
  const build = (records: Record<string, ControlRecord>, evidence: Record<string, EvidenceRef[]> = {}, findings: Record<string, any> = {}) => {
    const defs = Object.keys(records).concat(['Z']).filter((x, i, a) => a.indexOf(x) === i).map((id) => def(id));
    const results = run(defs, { records, evidence });
    return { s: summarize(results), f: deriveFindings(defs, results, findings) };
  };
  it('is incomplete while any control has not been assessed', () => {
    const { s, f } = build({ A: rec('A') }, { A: [file(5)] });          // Z is unassessed
    expect(readinessOf(s, f)).toBe('Incomplete');
  });
  it('is ready only when every control operates and nothing serious is open', () => {
    const ok = build({ A: rec('A'), Z: rec('Z', { status: 'not_applicable', naReason: 'Not used here.' }) }, { A: [file(5)] });
    expect(readinessOf(ok.s, ok.f)).toBe('Ready');
  });
  it('is ready with conditions when everything is at least implemented and no high finding is open', () => {
    const r = build({ A: rec('A'), Z: rec('Z') }, { A: [file(5)], Z: [file(500)] });
    expect(readinessOf(r.s, r.f)).toBe('Ready with conditions');
  });
  it('is not ready with a missing control, and a risk-accepted finding no longer blocks', () => {
    const bad = build({ A: rec('A', { status: 'none' }), Z: rec('Z') }, { Z: [file(5)] });
    expect(readinessOf(bad.s, bad.f)).toBe('Not ready');
    const accepted = build({ A: rec('A', { status: 'none' }), Z: rec('Z') }, { Z: [file(5)] }, { A: { controlId: 'A', owner: '', status: 'risk_accepted', managementResponse: 'Accepted by the CEO.', acceptedBy: 'CEO', retestedBy: '' } });
    expect(readinessOf(accepted.s, accepted.f)).toBe('Not ready');      // still a 0: accepted risk does not make a missing control operate
  });
});
