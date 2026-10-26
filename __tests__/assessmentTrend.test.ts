/** The saved assessment scores (scripts/assessment-trend.baseline.json) cover every built-in template and the current rule set, so the CI comparison is meaningful. */
import { readFileSync } from 'fs';
import path from 'path';
import { architectureTemplates } from '@/lib/templates';
import { RULESET_VERSION } from '@/lib/engines/assessment/types';

const baseline = JSON.parse(readFileSync(path.join(process.cwd(), 'scripts', 'assessment-trend.baseline.json'), 'utf8')) as { rulesetVersion: string; templates: Record<string, { overall: number | null; security: number | null }> };

it('was made with the current rule set (run `npm run assessment:trend -- --update` after a rule change, once you have read what moved)', () => {
  expect(baseline.rulesetVersion).toBe(RULESET_VERSION);
});

it('has a score for every built-in template and none for a template that no longer exists', () => {
  expect(Object.keys(baseline.templates).sort()).toEqual(architectureTemplates.map((t) => t.id).sort());
});

it('has real scores, not empty ones', () => {
  const scored = Object.values(baseline.templates).filter((t) => t.overall !== null);
  expect(scored.length).toBeGreaterThan(200);
  for (const t of scored) { expect(t.overall!).toBeGreaterThanOrEqual(0); expect(t.overall!).toBeLessThanOrEqual(100); }
});
