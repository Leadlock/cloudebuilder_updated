/**
 * Performance regression guard (generous budgets for CI machines). Measured locally:
 * 500 resources → assessment ~15 ms, bulk safe fixes (142) ~100 ms, PDF ~2 s.
 * The bulk budget specifically guards against the former per-fix full re-assessment +
 * 4× Terraform regeneration (O(fixes × resources), 22 s at 500 resources).
 */
import { graph } from '../scripts/perfGraph';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { applySafeFixes, safeFixCandidates } from '@/lib/engines/assessment/autofix';

const ms = (f: () => unknown) => { const t0 = performance.now(); f(); return performance.now() - t0; };

describe('assessment performance', () => {
  test('500 resources: assessment < 1 s, bulk safe fixes < 5 s, and bulk fixes resolve their findings', () => {
    const { nodes, edges } = graph(500);
    runAssessment({ nodes, edges }); // warm-up
    expect(ms(() => runAssessment({ nodes, edges }))).toBeLessThan(1000);
    const cands = safeFixCandidates(runAssessment({ nodes, edges }).findings);
    expect(cands.length).toBeGreaterThan(100);
    let summary!: ReturnType<typeof applySafeFixes>;
    expect(ms(() => { summary = applySafeFixes(nodes, edges, cands.map((c) => c.findingId)); })).toBeLessThan(5000);
    expect(summary.resolved).toBe(cands.length);
    const remaining = new Set(runAssessment({ nodes: summary.nodes, edges }).findings.map((f) => f.findingId));
    expect(cands.filter((c) => remaining.has(c.findingId))).toEqual([]);
  }, 60_000);

  test('assessment time grows roughly linearly (500 vs 100 resources < 12×)', () => {
    const small = graph(100); const big = graph(500);
    for (let i = 0; i < 2; i++) { runAssessment(small); runAssessment(big); }
    const t = (g: typeof small) => Math.min(...[0, 1, 2, 3, 4].map(() => ms(() => runAssessment(g))));
    // Wall-clock time is noisy when the whole suite runs in parallel: one slow moment in the 100-resource run (4 ms) inflates the ratio. A real
    // slowdown (growth that is worse than linear) makes EVERY attempt exceed the limit, so the guard passes if any of a few attempts is within it.
    const ratios: number[] = [];
    for (let attempt = 0; attempt < 5 && !ratios.some((r) => r < 12); attempt++) ratios.push(t(big) / Math.max(t(small), 1));
    expect(Math.min(...ratios)).toBeLessThan(12);
  }, 60_000);
});
