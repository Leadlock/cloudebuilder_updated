import { analyzePeriod, controlsOf, periodSentence, MAX_GAP_DAYS, type SnapshotRecord } from '@/lib/compliance/snapshots';
import { fixtureReport } from './helpers/complianceFixture';

const snap = (day: string, controls: Array<[string, number | null, string[]?]>): SnapshotRecord => ({ id: day, takenAt: `${day}T06:00:00.000Z`, trigger: 'scheduled', readiness: 'Not ready', controls: controls.map(([id, score, failing]) => ({ id, score, confidence: 'Medium', failing: failing ?? [], evidence: 1 })) });
const range = (a: string, b: string) => [new Date(`${a}T00:00:00Z`), new Date(`${b}T23:59:59Z`)] as const;

describe('a report becomes a compact snapshot', () => {
  it('keeps one entry per control with its score and the checks that failed', () => {
    const r = fixtureReport('soc2');
    const c = controlsOf(r);
    expect(c).toHaveLength(r.results.length);
    const failing = c.find((x) => x.failing.length > 0);
    expect(failing?.failing[0]).toMatch(/^[A-Z]+-/);
  });
});

describe('what a run of snapshots shows', () => {
  it('a control is continuous only if it operated, with no failing check, in every snapshot', () => {
    const days = ['2026-07-01', '2026-07-05', '2026-07-09', '2026-07-13'];
    const s = [
      snap(days[0]!, [['A', 3], ['B', 3], ['C', 4]]), snap(days[1]!, [['A', 3], ['B', 2], ['C', 4]]),
      snap(days[2]!, [['A', 4], ['B', 3], ['C', 3, ['AWS-X-1']]]), snap(days[3]!, [['A', 3], ['B', 3], ['C', 4]]),
    ];
    const [from, to] = range('2026-07-01', '2026-07-14');
    const a = analyzePeriod('soc2', s, from, to);
    const by = Object.fromEntries(a.controls.map((c) => [c.id, c]));
    expect(by['A']).toMatchObject({ continuous: true, operating: 4, minScore: 3 });
    expect(by['B']).toMatchObject({ continuous: false, operating: 3, minScore: 2 });
    expect(by['C']).toMatchObject({ continuous: false, failing: 1 });
    expect(a).toMatchObject({ snapshotCount: 4, spanDays: 12, continuousControls: 1, assessedControls: 3, gaps: [] });
  });

  it('a stretch with no snapshots is a gap, including at the edges of the period', () => {
    const s = [snap('2026-07-10', [['A', 3]]), snap('2026-07-12', [['A', 3]]), snap('2026-07-30', [['A', 3]])];
    const [from, to] = range('2026-07-01', '2026-08-15');
    const a = analyzePeriod('soc2', s, from, to);
    expect(a.gaps.map((g) => [g.from, g.to])).toEqual([['2026-07-01', '2026-07-10'], ['2026-07-12', '2026-07-30'], ['2026-07-30', '2026-08-15']]);
    expect(a.longestGapDays).toBeGreaterThan(MAX_GAP_DAYS);
  });

  it('snapshots outside the period are ignored, and an empty period says so', () => {
    const [from, to] = range('2026-07-01', '2026-07-31');
    const a = analyzePeriod('soc2', [snap('2026-06-01', [['A', 3]])], from, to);
    expect(a.snapshotCount).toBe(0);
    expect(periodSentence(a)).toMatch(/nothing can be said/);
  });

  it('a control never assessed (score null) or missing from a snapshot is not continuous', () => {
    const s = [snap('2026-07-01', [['A', null], ['B', 3]]), snap('2026-07-03', [['A', null]])];
    const [from, to] = range('2026-07-01', '2026-07-04');
    const by = Object.fromEntries(analyzePeriod('soc2', s, from, to).controls.map((c) => [c.id, c]));
    expect(by['A']).toMatchObject({ continuous: false, minScore: null });
    expect(by['B']).toMatchObject({ continuous: false, snapshots: 1 });
  });

  it('the opening sentence states the facts plainly', () => {
    const s = [snap('2026-07-01', [['A', 3]]), snap('2026-07-06', [['A', 3]])];
    const [from, to] = range('2026-07-01', '2026-07-07');
    expect(periodSentence(analyzePeriod('soc2', s, from, to))).toBe('2 snapshots were taken between 2026-07-01 and 2026-07-07, over 5 days. There is no gap longer than 7 days. 1 of 1 assessed controls operated (score 3 or more, no failing check) in every snapshot.');
  });
});
