/**
 * Assessment trend: runs the Well-Architected assessment on every built-in template (the same fixed designs every time) and compares each score with
 * scripts/assessment-trend.baseline.json. A change to a rule, a resource default or a generator can move scores across the whole library without any one
 * test noticing; this makes the movement visible in the pull request that caused it, and a drop has to be looked at and accepted.
 *
 *   npm run assessment:trend            compare, print what moved, exit 1 on a drop (or a rule set that changed without the baseline)
 *   npm run assessment:trend -- --update   accept today's scores as the new baseline (after reading what moved)
 *
 * Only deterministic things are used (no AI, no network, a fixed evaluation time), so a score can only change when the rules or the designs do.
 * Also writes assessment-trend.md (and adds it to the GitHub job summary): the average score by provider and what changed.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { architectureTemplates } from '@/lib/templates';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { RULESET_VERSION } from '@/lib/engines/assessment/types';

/** A template whose overall or security score falls by more than this many points is a drop. */
const TOLERANCE = 3;
const FIXED_TIME = '2026-01-01T00:00:00.000Z';

interface Row { overall: number | null; security: number | null; critical: number; high: number; findings: number }
interface Baseline { rulesetVersion: string; templates: Record<string, Row> }

const baselineFile = path.join(process.cwd(), 'scripts', 'assessment-trend.baseline.json');
const update = process.argv.includes('--update');

const round = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
function measure(): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const t of architectureTemplates) {
    const g = t.generate({});
    const a = runAssessment({ nodes: g.nodes, edges: g.edges, evaluatedAt: FIXED_TIME });
    out[t.id] = {
      overall: round(a.overallScore.score), security: round(a.securityScore.score),
      critical: a.findings.filter((f) => f.severity === 'CRITICAL').length, high: a.findings.filter((f) => f.severity === 'HIGH').length, findings: a.findings.length,
    };
  }
  return out;
}

const mean = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x !== null); return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null; };
const now = measure();
const providerOf = (id: string) => architectureTemplates.find((t) => t.id === id)?.provider ?? 'other';

if (update || !existsSync(baselineFile)) {
  const baseline: Baseline = { rulesetVersion: RULESET_VERSION, templates: now };
  writeFileSync(baselineFile, JSON.stringify(baseline, null, 1) + '\n');
  console.log(`${update ? 'Updated' : 'Created'} ${path.relative(process.cwd(), baselineFile)}: ${Object.keys(now).length} templates, rule set ${RULESET_VERSION}.`);
  process.exit(0);
}

const base = JSON.parse(readFileSync(baselineFile, 'utf8')) as Baseline;
const problems: string[] = []; const moved: string[] = [];
for (const id of new Set([...Object.keys(base.templates), ...Object.keys(now)])) {
  const b = base.templates[id]; const n = now[id];
  if (!b) { problems.push(`${id}: a new template with no saved score (run with --update)`); continue; }
  if (!n) { problems.push(`${id}: in the baseline but no longer a template (run with --update)`); continue; }
  for (const k of ['overall', 'security'] as const) {
    if (b[k] !== null && n[k] !== null && n[k]! < b[k]! - TOLERANCE) problems.push(`${id}: ${k} score fell from ${b[k]} to ${n[k]}`);
    else if (b[k] !== n[k]) moved.push(`${id}: ${k} ${b[k]} -> ${n[k]}`);
  }
  if (n.critical > b.critical) problems.push(`${id}: critical findings rose from ${b.critical} to ${n.critical}`);
  if (n.high > b.high) problems.push(`${id}: high findings rose from ${b.high} to ${n.high}`);
}
if (base.rulesetVersion !== RULESET_VERSION && problems.length === 0) problems.push(`the rule set changed (${base.rulesetVersion} -> ${RULESET_VERSION}) and the baseline was not updated: read what moved below, then run with --update`);

const lines = [`## Assessment trend (rule set ${RULESET_VERSION}, ${Object.keys(now).length} templates)`, '', '| Provider | Templates | Average overall | Saved average | Average security | Saved average |', '|---|---|---|---|---|---|'];
for (const p of [...new Set(Object.keys(now).map(providerOf))].sort()) {
  const ids = Object.keys(now).filter((id) => providerOf(id) === p);
  lines.push(`| ${p} | ${ids.length} | ${mean(ids.map((i) => now[i]!.overall))} | ${mean(ids.map((i) => base.templates[i]?.overall ?? null))} | ${mean(ids.map((i) => now[i]!.security))} | ${mean(ids.map((i) => base.templates[i]?.security ?? null))} |`);
}
lines.push('', problems.length ? `**${problems.length} problem${problems.length === 1 ? '' : 's'}:**\n\n${problems.slice(0, 40).map((p) => `- ${p}`).join('\n')}` : '**No score fell.**');
if (moved.length) lines.push('', `${moved.length} score${moved.length === 1 ? '' : 's'} moved within the tolerance or rose (first 20):`, '', ...moved.slice(0, 20).map((m) => `- ${m}`));
const report = lines.join('\n') + '\n';
writeFileSync('assessment-trend.md', report);
if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], report);
console.log(report);
process.exit(problems.length > 0 ? 1 : 0);
