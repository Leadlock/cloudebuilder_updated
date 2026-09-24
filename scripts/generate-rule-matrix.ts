/**
 * Regenerates docs/security-assessment/RULE_MATRIX.md from the rule registry.
 * Usage: npm run docs:rule-matrix
 */
import fs from 'fs';
import { getResourceDefinition } from '@/lib/resources';
import { ALL_RULES } from '@/lib/engines/assessment/rules';
import { REFERENCES } from '@/lib/engines/assessment/references';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { RULESET_VERSION } from '@/lib/engines/assessment/types';
import type { CanvasNode } from '@/types';

const tests = fs.readdirSync('__tests__').filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(`__tests__/${f}`, 'utf8')).join('\n');
const node = (t: string): CanvasNode => ({ id: `n-${t}`, type: 'cloudNode', resourceType: t, provider: t.startsWith('azure') ? 'azure' : 'aws', label: t, position: { x: 0, y: 0 }, config: { ...(getResourceDefinition(t)?.defaultConfig ?? {}) } } as CanvasNode);
const V: Record<string, string> = { VERIFIED_OFFICIAL_SOURCE: 'official', CROSS_CHECKED_SECONDARY: 'secondary cross-check', NOT_VERIFIED_IN_BUILD: 'not verified' };
const rows: string[] = [];
const counts: Record<string, number> = {};
for (const r of ALL_RULES) {
  const refs = r.references.map((k) => REFERENCES[k]).filter(Boolean);
  const ctrl = refs.filter((x) => x.key.startsWith('AWS-FSBP') || x.key.startsWith('MCSB') || x.key.startsWith('AZPOLICY'));
  const short = (x: typeof refs[number]) => x.key.startsWith('AWS-FSBP') ? `FSBP ${x.identifier}` : x.key.startsWith('MCSB') ? `MCSB ${x.identifier}` : `Azure Policy ${(x.identifier ?? '').slice(0, 8)}`;
  const framework = [...ctrl.map(short), `WA ${r.wellArchitected.pillar}`].join('; ');
  const verified = ctrl.length ? [...new Set(ctrl.map((x) => V[x.verification]))].join(' + ') : 'n/a (WA guidance only, not verified)';
  let evidence = '';
  let alwaysNE = false;
  if (r.scope === 'account') { evidence = 'Account/organization data (not available in the diagram)'; alwaysNE = true; }
  else if (r.scope === 'architecture') {
    const sample = r.provider === 'aws' ? ['aws_vpc', 'aws_subnet', 'aws_alb', 'aws_ec2', 'aws_rds'] : ['azure_resource_group', 'azure_vnet', 'azure_subnet', 'azure_vm', 'azure_sql', 'azure_app_service'];
    const out = runAssessment({ nodes: [...new Set([...sample, ...(r.resourceTypes ?? [])])].map(node), edges: [] }).evaluations.filter((e) => e.ruleId === r.id);
    alwaysNE = out.length > 0 && out.every((e) => e.status === 'NOT_EVALUATED');
    evidence = alwaysNE ? 'Not modelled in the diagram' : 'Topology (nodes, edges, containment)';
  } else {
    const fields = new Set<string>(); let ne = true; let any = false;
    for (const t of r.resourceTypes ?? []) {
      const nodes = t.startsWith('azure') ? [node('azure_resource_group'), node(t)] : [node(t)];
      for (const e of runAssessment({ nodes, edges: [] }).evaluations.filter((x) => x.ruleId === r.id)) {
        any = true; if (e.status !== 'NOT_EVALUATED') ne = false;
        for (const ev of e.evidence) fields.add(ev.field ? ev.field : ev.label);
      }
    }
    alwaysNE = any && ne;
    evidence = alwaysNE ? 'Not modelled in the diagram' : `Config: ${[...fields].slice(0, 4).join(', ')}`;
  }
  const af = r.autoFix ? (typeof r.autoFix.safety === 'function' ? 'SAFE / REVIEW (deployed)' : r.autoFix.safety.replace('SAFE_AUTOFIX', 'SAFE').replace('REVIEW_REQUIRED', 'REVIEW').replace('MANUAL_ONLY', 'MANUAL')) : "—";
  const explicit = new RegExp(`['"\`]${r.id}['"\`-]`).test(tests);
  const tested = explicit ? 'Yes' : 'Registry probe only';
  let status: string;
  if (alwaysNE) status = 'NOT EVALUATED';
  else if (r.scope === 'architecture') status = 'PARTIAL';
  else if (explicit && ctrl.some((x) => x.verification === 'VERIFIED_OFFICIAL_SOURCE')) status = 'PRODUCTION IMPLEMENTED';
  else status = 'IMPLEMENTED — LIVE VERIFICATION REQUIRED';
  counts[status] = (counts[status] ?? 0) + 1;
  rows.push(`| ${r.id} | ${r.provider.toUpperCase()} | ${r.service} | ${framework} | ${r.severity} | ${evidence} | ${af} | ${verified} | ${tested} | ${status} |`);
}
const HEADER = `# CloudCraft Assessment Rule Matrix

Generated from the rule registry (\`lib/engines/assessment/rules\`) for ruleset **${RULESET_VERSION}**. Each row is taken from the rule's
own metadata and from running the engine on the resource definition's default configuration.

**Columns**
- **FRAMEWORK**: control references attached to the rule. FSBP = AWS Security Hub Foundational Security Best Practices;
  MCSB = Microsoft cloud security benchmark; Azure Policy = built-in policy definition (first 8 characters of the GUID);
  WA = Well-Architected pillar mapping.
- **EVIDENCE**: what the rule reads. Config = configuration fields on the canvas resource; Topology = nodes, edges and
  containment; Not modelled = data the diagram cannot hold, so the rule always returns NOT_EVALUATED.
- **AUTOFIX**: SAFE = SAFE_AUTOFIX; REVIEW = REVIEW_REQUIRED; MANUAL = MANUAL_ONLY; SAFE / REVIEW (deployed) = SAFE on
  design-only resources, REVIEW_REQUIRED on imported or deployed resources; — = no configuration change can fix it.
- **SOURCE VERIFIED**: official = identifier and title checked against an official machine-readable publication (Azure
  Policy MCSB initiative v57.58.0). secondary cross-check = FSBP identifier, title and severity checked against a maintained
  machine-readable mapping, because docs.aws.amazon.com could not be reached from the build environment. not verified =
  WA guidance URL only.
- **TESTED**: Yes = rule-specific automated test (FAIL/PASS, Auto-Fix round trip, or both). Registry probe only = covered
  only by the generic registry tests (valid keys, references, SOC 1 areas).

**Status**
- PRODUCTION IMPLEMENTED: the design-time evaluation is complete, has rule-specific tests, and its control reference is
  verified against an official source.
- IMPLEMENTED — LIVE VERIFICATION REQUIRED: implemented and tested, but the control reference could only be cross-checked
  against a secondary source, or has no rule-specific test yet.
- PARTIAL: topology heuristic. It can only see what is drawn, e.g. it cannot tell whether monitoring exists outside the
  diagram.
- NOT EVALUATED: always returns NOT_EVALUATED because the data is not in the diagram. It is shown in reports as a
  coverage gap and never counted as passing.

No rule has been verified against a live AWS or Azure account, and no evaluation carries LIVE_VERIFIED provenance.

`;
const md = HEADER + `| RULE ID | PROVIDER | SERVICE | FRAMEWORK | SEVERITY | EVIDENCE | AUTOFIX | SOURCE VERIFIED | TESTED | STATUS |\n|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
fs.writeFileSync(process.argv[2] ?? 'docs/security-assessment/RULE_MATRIX.md', md);
console.log(ALL_RULES.length, counts, 'aws', ALL_RULES.filter((r) => r.provider === 'aws').length, 'azure', ALL_RULES.filter((r) => r.provider === 'azure').length,
  'autofix', ALL_RULES.reduce((a, r) => { const k = r.autoFix ? (typeof r.autoFix.safety === 'function' ? 'DYN' : r.autoFix.safety) : 'none'; a[k] = (a[k] ?? 0) + 1; return a; }, {} as Record<string, number>));
