/**
 * Well-Architected review: thin pillars read as thin (item 3) and reviews are tracked over time (item 5).
 *
 *  - a pillar resting on fewer than 5 different checks says "limited evidence" in the engine result, the UI model and every export;
 *  - a review made with an older ruleset is stale, with the reason, and the repository derives that from the stored ruleset;
 *  - consecutive identical reviews collapse, and the latest review is compared with the last one that actually differed:
 *    score movement per pillar, findings that appeared, findings that were fixed.
 */
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { RULESET_VERSION } from '@/lib/engines/assessment/types';
import { THIN_PILLAR_RULES } from '@/lib/engines/assessment/scoring';
import { buildReport } from '@/lib/engines/assessment/report/buildReport';
import { LIMITED_EVIDENCE_NOTE, pillarScoreText, waPillarViews } from '@/lib/engines/assessment/report/waReportView';
import { renderReportHtml } from '@/lib/services/report/renderReportHtml';
import { renderWaReportHtml } from '@/lib/services/report/renderWaReportHtml';
import { renderReportPdf } from '@/lib/services/report/renderReportPdf';
import { renderWaReportPdf } from '@/lib/services/report/renderWaReportPdf';
import { buildSnapshot } from '@/lib/services/AssessmentSnapshotService';
import { WellArchitectedRuleEngine } from '@/lib/engines/wellArchitected/WellArchitectedRuleEngine';
import { buildHistory, compareReviews, findingKey, sameReview } from '@/lib/engines/wellArchitected/history';
import type { WaAssessment, WaFinding, WaPillarScore } from '@/lib/engines/wellArchitected/types';
import { getResourceDefinition } from '@/lib/resources';
import type { DbArchitecture } from '@/lib/repositories/architectureRepository';
import type { CanvasNode } from '@/types';

function node(id: string, resourceType: string, config: Record<string, unknown> = {}, extra: Partial<CanvasNode> = {}): CanvasNode {
  const def = getResourceDefinition(resourceType)!;
  return { id, type: 'cloudNode', resourceType, provider: resourceType.startsWith('azure_') ? 'azure' : 'aws', label: id, position: { x: 0, y: 0 }, config: { ...def.defaultConfig, ...config }, ...extra } as CanvasNode;
}
const design = () => ({
  nodes: [node('vpc', 'aws_vpc'), node('s1', 'aws_subnet', {}, { parentId: 'vpc' }), node('s2', 'aws_subnet', {}, { parentId: 'vpc' }), node('db', 'aws_rds'), node('b', 'aws_s3'), node('alb', 'aws_alb'), node('sg', 'aws_sg')],
  edges: [] as { id: string; source: string; target: string }[],
});
function dbArch(nodes: CanvasNode[]): DbArchitecture {
  return {
    id: 'arch-1', environmentId: 'env-1', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', revision: 1,
    resources: nodes.map((n) => ({ id: n.id, resourceType: n.resourceType, provider: n.provider, label: n.label, positionX: 0, positionY: 0, configJson: JSON.stringify(n.config), region: null, groupId: n.parentId ?? null, locked: false, architectureId: 'arch-1' })),
    connections: [],
  };
}

describe('item 3 — thin pillars read as thin', () => {
  const a = runAssessment({ nodes: design().nodes, edges: [] });
  const pillar = (id: string) => a.pillarResults.find((p) => p.provider === 'aws' && p.pillar === id)!;

  test('the engine counts different scored rules per pillar, and flags fewer than the threshold', () => {
    expect(THIN_PILLAR_RULES).toBe(5);
    expect(pillar('security').evaluatedRules).toBeGreaterThanOrEqual(THIN_PILLAR_RULES);
    expect(pillar('security').limitedEvidence).toBe(false);
    expect(pillar('cost_optimization').evaluatedRules).toBeLessThan(THIN_PILLAR_RULES);
    expect(pillar('cost_optimization').limitedEvidence).toBe(true);
  });

  test('informational checks carry no weight, so they are not counted as evidence', () => {
    const perf = pillar('performance_efficiency');
    const informationalOnly = runAssessment({ nodes: [node('c', 'aws_elasticache')], edges: [] }).pillarResults.find((p) => p.pillar === 'performance_efficiency')!;
    expect(informationalOnly.evaluatedRules).toBe(0);
    expect(informationalOnly.limitedEvidence).toBe(true);
    expect(perf.evaluatedRules).toBeGreaterThanOrEqual(0);
  });

  test('the Well-Architected adapter passes the same numbers through', () => {
    const wa = new WellArchitectedRuleEngine().analyze({ architectureId: 'a', ...design() });
    for (const p of wa.pillarScores) {
      const source = a.pillarResults.find((r) => r.provider === p.provider && r.pillar === p.pillar)!;
      expect([p.pillar, p.evaluatedRules, p.limitedEvidence]).toEqual([p.pillar, source.evaluatedRules, source.limitedEvidence]);
    }
  });

  test('score text: a verdict for a well-evidenced pillar, indicative for a thin one, "Not scored" for none', () => {
    expect(pillarScoreText(95, false, 23)).toBe('95/100');
    expect(pillarScoreText(25, true, 2)).toBe('25/100 (indicative: limited evidence, 2 checks)');
    expect(pillarScoreText(50, true, 1)).toContain('1 check)');
    expect(pillarScoreText(25, true, 2, true)).toBe('25/100 (limited)');
    expect(pillarScoreText(null, true, 0)).toBe('Not scored');
  });

  describe('exports', () => {
    const snap = buildSnapshot({ scanId: '00000000-1111-4222-8333-444444444444', project: { id: 'p1', name: 'QA', environment: 'production', region: 'us-east-1' }, arch: dbArch(design().nodes), createdBy: 'qa', reviews: [], now: '2026-09-24T10:00:00.000Z' });
    const report = buildReport(snap, { generatedAt: '2026-09-24T10:05:00.000Z' });

    test('the report model carries the check counts', () => {
      const views = waPillarViews(report);
      expect(views.every((v) => typeof v.evaluatedRules === 'number' && typeof v.limitedEvidence === 'boolean')).toBe(true);
      expect(views.some((v) => v.limitedEvidence)).toBe(true);
      expect(report.executive.wellArchitected[0]!.pillars.every((p) => typeof p.checks === 'number')).toBe(true);
    });

    test('the security report HTML marks a thin pillar and explains the mark once', () => {
      const html = renderReportHtml(report);
      expect(html).toMatch(/\/100 \(limited\)/);
      expect(html).toContain(LIMITED_EVIDENCE_NOTE.replace(/"/g, '&quot;'));
      expect(html).toMatch(/indicative: limited evidence, \d+ checks?\)/);
    });

    test('the Well-Architected report HTML marks a thin pillar too', () => {
      const html = renderWaReportHtml(report);
      expect(html).toMatch(/\/100 \(limited\)/);
      expect(html).toMatch(/indicative: limited evidence/);
    });

    test('both PDFs still render', async () => {
      const [a1, a2] = await Promise.all([renderReportPdf(report), renderWaReportPdf(report)]);
      expect(a1.subarray(0, 4).toString()).toBe('%PDF');
      expect(a2.subarray(0, 4).toString()).toBe('%PDF');
    });
  });
});

// ─── History ────────────────────────────────────────────────────────────────

const pillarScore = (pillar: WaPillarScore['pillar'], score: number, scored = true): WaPillarScore => ({
  pillar, pillarLabel: pillar, provider: 'aws', score, scored, findingCount: 0, criticalCount: 0, highCount: 0,
});
const finding = (ruleId: string, resources: string[], severity: WaFinding['severity'] = 'low'): WaFinding => ({
  id: `${ruleId}-${resources.join('')}`, ruleId, provider: 'aws', pillar: 'security', pillarLabel: 'Security', pillarRef: '', severity, title: `Title of ${ruleId}`,
  description: '', affectedResourceIds: resources, affectedResourceLabels: resources.map((r) => r.toUpperCase()), evidence: {}, recommendation: '', remediation: '',
  frameworkReference: '', source: 'DESIGN_TIME', sourceLabel: '', detectedAt: '',
} as WaFinding);
const review = (over: Partial<WaAssessment> & { at: string; score: number }): WaAssessment => ({
  architectureId: 'a', projectId: 'p', provider: 'aws', framework: 'AWS', frameworkVersion: '2024', frameworkSource: '', overallScore: over.score, overallScored: true,
  coveragePct: 90, notEvaluatedCount: 0, pillarScores: [pillarScore('security', over.score)], findings: [], evaluatedAt: over.at, source: 'DESIGN_TIME', sourceLabel: '',
  confidence: 'design-time', isStale: false, rulesetVersion: RULESET_VERSION, ...over,
} as WaAssessment);

describe('item 5 — review history', () => {
  test('a finding is the same finding when the same rule fires on the same resources, in any order', () => {
    expect(findingKey(finding('R1', ['b', 'a']))).toBe(findingKey(finding('R1', ['a', 'b'])));
    expect(findingKey(finding('R1', ['a']))).not.toBe(findingKey(finding('R1', ['b'])));
    expect(findingKey(finding('R1', ['a']))).not.toBe(findingKey(finding('R2', ['a'])));
  });

  test('compares the latest review with the previous: score, pillars, new and fixed findings', () => {
    const before = review({ at: '2026-10-01T10:00:00Z', score: 93, findings: [finding('A', ['x']), finding('B', ['y'])] });
    const after = review({ at: '2026-10-02T10:00:00Z', score: 98, findings: [finding('B', ['y']), finding('C', ['z'], 'high')] });
    const c = compareReviews(after, before);
    expect([c.overallBefore, c.overallAfter, c.overallDelta]).toEqual([93, 98, 5]);
    expect(c.newFindings.map((f) => f.ruleId)).toEqual(['C']);
    expect(c.newFindings[0]!.severity).toBe('high');
    expect(c.resolvedFindings.map((f) => f.ruleId)).toEqual(['A']);
    expect(c.pillars.find((p) => p.pillar === 'security')).toMatchObject({ before: 93, after: 98, delta: 5 });
    expect(c.since).toBe('2026-10-01T10:00:00Z');
    expect(c.rulesetChanged).toBe(false);
  });

  test('the same rule firing on a different resource is a fix plus a new finding, not "unchanged"', () => {
    const c = compareReviews(
      review({ at: '2', score: 90, findings: [finding('A', ['new'])] }),
      review({ at: '1', score: 90, findings: [finding('A', ['old'])] }),
    );
    expect(c.newFindings).toHaveLength(1);
    expect(c.resolvedFindings).toHaveLength(1);
  });

  test('says when the rules changed between the two reviews, because the score may then move without the design changing', () => {
    const c = compareReviews(review({ at: '2', score: 80, rulesetVersion: '2026.10.1' }), review({ at: '1', score: 90, rulesetVersion: '2026.09.2' }));
    expect(c.rulesetChanged).toBe(true);
    expect([c.previousRulesetVersion, c.currentRulesetVersion]).toEqual(['2026.09.2', '2026.10.1']);
  });

  test('an unscored side gives no score movement rather than a fake number', () => {
    const c = compareReviews(review({ at: '2', score: 0, overallScored: false }), review({ at: '1', score: 90 }));
    expect(c.overallAfter).toBeNull();
    expect(c.overallDelta).toBeNull();
  });

  test('identical consecutive re-runs collapse into one entry, and the comparison skips them', () => {
    const same = (at: string) => review({ at, score: 98, findings: [finding('A', ['x'])] });
    const older = review({ at: '2026-09-30T10:00:00Z', score: 90, findings: [finding('A', ['x']), finding('B', ['y'])] });
    const h = buildHistory([same('2026-10-03T10:00:00Z'), same('2026-10-02T10:00:00Z'), same('2026-10-01T10:00:00Z'), older]);
    expect(h.entries).toHaveLength(2);
    expect(h.entries[0]).toMatchObject({ overallScore: 98, repeats: 3 });
    expect(h.entries[1]).toMatchObject({ overallScore: 90, repeats: 1 });
    expect(h.changes?.since).toBe('2026-09-30T10:00:00Z');
    expect(h.changes?.resolvedFindings.map((f) => f.ruleId)).toEqual(['B']);
  });

  test('one review, or only identical reviews, has nothing to compare', () => {
    expect(buildHistory([]).changes).toBeNull();
    expect(buildHistory([review({ at: '1', score: 90 })]).changes).toBeNull();
    expect(buildHistory([review({ at: '2', score: 90 }), review({ at: '1', score: 90 })]).changes).toBeNull();
    expect(buildHistory([review({ at: '2', score: 90 }), review({ at: '1', score: 90 })]).entries[0]!.repeats).toBe(2);
  });

  test('sameReview notices a different ruleset, score, pillar score or finding', () => {
    const base = review({ at: '1', score: 90, findings: [finding('A', ['x'])] });
    expect(sameReview(base, { ...base, evaluatedAt: 'later' })).toBe(true);
    expect(sameReview(base, { ...base, rulesetVersion: 'other' })).toBe(false);
    expect(sameReview(base, { ...base, overallScore: 91 })).toBe(false);
    expect(sameReview(base, { ...base, pillarScores: [pillarScore('security', 50)] })).toBe(false);
    expect(sameReview(base, { ...base, findings: [] })).toBe(false);
  });

  test('the list is capped', () => {
    const many = Array.from({ length: 30 }, (_, i) => review({ at: String(100 - i), score: i }));
    expect(buildHistory(many, 8).entries).toHaveLength(8);
  });
});

// ─── Staleness (repository) ─────────────────────────────────────────────────

const rows: Record<string, unknown>[] = [];
const created: Record<string, unknown>[] = [];
jest.mock('@/src/prisma/db', () => ({
  db: {
    orm: {
      public: {
        WellArchitectedAssessment: {
          create: async (r: Record<string, unknown>) => { created.push(r); rows.push(r); return r; },
          where: () => ({ all: async () => rows, update: async () => undefined }),
        },
        WellArchitectedFinding: { create: async () => undefined, where: () => ({ all: async () => [] }) },
      },
    },
  },
}));

describe('item 5 — staleness comes from the stored ruleset', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const repo = () => (require('@/lib/repositories/wellArchitectedRepository') as typeof import('@/lib/repositories/wellArchitectedRepository')).wellArchitectedRepository;
  const row = (id: string, createdAt: string, rulesetVersion: string, isStale = false) => ({
    id, projectId: 'p', architectureId: 'arch-x', provider: 'aws', framework: 'AWS', frameworkVersion: '2024', overallScore: 80, pillarScoresJson: '[]', findingsJson: '[]',
    source: 'DESIGN_TIME', sourceLabel: '', confidence: 'design-time', isStale, rulesetVersion, createdAt, completedAt: createdAt,
  });
  beforeEach(() => { rows.length = 0; created.length = 0; });

  test('saving a review records the ruleset that produced it', async () => {
    await repo().createAssessment(review({ at: '2026-10-01T10:00:00Z', score: 90, architectureId: 'arch-x' }));
    expect(created[0]!['rulesetVersion']).toBe(RULESET_VERSION);
  });

  test('a review from the current ruleset is fresh', async () => {
    rows.push(row('1', '2026-10-01T10:00:00Z', RULESET_VERSION));
    const a = (await repo().findLatestByArchitecture('arch-x'))!;
    expect(a.isStale).toBe(false);
    expect(a.staleReason).toBeUndefined();
    expect(a.rulesetVersion).toBe(RULESET_VERSION);
  });

  test('a review from another ruleset is stale, and says why', async () => {
    rows.push(row('1', '2026-10-01T10:00:00Z', '2025.01.1'));
    const a = (await repo().findLatestByArchitecture('arch-x'))!;
    expect(a.isStale).toBe(true);
    expect(a.staleReason).toBe('ruleset');
  });

  test('a review saved before the ruleset was recorded is stale', async () => {
    rows.push(row('1', '2026-10-01T10:00:00Z', ''));
    expect((await repo().findLatestByArchitecture('arch-x'))!.staleReason).toBe('ruleset');
  });

  test('a canvas change is reported as an architecture change, taking priority', async () => {
    rows.push(row('1', '2026-10-01T10:00:00Z', RULESET_VERSION, true));
    const a = (await repo().findLatestByArchitecture('arch-x'))!;
    expect(a.isStale).toBe(true);
    expect(a.staleReason).toBe('architecture');
  });

  test('the history lists reviews newest first, keeping each review\'s own ruleset', async () => {
    rows.push(row('old', '2026-09-01T10:00:00Z', '2026.09.2'), row('new', '2026-10-05T10:00:00Z', RULESET_VERSION), row('mid', '2026-09-20T10:00:00Z', '2026.09.2'));
    const list = await repo().listByArchitecture('arch-x');
    expect(list.map((r) => r.evaluatedAt)).toEqual(['2026-10-05T10:00:00Z', '2026-09-20T10:00:00Z', '2026-09-01T10:00:00Z']);
    expect(list.map((r) => r.rulesetVersion)).toEqual([RULESET_VERSION, '2026.09.2', '2026.09.2']);
    expect(buildHistory(list).changes?.rulesetChanged).toBe(true);
  });
});
