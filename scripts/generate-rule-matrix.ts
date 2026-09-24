/**
 * Regenerates docs/security-assessment/RULE_MATRIX.md from the rule registry, and validates
 * every rule while doing so (exits non-zero on a validation error).
 * Usage: npm run docs:rule-matrix
 */
import fs from 'fs';
import { getResourceDefinition } from '@/lib/resources';
import { ALL_RULES } from '@/lib/engines/assessment/rules';
import { REFERENCES } from '@/lib/engines/assessment/references';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { EVIDENCE_AVAILABILITY, EVIDENCE_CLASS_LABEL } from '@/lib/engines/assessment/evidenceAvailability';
import { RULESET_VERSION } from '@/lib/engines/assessment/types';
import type { CanvasNode } from '@/types';

const tests = fs.readdirSync('__tests__').filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(`__tests__/${f}`, 'utf8')).join('\n');
const node = (t: string): CanvasNode => ({ id: `n-${t}`, type: 'cloudNode', resourceType: t, provider: t.startsWith('azure') ? 'azure' : 'aws', label: t, position: { x: 0, y: 0 }, config: { ...(getResourceDefinition(t)?.defaultConfig ?? {}) } } as CanvasNode);
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const V: Record<string, string> = { VERIFIED_OFFICIAL_SOURCE: 'Verified (official source)', CROSS_CHECKED_SECONDARY: 'Cross-checked (secondary source)', NOT_VERIFIED_IN_BUILD: 'Not verified' };

const errors: string[] = [];
const rows: string[] = [];
const counts: Record<string, number> = {};
for (const r of ALL_RULES) {
  const refs = r.references.map((k) => REFERENCES[k]).filter(Boolean);
  if (refs.length !== r.references.length) errors.push(`${r.id}: unknown reference key`);
  const ctrl = refs.filter((x) => x.key.startsWith('AWS-FSBP') || x.key.startsWith('MCSB') || x.key.startsWith('AZPOLICY'));
  const short = (x: typeof refs[number]) => x.key.startsWith('AWS-FSBP') ? `FSBP ${x.identifier}` : x.key.startsWith('MCSB') ? `MCSB ${x.identifier}` : `Azure Policy ${(x.identifier ?? '').slice(0, 8)}`;
  const framework = [...ctrl.map(short), `${r.provider === 'aws' ? 'AWS' : 'Azure'} WA ${r.wellArchitected.pillar}`].join('; ');
  const source = [...new Set(refs.filter((x) => !x.key.startsWith('TF-')).map((x) => x.organization === 'AWS' ? (x.key.startsWith('AWS-FSBP') ? 'AWS Security Hub user guide' : 'AWS Well-Architected') : x.key.startsWith('AZPOLICY') ? 'Azure/azure-policy (MCSB initiative)' : x.key.startsWith('MCSB') ? 'Microsoft cloud security benchmark' : `${x.organization} ${x.framework}`))].join('; ');
  const refVerification = ctrl.length ? [...new Set(ctrl.map((x) => V[x.verification]))].join(' + ') : 'WA guidance only (not verified)';

  // Evidence the rule reads, from running it on the resource definition's default configuration.
  let evidence = '';
  let alwaysNE = false;
  if (r.scope === 'account') { evidence = 'Account/subscription configuration'; alwaysNE = true; }
  else if (r.scope === 'architecture') {
    const sample = r.provider === 'aws' ? ['aws_vpc', 'aws_subnet', 'aws_alb', 'aws_ec2', 'aws_rds'] : ['azure_resource_group', 'azure_vnet', 'azure_subnet', 'azure_vm', 'azure_sql', 'azure_app_service'];
    const out = runAssessment({ nodes: [...new Set([...sample, ...(r.resourceTypes ?? [])])].map(node), edges: [] }).evaluations.filter((e) => e.ruleId === r.id);
    alwaysNE = out.length > 0 && out.every((e) => e.status === 'NOT_EVALUATED');
    evidence = alwaysNE ? 'Not in the architecture model' : 'Topology: resources, connections, containment';
  } else {
    const fields = new Set<string>(); let ne = true; let any = false;
    for (const t of r.resourceTypes ?? []) {
      if (!getResourceDefinition(t)) errors.push(`${r.id}: unknown resource type ${t}`);
      const nodes = t.startsWith('azure') ? [node('azure_resource_group'), node(t)] : [node(t)];
      for (const e of runAssessment({ nodes, edges: [] }).evaluations.filter((x) => x.ruleId === r.id)) {
        any = true; if (e.status !== 'NOT_EVALUATED') ne = false;
        for (const v of e.evidence) fields.add(v.field ? v.field : v.label);
      }
    }
    if (!any) errors.push(`${r.id}: produced no evaluation on its resource types`);
    alwaysNE = any && ne;
    evidence = alwaysNE ? 'Not in the architecture model' : [...fields].slice(0, 4).join(', ');
  }
  if (alwaysNE && !EVIDENCE_AVAILABILITY[r.id]) errors.push(`${r.id}: always NOT_EVALUATED without an evidence-availability classification`);
  if (r.remediation.recommendation.length < 10) errors.push(`${r.id}: missing recommendation`);

  const af = r.autoFix ? (typeof r.autoFix.safety === 'function' ? 'SAFE on design / REVIEW when deployed' : r.autoFix.safety.replace('SAFE_AUTOFIX', 'SAFE').replace('REVIEW_REQUIRED', 'REVIEW').replace('MANUAL_ONLY', 'MANUAL')) : 'None';
  const explicit = new RegExp(`['"\`]${r.id}['"\`-]`).test(tests);
  let status: string;
  if (alwaysNE) status = 'NOT EVALUATED';
  else if (r.scope === 'architecture') status = 'PARTIAL';
  else if (explicit && ctrl.length > 0 && ctrl.every((x) => x.verification === 'VERIFIED_OFFICIAL_SOURCE')) status = 'PRODUCTION IMPLEMENTED';
  else status = 'IMPLEMENTED — LIVE/REFERENCE VERIFICATION REQUIRED';
  counts[status] = (counts[status] ?? 0) + 1;
  const availability = EVIDENCE_AVAILABILITY[r.id];
  const required = alwaysNE && availability ? `${availability.classes.map((c) => EVIDENCE_CLASS_LABEL[c]).join(' + ')}: ${availability.evidenceSource}` : evidence;
  rows.push(`| ${r.id} | ${r.provider.toUpperCase()} | ${cell((r.resourceTypes ?? []).join(', ') || (r.scope === 'account' ? 'Account' : 'Architecture'))} | ${cell(framework)} | ${cell(source)} | ${cell(r.title)} | ${cell(required)} | ${r.severity} | ${cell(r.remediation.recommendation)} | ${af} | ${explicit ? 'Rule-specific' : 'Registry only'} | ${refVerification} | ${status} |`);
}

const HEADER = `# CloudCraft Assessment Rule Matrix

Generated from the rule registry (\`lib/engines/assessment/rules\`) for ruleset **${RULESET_VERSION}** by
\`npm run docs:rule-matrix\`. The generator also validates every rule (reference keys, resource types, evidence,
recommendation, and a classification for any rule that cannot be evaluated) and fails on errors.

Totals: ${ALL_RULES.length} rules (${ALL_RULES.filter((r) => r.provider === 'aws').length} AWS, ${ALL_RULES.filter((r) => r.provider === 'azure').length} Azure). ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('; ')}.

**Columns**
- **RESOURCE**: CloudCraft resource types the rule evaluates, or architecture/account scope.
- **FRAMEWORK**: control references. FSBP = AWS Security Hub Foundational Security Best Practices;
  MCSB = Microsoft cloud security benchmark; Azure Policy = built-in definition (GUID prefix); WA = Well-Architected pillar.
- **SOURCE**: the publication the reference comes from.
- **CONDITION**: what the rule reports when it fails.
- **REQUIRED EVIDENCE**: configuration fields read, topology, or (for controls that cannot be evaluated from the
  model) where the evidence would come from.
- **AUTO-FIX**: SAFE, REVIEW (confirmation required), MANUAL (guidance only), or None.
- **TESTS**: *Rule-specific* = named in an automated test (FAIL/PASS cases, Auto-Fix round trip). *Registry only* = covered only by the generic registry checks.
- **REFERENCE VERIFICATION**:
  - *Verified (official source)*: the identifier was checked against Microsoft's machine-readable Azure Policy MCSB initiative.
  - *Cross-checked (secondary source)*: the FSBP ID, title and severity were checked against a maintained machine-readable
    mapping. docs.aws.amazon.com is blocked by this environment's network policy, so no primary check was possible.

**Status**
- **PRODUCTION IMPLEMENTED**: evaluation implemented, rule-specific tests, and every control reference verified against an official source.
- **IMPLEMENTED — LIVE/REFERENCE VERIFICATION REQUIRED**: implemented and tested, but the control reference could not be
  verified against primary documentation (all AWS FSBP references), or the rule has no rule-specific test.
- **PARTIAL**: topology heuristic; it can only see what is drawn.
- **NOT EVALUATED**: the evidence is not in the architecture model. See the REQUIRED EVIDENCE column and
  \`lib/engines/assessment/evidenceAvailability.ts\`. These rules are reported as coverage gaps and never count as passing.

No rule has LIVE_VERIFIED evidence in production: the live-evidence input exists and is tested, but nothing supplies it yet.

`;
const md = HEADER + `| RULE ID | PROVIDER | RESOURCE | FRAMEWORK | SOURCE | CONDITION | REQUIRED EVIDENCE | SEVERITY | RECOMMENDATION | AUTO-FIX | TESTS | REFERENCE VERIFICATION | STATUS |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
fs.writeFileSync(process.argv[2] ?? 'docs/security-assessment/RULE_MATRIX.md', md);
console.log(ALL_RULES.length, counts);
if (errors.length) { console.error('VALIDATION ERRORS:\n' + errors.join('\n')); process.exit(1); }
