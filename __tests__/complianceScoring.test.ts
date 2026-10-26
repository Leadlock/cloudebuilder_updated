/** How a control is scored: each rung of the ladder, the caps, and that a claim alone never reads as proof. */
import { resultFor, scoreControl, EVIDENCE_WINDOW_DAYS } from '@/lib/compliance/scoring';
import type { ControlRecord, EvidenceRef, Signal } from '@/lib/compliance/types';

const asOf = new Date('2026-10-26T00:00:00Z');
const rec = (over: Partial<ControlRecord> = {}): ControlRecord => ({ controlId: 'C', status: 'implemented', owner: 'Priya', note: '', naReason: '', reviewer: '', ...over });
const ev = (daysAgo: number, over: Partial<EvidenceRef> = {}): EvidenceRef => ({ id: `e${daysAgo}`, title: 'x', kind: 'file', origin: 'manual', collectedAt: new Date(asOf.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10), ...over });
const sig = (basis: Signal['basis'], result: Signal['result'] = 'pass'): Signal => ({ basis, result, ref: 'AWS-X-1', text: 'a check' });
const score = (record: ControlRecord | undefined, evidence: EvidenceRef[] = [], signals: Signal[] = []) => scoreControl({ record, evidence, signals, asOf });

describe('not scored', () => {
  it('nobody has answered and no check applies: not assessed, never a pass', () => {
    const s = score(undefined);
    expect(s.score).toBeNull();
    expect(s.reasons[0]).toMatch(/Nobody has assessed/);
  });
  it('not applicable needs a reason; without one it stays open', () => {
    expect(score(rec({ status: 'not_applicable', naReason: 'No physical offices: the cloud provider holds the hardware.' })).score).toBeNull();
    expect(score(rec({ status: 'not_applicable', naReason: 'No physical offices: the cloud provider holds the hardware.' })).reasons[0]).toMatch(/Marked not applicable/);
    expect(score(rec({ status: 'not_applicable', naReason: '  ' })).reasons[0]).toMatch(/without a reason/);
  });
});

describe('the ladder', () => {
  it('0: none and planned are missing, whatever is attached', () => {
    expect(score(rec({ status: 'none' })).score).toBe(0);
    expect(score(rec({ status: 'planned' }), [ev(10)]).score).toBe(0);
  });
  it('1: said to be in place, nothing to show it; and a partial claim with nothing attached', () => {
    expect(score(rec()).score).toBe(1);
    expect(score(rec({ status: 'partial' })).score).toBe(1);
  });
  it('2: something supports it, but it is old, partial or only read from the design', () => {
    expect(score(rec(), [ev(EVIDENCE_WINDOW_DAYS + 5)]).score).toBe(2);
    expect(score(rec(), [], [sig('design')]).score).toBe(2);
    expect(score(rec({ status: 'partial' }), [ev(5)]).score).toBe(2);
  });
  it('3: dated evidence inside the window, or a reading of the account, with nothing against it', () => {
    expect(score(rec(), [ev(30)]).score).toBe(3);
    expect(score(rec(), [], [sig('discovered')]).score).toBe(3);
    expect(score(rec(), [], [sig('platform')]).score).toBe(3);
  });
  it('4: operating, a live or system source, and reviewed by someone else inside the window', () => {
    const reviewed = rec({ reviewer: 'Sam', reviewedAt: '2026-09-30' });
    expect(score(reviewed, [], [sig('live')]).score).toBe(4);
    expect(score(reviewed, [ev(10, { origin: 'system' })]).score).toBe(4);
    expect(score(reviewed, [ev(10, { origin: 'manual' })]).score).toBe(3);                              // hand-made evidence is not enough
    expect(score(rec({ reviewer: 'priya', reviewedAt: '2026-09-30' }), [], [sig('live')]).score).toBe(3);   // the owner cannot review themselves
    expect(score(rec({ reviewer: 'Sam', reviewedAt: '2024-01-01' }), [], [sig('live')]).score).toBe(3);    // an old review does not count
  });
  it('an answer to a question on its own is never above informal', () => {
    expect(score(undefined, [], [sig('answer')]).score).toBeNull();            // nobody owns it: still not assessed
    expect(score(rec(), [], [sig('answer')]).score).toBe(1);
  });
});

describe('what holds a score down', () => {
  it('a failing check caps it at 2 however good the evidence', () => {
    const s = score(rec({ reviewer: 'Sam', reviewedAt: '2026-10-01' }), [ev(3, { origin: 'system' })], [sig('live'), sig('design', 'fail')]);
    expect(s.score).toBe(2);
    expect(s.reasons.join(' ')).toMatch(/Capped at 2/);
    expect(s.failing).toHaveLength(1);
  });
  it('a check that could not be completed stops it at 2', () => {
    expect(score(rec(), [ev(5)], [sig('design', 'unclear')]).score).toBe(2);
  });
  it('a failing check with nobody answering is still reported, at its cap', () => {
    const s = score(undefined, [], [sig('design', 'fail')]);
    expect(s.score).toBe(0);
    expect(s.reasons[0]).toMatch(/check found a problem/);
  });
  it('evidence dated in the future, or past its expiry, is not fresh', () => {
    expect(score(rec(), [ev(-40)]).score).toBe(2);
    expect(score(rec(), [ev(10, { validUntil: '2026-09-01' })]).score).toBe(2);
  });
  it('with no answer, passing checks alone imply "implemented", at the strength the checks give', () => {
    expect(score(undefined, [], [sig('design')]).score).toBe(2);
    expect(score(undefined, [], [sig('discovered')]).score).toBe(3);
  });
});

describe('confidence and the next step', () => {
  it('is High from a reading of the account, Medium from dated hand-made evidence, Low from a claim', () => {
    expect(score(rec(), [], [sig('live')]).confidence).toBe('High');
    expect(score(rec(), [ev(10)]).confidence).toBe('Medium');
    expect(score(rec()).confidence).toBe('Low');
  });
  it('says what would raise the score', () => {
    expect(score(rec()).nextStep).toMatch(/Attach dated evidence/);
    expect(score(rec({ status: 'planned' })).nextStep).toMatch(/Put the control in place/);
    expect(score(rec(), [ev(10)]).nextStep).toMatch(/someone other than the owner/);
    expect(score(rec(), [], [sig('design', 'fail')]).nextStep).toMatch(/Fix what the check found/);
  });
  it('builds a result with the label a reader sees', () => {
    const r = resultFor({ id: 'CTL-01', title: 'T', group: 'CC1.1' }, { record: rec(), evidence: [ev(10)], signals: [], asOf });
    expect(r).toMatchObject({ id: 'CTL-01', score: 3, scoreLabel: 'Operating', owner: 'Priya' });
    expect(resultFor({ id: 'x', title: 'T', group: 'g' }, { evidence: [], signals: [], asOf }).scoreLabel).toBe('Not assessed');
    expect(resultFor({ id: 'x', title: 'T', group: 'g' }, { record: rec({ status: 'not_applicable', naReason: 'Because.' }), evidence: [], signals: [], asOf }).scoreLabel).toBe('Not applicable');
  });
});
