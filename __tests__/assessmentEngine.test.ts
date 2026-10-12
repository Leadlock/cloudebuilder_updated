/**
 * Assessment engine, Auto-Fix, SOC 1 mapping, scoring, report and snapshot
 * integrity tests (lib/engines/assessment).
 */
jest.mock('@/src/prisma/db', () => ({ db: {}, rawTransaction: jest.fn() }));

import { getResourceDefinition } from '@/lib/resources';
import type { CanvasEdge, CanvasNode } from '@/types';
import { runAssessment, findingIdFor } from '@/lib/engines/assessment/AssessmentEngine';
import { ALL_RULES, RULES_BY_ID, resolveRuleId } from '@/lib/engines/assessment/rules';
import { REFERENCES } from '@/lib/engines/assessment/references';
import { scoreOf } from '@/lib/engines/assessment/scoring';
import { SOC1_AREAS, SOC1_DISCLAIMER } from '@/lib/engines/assessment/soc1';
import { EVIDENCE_AVAILABILITY } from '@/lib/engines/assessment/evidenceAvailability';
import { applyAutoFix, applySafeFixes, planAutoFix, safeFixCandidates, generateCanonicalTerraform } from '@/lib/engines/assessment/autofix';
import type { Evaluation, RuleDefinition } from '@/lib/engines/assessment/types';
import { buildReport } from '@/lib/engines/assessment/report/buildReport';
import { renderReportHtml } from '@/lib/services/report/renderReportHtml';
import { renderReportPdf } from '@/lib/services/report/renderReportPdf';
import { buildSnapshot, compareSnapshots, contentSha256, sanitizeNodes } from '@/lib/services/AssessmentSnapshotService';
import { toCanvas } from '@/lib/domain/canvasMapping';
import type { DbArchitecture } from '@/lib/repositories/architectureRepository';
import { ComplianceEngine } from '@/lib/engines/compliance/ComplianceEngine';
import { WellArchitectedRuleEngine } from '@/lib/engines/wellArchitected/WellArchitectedRuleEngine';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
function node(type: string, over: Record<string, unknown> = {}, extra: Partial<CanvasNode> = {}): CanvasNode {
  const def = getResourceDefinition(type)!;
  const id = extra.id ?? `node-internal-${type}-${++seq}`;
  return { id, type: 'cloudNode', resourceType: type, provider: def.provider, label: extra.label ?? `${def.label} ${seq}`, position: { x: seq * 10, y: 0 }, config: { ...def.defaultConfig, ...over }, ...extra, } as CanvasNode;
}
const edge = (a: CanvasNode, b: CanvasNode): CanvasEdge => ({ id: `e-${a.id}-${b.id}`, source: a.id, target: b.id });
const statusOf = (evals: Evaluation[], ruleId: string, resId?: string) =>
  evals.find((e) => e.ruleId === ruleId && (!resId || e.resourceIds[0] === resId))?.status;

function insecureAws() {
  const db = node('aws_rds', { publiclyAccessible: true, encrypted: false, multiAz: false, backupRetentionPeriod: 0 }, { label: 'production-db' });
  const s3 = node('aws_s3', { publicAccess: true, blockPublicAcls: false, blockPublicPolicy: false }, { label: 'public-assets' });
  const sg = node('aws_sg', { allowSsh: true, allowRdp: true, sourceCidr: '0.0.0.0/0' }, { label: 'web-sg' });
  const ec2 = node('aws_ec2', { associatePublicIpAddress: true, encrypted: false }, { label: 'web-1' });
  const internet = node('aws_internet', {}, { label: 'Internet' });
  return { nodes: [db, s3, sg, ec2, internet], edges: [edge(internet, db), edge(ec2, db)], db, s3, sg, ec2 };
}

function secureAws() {
  const sub1 = node('aws_subnet', { availabilityZone: 'us-east-1a' });
  const sub2 = node('aws_subnet', { availabilityZone: 'us-east-1b' });
  const db = node('aws_rds', { iamDatabaseAuthenticationEnabled: true, monitoringInterval: 60, enableCloudwatchLogsExports: ['postgresql'] });
  const alb = node('aws_alb', { certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/abc', deletionProtection: true });
  const waf = node('aws_waf');
  const asg = node('aws_auto_scaling', { healthCheckType: 'ELB' });
  const sg = node('aws_sg', { allowSsh: false, allowRdp: false });
  const alarm = node('aws_cloudwatch');
  const cache = node('aws_elasticache');
  return { nodes: [sub1, sub2, db, alb, waf, asg, sg, alarm, cache], edges: [edge(waf, alb), edge(alb, asg), edge(asg, db)] };
}

function insecureAzure() {
  const rg = node('azure_resource_group');
  const sql = node('azure_sql', { publicNetworkAccess: true, transparentDataEncryptionEnabled: false }, { label: 'ledger-sql' });
  const st = node('azure_storage', { httpsOnly: false, allowBlobPublicAccess: true, minimumTlsVersion: 'TLS1_0' }, { label: 'docs-storage' });
  const nsg = node('azure_nsg', { allowRdp: true, sourceCidr: '*' }, { label: 'app-nsg' });
  const kv = node('azure_key_vault', { purgeProtectionEnabled: false });
  return { nodes: [rg, sql, st, nsg, kv], edges: [], sql, st, nsg, kv };
}

// ─── Rule registry integrity ─────────────────────────────────────────────────

describe('Rule registry', () => {
  test('rule IDs are unique, provider-prefixed and every rule has provenance', () => {
    expect(new Set(ALL_RULES.map((r) => r.id)).size).toBe(ALL_RULES.length);
    for (const r of ALL_RULES) {
      expect(r.id.startsWith(r.provider === 'aws' ? 'AWS-' : 'AZ-')).toBe(true);
      expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(r.lastReviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.references.length).toBeGreaterThan(0);
      for (const key of r.references) expect(REFERENCES[key]).toBeDefined();
      for (const a of r.soc1) expect(SOC1_AREAS.some((s) => s.id === a)).toBe(true);
      expect(r.remediation.recommendation.length).toBeGreaterThan(10);
    }
  });

  test('AWS and Azure rule sets are provider-native (no shared rule objects, Azure never uses AWS pillars)', () => {
    const aws = ALL_RULES.filter((r) => r.provider === 'aws');
    const az = ALL_RULES.filter((r) => r.provider === 'azure');
    expect(aws.length).toBeGreaterThan(40);
    expect(az.length).toBeGreaterThan(35);
    for (const r of az) {
      expect(r.wellArchitected.pillar).not.toBe('sustainability');
      expect(r.references.some((k) => k.startsWith('AWS-'))).toBe(false);
      for (const t of r.resourceTypes ?? []) expect(t.startsWith('azure_')).toBe(true);
    }
    for (const r of aws) {
      expect(r.references.some((k) => k.startsWith('MCSB') || k.startsWith('AZ'))).toBe(false);
      for (const t of r.resourceTypes ?? []) expect(t.startsWith('aws_')).toBe(true);
    }
  });

  test('every rule reads configuration keys that exist in the resource definition', () => {
    // Catches the class of bug where a rule read a non-existent key and could never fire.
    const probe = (r: RuleDefinition) => {
      for (const t of r.resourceTypes ?? []) {
        const def = getResourceDefinition(t)!;
        const outcome = runAssessment({ nodes: [node(t)], edges: [] }).evaluations.find((e) => e.ruleId === r.id);
        if (!outcome) continue;
        for (const ev of outcome.evidence.filter((x) => x.field)) {
          expect(Object.keys(def.defaultConfig).concat(def.configSchema.map((c) => c.key))).toContain(ev.field);
        }
      }
    };
    ALL_RULES.filter((r) => r.scope === 'resource').forEach(probe);
  });

  test('Security Hub references carry the official control severity', () => {
    const fsbp = Object.values(REFERENCES).filter((r) => r.key.startsWith('AWS-FSBP-'));
    expect(fsbp.length).toBeGreaterThan(40);
    for (const r of fsbp) expect(['critical', 'high', 'medium', 'low']).toContain(r.officialSeverity);
  });

  test('legacy rule IDs resolve; rules removed as incorrect resolve to null', () => {
    expect(resolveRuleId('AWS-RDS-PUBLICLY-ACCESSIBLE')).toBe('AWS-RDS-001');
    expect(resolveRuleId('sql-tde-disabled')).toBe('AZ-SQL-002');
    expect(resolveRuleId('ec2-key-pair')).toBeNull();
    expect(resolveRuleId('waf-default-allow')).toBeNull();
  });
});

// ─── AWS ──────────────────────────────────────────────────────────────────────

describe('AWS assessment', () => {
  test('insecure architecture: correct rule, provider, resource, severity, evidence, recommendation and source', () => {
    const { nodes, edges, db, s3, sg } = insecureAws();
    const a = runAssessment({ nodes, edges });
    const pub = a.findings.find((f) => f.ruleId === 'AWS-RDS-001')!;
    expect(pub).toBeDefined();
    expect(pub.provider).toBe('aws');
    expect(pub.resourceIds).toEqual([db.id]);
    expect(pub.resourceLabels).toEqual(['production-db']);
    expect(pub.severity).toBe('CRITICAL');
    expect(pub.findingId).toBe(findingIdFor('AWS-RDS-001', db.id));
    expect(pub.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'publiclyAccessible', observed: 'Enabled / Yes', basis: 'CONFIGURATION' }),
      expect.objectContaining({ basis: 'RELATIONSHIP' }),
    ]));
    expect(pub.recommendation).toMatch(/private subnets/);
    expect(pub.references.map((r) => r.identifier)).toContain('RDS.2');
    expect(pub.soc1Areas).toContain('SOC1-LA-01');

    expect(a.findings.find((f) => f.ruleId === 'AWS-RDS-007')?.severity).toBe('HIGH'); // backups disabled
    expect(a.findings.find((f) => f.ruleId === 'AWS-S3-001' && f.resourceIds[0] === s3.id)?.severity).toBe('CRITICAL');
    expect(a.findings.filter((f) => f.resourceIds[0] === sg.id).map((f) => f.ruleId).sort()).toEqual(['AWS-SG-001', 'AWS-SG-002']);
    expect(a.findings.find((f) => f.ruleId === 'AWS-EC2-001')?.severity).toBe('MEDIUM');
    expect(a.securityScore.score).toBeLessThanOrEqual(40);
    expect(a.securityScore.capApplied).toBeUndefined(); // natural score already below the cap
  });

  test('secure architecture: no critical/high failures and passes recorded as evidence', () => {
    const { nodes, edges } = secureAws();
    const a = runAssessment({ nodes, edges });
    expect(a.findings.filter((f) => f.status === 'FAIL' && (f.severity === 'CRITICAL' || f.severity === 'HIGH'))).toEqual([]);
    expect(statusOf(a.evaluations, 'AWS-ELB-003')).toBe('PASS'); // WAF connected by relationship
    expect(statusOf(a.evaluations, 'AWS-ARCH-002')).toBe('PASS'); // two AZs
    expect(statusOf(a.evaluations, 'AWS-ASG-001')).toBe('PASS');
    expect(a.securityScore.score).toBeGreaterThanOrEqual(75);
  });

  test('partially known (imported) resources produce INSUFFICIENT_DATA — never PASS', () => {
    const imported: CanvasNode = { id: 'imp-1', type: 'cloudNode', resourceType: 'aws_rds', provider: 'aws', label: 'legacy-db', position: { x: 0, y: 0 }, config: { engine: 'mysql', imported: true }, importState: 'imported' };
    const a = runAssessment({ nodes: [imported], edges: [] });
    for (const id of ['AWS-RDS-001', 'AWS-RDS-002', 'AWS-RDS-006']) expect(statusOf(a.evaluations, id)).toBe('INSUFFICIENT_DATA');
    expect(a.findings).toEqual([]);
    // Imported before field-level provenance existed: values cannot be attributed to
    // discovery, so nothing is labelled as discovered.
    expect(a.analysisMode).toBe('DESIGN_TIME');
    expect(a.evaluations.find((e) => e.ruleId === 'AWS-RDS-001')?.provenance).toBe('DESIGN_TIME');
    expect(a.evaluations.some((e) => e.provenance === 'LIVE_VERIFIED')).toBe(false);
  });

  test('account-level controls are NOT_EVALUATED with a data requirement', () => {
    const a = runAssessment({ nodes: [node('aws_vpc')], edges: [] });
    const ct = a.evaluations.find((e) => e.ruleId === 'AWS-ACCT-001')!;
    expect(ct.status).toBe('NOT_EVALUATED');
    expect(ct.requiredData).toMatch(/AWS account/);
  });

  test('false-positive prevention', () => {
    const restricted = node('aws_sg', { allowSsh: true, sourceCidr: '10.0.0.0/8' });
    const webSg = node('aws_sg'); // default: HTTP/HTTPS from 0.0.0.0/0, egress 0.0.0.0/0 — not an admin-port finding
    const noKey = node('aws_ec2', { keyName: '' }); // no key pair is NOT a finding (old rule was wrong)
    const ddb = node('aws_dynamodb', { serverSideEncryption: false }); // DynamoDB is always encrypted at rest
    const internalAlb = node('aws_alb', { scheme: 'internal', listenerProtocol: 'HTTP' });
    const a = runAssessment({ nodes: [restricted, webSg, noKey, ddb, internalAlb], edges: [] });
    expect(a.findings.filter((f) => f.resourceIds[0] === restricted.id || f.resourceIds[0] === webSg.id)).toEqual([]);
    expect(a.findings.some((f) => f.resourceIds[0] === noKey.id && /key pair/i.test(f.title))).toBe(false);
    expect(statusOf(a.evaluations, 'AWS-DDB-001', ddb.id)).toBe('PASS');
    expect(statusOf(a.evaluations, 'AWS-ELB-002', internalAlb.id)).toBe('NOT_APPLICABLE');
  });

  test('no security groups modelled is NOT_EVALUATED (AWS attaches the default SG), not a failure', () => {
    const a = runAssessment({ nodes: [node('aws_ec2')], edges: [] });
    expect(statusOf(a.evaluations, 'AWS-SG-003')).toBe('NOT_EVALUATED');
  });
});

// ─── Azure ────────────────────────────────────────────────────────────────────

describe('Azure assessment', () => {
  test('insecure architecture: MCSB-mapped findings with correct keys and severities', () => {
    const { nodes, sql, st, nsg, kv } = insecureAzure();
    const a = runAssessment({ nodes, edges: [] });
    const byRule = (id: string, res: string) => a.findings.find((f) => f.ruleId === id && f.resourceIds[0] === res);
    expect(byRule('AZ-SQL-001', sql.id)?.severity).toBe('HIGH');
    expect(byRule('AZ-SQL-002', sql.id)?.references.map((r) => r.identifier)).toContain('DP-4');
    expect(byRule('AZ-STG-001', st.id)?.references.map((r) => r.identifier)).toEqual(expect.arrayContaining(['DP-3', '404c3081-a854-4457-ae30-26a93ef643f9']));
    expect(byRule('AZ-STG-003', st.id)).toBeDefined();
    expect(byRule('AZ-NSG-002', nsg.id)?.severity).toBe('HIGH');
    expect(byRule('AZ-KV-002', kv.id)?.autoFix.safety).toBe('REVIEW_REQUIRED'); // purge protection is irreversible
    expect(a.findings.every((f) => f.provider === 'azure')).toBe(true);
  });

  test('Azure pillar results use the five Azure pillars (no Sustainability)', () => {
    const a = runAssessment({ nodes: insecureAzure().nodes, edges: [] });
    const pillars = a.pillarResults.filter((p) => p.provider === 'azure').map((p) => p.pillar);
    expect(pillars).toHaveLength(5);
    expect(pillars).not.toContain('sustainability');
  });

  test('monitoring is NOT_EVALUATED rather than a false "no monitoring" failure', () => {
    const a = runAssessment({ nodes: [node('azure_vm'), node('azure_sql')], edges: [] });
    expect(statusOf(a.evaluations, 'AZ-ARCH-020')).toBe('NOT_EVALUATED');
  });

  test('load balancer presence is detected with real CloudCraft types (previous rule never matched)', () => {
    const vm = node('azure_vm');
    const withLb = runAssessment({ nodes: [vm, node('azure_lb')], edges: [] });
    const without = runAssessment({ nodes: [vm], edges: [] });
    expect(statusOf(withLb.evaluations, 'AZ-ARCH-010')).toBe('PASS');
    expect(statusOf(without.evaluations, 'AZ-ARCH-010')).toBe('FAIL');
  });

  test('SQL zone redundancy is NOT_APPLICABLE on DTU Basic/Standard tiers', () => {
    const a = runAssessment({ nodes: [node('azure_sql', { tier: 'Standard', zoneRedundant: false })], edges: [] });
    expect(statusOf(a.evaluations, 'AZ-SQL-010')).toBe('NOT_APPLICABLE');
  });

  test('NSG association: subnets without an NSG fail when no NSG exists', () => {
    const sub = node('azure_subnet');
    const a = runAssessment({ nodes: [sub], edges: [] });
    expect(statusOf(a.evaluations, 'AZ-ARCH-001')).toBe('FAIL');
    const nsg = node('azure_nsg', {}, { parentId: sub.id });
    expect(statusOf(runAssessment({ nodes: [sub, nsg], edges: [] }).evaluations, 'AZ-ARCH-001')).toBe('PASS');
  });
});

// ─── Multi-cloud ─────────────────────────────────────────────────────────────

describe('Multi-cloud assessment', () => {
  test('each provider is evaluated only by its own rules; pillars are kept separate', () => {
    const aws = insecureAws(); const az = insecureAzure();
    const a = runAssessment({ nodes: [...aws.nodes, ...az.nodes], edges: aws.edges });
    expect(a.providers).toEqual(['aws', 'azure']);
    for (const e of a.evaluations) {
      const rule = RULES_BY_ID.get(e.ruleId)!;
      for (const id of e.resourceIds) {
        const n = [...aws.nodes, ...az.nodes].find((x) => x.id === id)!;
        expect(n.provider).toBe(rule.provider);
      }
    }
    expect(a.pillarResults.filter((p) => p.provider === 'aws')).toHaveLength(6);
    expect(a.pillarResults.filter((p) => p.provider === 'azure')).toHaveLength(5);
  });

  test('Well-Architected adapter keeps AWS and Azure pillars separate and marks unscored pillars', () => {
    const wa = new WellArchitectedRuleEngine().analyze({ architectureId: 'a', nodes: [...insecureAws().nodes, ...insecureAzure().nodes], edges: [] });
    expect(wa.provider).toBe('multi');
    expect(wa.pillarScores.filter((p) => p.provider === 'aws')).toHaveLength(6);
    expect(wa.pillarScores.filter((p) => p.provider === 'azure')).toHaveLength(5);
    const unscored = wa.pillarScores.filter((p) => p.scored === false);
    for (const p of unscored) expect(['Insufficient evidence', 'Observations only', 'No issues observed']).toContain(p.status);
    // Performance Efficiency used to have one informational check, so it read "Observations only". It has real checks now, so a design that
    // breaks them is scored and reported as having issues.
    const perf = wa.pillarScores.find((p) => p.provider === 'aws' && p.pillar === 'performance_efficiency');
    expect(perf?.scored).toBe(true);
    expect(perf?.status).toBe('Issues found');
  });
});

// ─── Scoring ─────────────────────────────────────────────────────────────────

describe('Scoring and coverage', () => {
  const ev = (status: Evaluation['status'], severity: Evaluation['severity'] = 'MEDIUM'): Evaluation => ({
    findingId: `x-${Math.random()}`, ruleId: 'X', ruleVersion: '1', provider: 'aws', resourceIds: [], resourceLabels: [], status, severity, observation: '', evidence: [], provenance: 'DESIGN_TIME',
  });

  test('10 passed / 0 failed / 90 not evaluated is NOT "100% secure": coverage 10% and flagged', () => {
    const s = scoreOf([...Array(10)].map(() => ev('PASS')).concat([...Array(90)].map(() => ev('NOT_EVALUATED'))));
    expect(s.coverage.coveragePct).toBe(10);
    expect(s.lowCoverage).toBe(true);
    expect(s.score).toBe(100);
  });

  test('nothing evaluated → score is null ("Not scored"), never 100', () => {
    expect(scoreOf([ev('NOT_EVALUATED'), ev('INSUFFICIENT_DATA')]).score).toBeNull();
    expect(scoreOf([]).rating).toBe('Not scored');
  });

  test('critical failure caps score at 40; high failure caps at 70; warnings count half', () => {
    const passes = [...Array(50)].map(() => ev('PASS', 'HIGH'));
    expect(scoreOf([...passes, ev('FAIL', 'CRITICAL')]).score).toBe(40);
    expect(scoreOf([...passes, ev('FAIL', 'HIGH')]).score).toBe(70);
    expect(scoreOf([ev('PASS', 'MEDIUM'), ev('WARNING', 'MEDIUM')]).score).toBe(75);
  });

  test('accepted-risk findings still count as failing', () => {
    const { nodes, edges, db } = insecureAws();
    const base = runAssessment({ nodes, edges });
    const fid = findingIdFor('AWS-RDS-001', db.id);
    const reviewed = runAssessment({ nodes, edges, reviews: [{ findingId: fid, status: 'ACCEPTED_RISK', reason: 'Temporary vendor access', approvedBy: 'admin@example.com', approvedAt: '2026-09-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }] });
    const f = reviewed.findings.find((x) => x.findingId === fid)!;
    expect(f.status).toBe('FAIL');
    expect(f.reviewStatus).toBe('ACCEPTED_RISK');
    expect(reviewed.securityScore.score).toBe(base.securityScore.score);
  });

  test('expired reviews no longer apply', () => {
    const { nodes, edges, db } = insecureAws();
    const fid = findingIdFor('AWS-RDS-001', db.id);
    const a = runAssessment({ nodes, edges, evaluatedAt: '2026-09-24T00:00:00Z', reviews: [{ findingId: fid, status: 'ACCEPTED_RISK', reason: 'expired decision', approvedBy: 'a', approvedAt: '2025-01-01T00:00:00Z', expiresAt: '2025-06-01T00:00:00Z' }] });
    expect(a.findings.find((x) => x.findingId === fid)?.reviewStatus).toBe('OPEN');
  });
});

// ─── SOC 1 ───────────────────────────────────────────────────────────────────

describe('SOC 1 readiness analysis', () => {
  test('disclaimer states it is not an attestation; no certification/compliance claims anywhere', () => {
    expect(SOC1_DISCLAIMER).toMatch(/NOT a SOC 1® examination/);
    expect(SOC1_DISCLAIMER).toMatch(/not an independent service auditor/);
    const a = runAssessment({ nodes: insecureAws().nodes, edges: [] });
    const text = JSON.stringify(a.soc1);
    expect(text).not.toMatch(/SOC 1 (Certified|Compliant)|audit passed/i);
  });

  test('every area requires organizational evidence and auditor assessment', () => {
    const a = runAssessment({ nodes: insecureAws().nodes, edges: [] });
    expect(a.soc1).toHaveLength(SOC1_AREAS.length);
    for (const area of a.soc1) {
      expect(area.evidenceTypes).toEqual(expect.arrayContaining(['REQUIRES_ORGANIZATIONAL_EVIDENCE', 'REQUIRES_AUDITOR_ASSESSMENT']));
      expect(area.organizationalEvidenceRequired.length).toBeGreaterThan(0);
    }
  });

  test('architecture configuration alone never concludes on a control (even when every technical check passes)', () => {
    // A hardened RDS design: every RDS check that maps to SOC 1 passes at design time.
    const db = node('aws_rds', { publiclyAccessible: false, encrypted: true, kmsKeyId: 'arn:aws:kms:us-east-1:111122223333:key/k', iamDatabaseAuthenticationEnabled: true, enableCloudwatchLogsExports: ['postgresql'], multiAz: true, backupRetentionPeriod: 14, deletionProtection: true, monitoringInterval: 60, autoMinorVersionUpgrade: true });
    const a = runAssessment({ nodes: [db], edges: [] });
    const dp = a.soc1.find((s) => s.id === 'SOC1-DP-01')!;
    expect(dp.architectureEvidence.length).toBeGreaterThan(0);
    expect(dp.discoveredEvidence).toEqual([]);
    expect(dp.userProvidedEvidence).toEqual([]);
    for (const area of a.soc1) {
      expect(area.conclusion).toBe('NOT_CONCLUDED');
      expect(area.auditorAssessmentRequired).toMatch(/independent service auditor/);
      expect(area.status).not.toMatch(/pass|compliant|effective|satisf/i);
      expect(area.evidenceTypes).toEqual(expect.arrayContaining(['REQUIRES_ORGANIZATIONAL_EVIDENCE', 'REQUIRES_AUDITOR_ASSESSMENT']));
    }
    expect(dp.conclusionReason).toMatch(/designed architecture only/);
  });

  test('discovered configuration is reported separately from architecture evidence', () => {
    const values = { publiclyAccessible: false, encrypted: true, kmsKeyId: 'k', multiAz: true, backupRetentionPeriod: 7, deletionProtection: true };
    const db: CanvasNode = { id: 'db-disc', type: 'cloudNode', resourceType: 'aws_rds', provider: 'aws', label: 'discovered-db', position: { x: 0, y: 0 }, importState: 'imported',
      config: { ...values, _discovery: { source: 'aws-api', discoveredAt: '2026-09-24T00:00:00Z', values } } } as CanvasNode;
    const a = runAssessment({ nodes: [db], edges: [] });
    const dp = a.soc1.find((s) => s.id === 'SOC1-DP-01')!;
    expect(dp.discoveredEvidence.length).toBeGreaterThan(0);
    expect(dp.architectureEvidence).toEqual([]);
    expect(dp.evidenceTypes).toContain('DISCOVERED_CLOUD_EVIDENCE');
    expect(dp.evidenceTypes).not.toContain('LIVE_VERIFIED_EVIDENCE');
    expect(dp.conclusion).toBe('NOT_CONCLUDED');
  });

  test('gaps are derived from technical failures; unknown areas are "Not evaluated"', () => {
    const a = runAssessment({ nodes: insecureAws().nodes, edges: [] });
    expect(a.soc1.find((s) => s.id === 'SOC1-LA-01')?.status).toBe('Gaps identified');
    const empty = runAssessment({ nodes: [node('aws_route53')], edges: [] });
    expect(empty.soc1.find((s) => s.id === 'SOC1-DP-02')?.status).toBe('Not evaluated');
  });
});

// ─── Auto-Fix ────────────────────────────────────────────────────────────────

const FAILING: Record<string, [string, Record<string, unknown>]> = {
  'AWS-S3-001': ['aws_s3', { publicAccess: true, blockPublicAcls: false, blockPublicPolicy: false }], 'AWS-S3-002': ['aws_s3', { encryption: false }],
  'AWS-S3-004': ['aws_s3', { objectOwnership: 'ObjectWriter' }], 'AWS-S3-005': ['aws_s3', { versioning: false }],
  'AWS-RDS-001': ['aws_rds', { publiclyAccessible: true }], 'AWS-RDS-002': ['aws_rds', { encrypted: false }], 'AWS-RDS-003': ['aws_rds', {}],
  'AWS-RDS-005': ['aws_rds', { autoMinorVersionUpgrade: false }], 'AWS-RDS-006': ['aws_rds', { multiAz: false }], 'AWS-RDS-007': ['aws_rds', { backupRetentionPeriod: 0 }],
  'AWS-RDS-008': ['aws_rds', { deletionProtection: false }], 'AWS-RDS-009': ['aws_rds', {}],
  'AWS-EC2-001': ['aws_ec2', { associatePublicIpAddress: true }], 'AWS-EC2-002': ['aws_ec2', { encrypted: false }], 'AWS-EBS-001': ['aws_ebs', { encrypted: false }],
  'AWS-VPC-001': ['aws_subnet', { mapPublicIpOnLaunch: true }], 'AWS-VPC-003': ['aws_vpc', { enableDnsSupport: false }],
  'AWS-SG-001': ['aws_sg', { allowSsh: true, sourceCidr: '0.0.0.0/0' }], 'AWS-SG-002': ['aws_sg', { allowRdp: true, sourceCidr: '0.0.0.0/0' }],
  'AWS-NACL-001': ['aws_nacl', { allowAllInbound: true, inboundCidr: '0.0.0.0/0' }], 'AWS-ELB-004': ['aws_alb', { deletionProtection: false }],
  'AWS-CF-001': ['aws_cloudfront', { viewerProtocolPolicy: 'allow-all' }], 'AWS-WAF-001': ['aws_waf', { managedRuleGroups: [], rateLimitEnabled: false }],
  'AWS-EKS-002': ['aws_eks', { secretsEncryption: false }], 'AWS-EKS-003': ['aws_eks', { clusterLogTypes: ['api'] }], 'AWS-ECS-001': ['aws_ecs', { assignPublicIp: true }],
  'AWS-KMS-001': ['aws_kms', { enableKeyRotation: false }], 'AWS-ELC-001': ['aws_elasticache', { transitEncryption: false }], 'AWS-ELC-002': ['aws_elasticache', { atRestEncryption: false }],
  'AWS-ELC-003': ['aws_elasticache', { automaticFailoverEnabled: false }], 'AWS-ELC-004': ['aws_elasticache', { snapshotRetentionLimit: 0 }],
  'AWS-DDB-002': ['aws_dynamodb', { pointInTimeRecovery: false }], 'AWS-DDB-003': ['aws_dynamodb', { deletionProtection: false }], 'AWS-SQS-001': ['aws_sqs', { encryption: false }],
  'AWS-EC2-003': ['aws_ec2', { metadataHttpTokens: 'optional' }],
  'AWS-EC2-010': ['aws_ec2', { detailedMonitoring: false }], 'AWS-LAMBDA-001': ['aws_lambda', { tracingMode: 'PassThrough' }],
  'AWS-COST-001': ['aws_ebs', { volumeType: 'gp2' }], 'AWS-SUS-001': ['aws_lambda', { architecture: 'x86_64' }],
  'AZ-STG-001': ['azure_storage', { httpsOnly: false }], 'AZ-STG-002': ['azure_storage', { allowBlobPublicAccess: true }], 'AZ-STG-003': ['azure_storage', { minimumTlsVersion: 'TLS1_0' }],
  'AZ-STG-004': ['azure_storage', { networkDefaultAction: 'Allow' }], 'AZ-STG-005': ['azure_storage', { blobSoftDeleteRetentionDays: 0 }], 'AZ-STG-006': ['azure_storage', { sku: 'Standard_LRS' }],
  'AZ-SQL-001': ['azure_sql', { publicNetworkAccess: true }], 'AZ-SQL-002': ['azure_sql', { transparentDataEncryptionEnabled: false }], 'AZ-SQL-004': ['azure_sql', { threatDetectionEnabled: false }],
  'AZ-SQL-005': ['azure_sql', { minimumTlsVersion: '1.0' }], 'AZ-SQL-006': ['azure_sql', { publicNetworkAccess: true, allowAzureServices: true }],
  'AZ-PG-002': ['azure_postgres', { requireSecureTransport: false }], 'AZ-PG-010': ['azure_postgres', { skuName: 'GP_Standard_D2ds_v5', highAvailability: 'Disabled' }], 'AZ-PG-011': ['azure_postgres', { geoRedundantBackup: false }],
  'AZ-MY-002': ['azure_mysql', { requireSecureTransport: false }], 'AZ-MY-010': ['azure_mysql', { skuName: 'GP_Standard_D2ds_v4', highAvailability: 'Disabled' }], 'AZ-MY-011': ['azure_mysql', { geoRedundantBackup: false }],
  'AZ-SB-002': ['azure_service_bus', { localAuthEnabled: true }], 'AZ-SB-003': ['azure_service_bus', { minimumTlsVersion: '1.0' }], 'AZ-SB-010': ['azure_service_bus', { sku: 'Premium', zoneRedundant: false }],
  'AZ-ACR-001': ['azure_acr', { adminEnabled: true }], 'AZ-ACR-010': ['azure_acr', { sku: 'Premium', zoneRedundant: false }],
  'AZ-SQL-010': ['azure_sql', { tier: 'GeneralPurpose', zoneRedundant: false }], 'AZ-SQL-011': ['azure_sql', { requestedBackupStorageRedundancy: 'Local' }],
  'AZ-COS-001': ['azure_cosmos_db', { publicNetworkAccess: true }], 'AZ-COS-010': ['azure_cosmos_db', { enableAutomaticFailover: false }],
  'AZ-RED-001': ['azure_redis', { enableNonSslPort: true }], 'AZ-RED-003': ['azure_redis', { minimumTlsVersion: '1.0' }],
  'AZ-KV-001': ['azure_key_vault', { publicNetworkAccessEnabled: true, networkAclsDefaultAction: 'Allow' }], 'AZ-KV-002': ['azure_key_vault', { purgeProtectionEnabled: false }],
  'AZ-KV-003': ['azure_key_vault', { enableRbacAuthorization: false }], 'AZ-NSG-001': ['azure_nsg', { allowSsh: true, sourceCidr: '*' }], 'AZ-NSG-002': ['azure_nsg', { allowRdp: true, sourceCidr: '*' }],
  'AZ-NIC-001': ['azure_nic', { enableIpForwarding: true }], 'AZ-VM-001': ['azure_vm', { publicIpEnabled: true }], 'AZ-VM-002': ['azure_vm', { encryptionAtHostEnabled: false }],
  'AZ-VMSS-001': ['azure_vmss', { osDiskEncryption: false }], 'AZ-VM-020': ['azure_vm', { bootDiagnosticsEnabled: false }],
  'AZ-APP-001': ['azure_app_service', { httpsOnly: false }], 'AZ-FUNC-001': ['azure_functions', { httpsOnly: false }], 'AZ-APP-002': ['azure_app_service', { minimumTlsVersion: '1.0' }],
  'AZ-FUNC-002': ['azure_functions', { minimumTlsVersion: '1.0' }], 'AZ-APP-003': ['azure_app_service', { ftpsState: 'AllAllowed' }], 'AZ-AKS-001': ['azure_aks', { rbacEnabled: false }],
  'AZ-AKS-010': ['azure_aks', { skuTier: 'Free' }], 'AZ-AKS-030': ['azure_aks', { enableAutoScaling: false }], 'AZ-AGW-001': ['azure_app_gateway', { sku: 'Standard_v2' }],
  'AZ-AFD-001': ['azure_front_door', { httpsOnly: false }], 'AZ-WAF-001': ['azure_waf', { mode: 'Detection' }], 'AZ-BAS-001': ['azure_bastion', { shareableLinkEnabled: true }],
};

/** Simulates the persistence round trip (canvas → ArchitectureResource rows → canvas). */
function persistRoundTrip(nodes: CanvasNode[], edges: CanvasEdge[]) {
  return toCanvas(
    nodes.map((n) => ({ id: n.id, resourceType: n.resourceType, provider: n.provider, label: n.label, positionX: n.position.x, positionY: n.position.y, configJson: JSON.stringify(n.config), region: null, groupId: n.groupId ?? null, locked: false, architectureId: 'a' })),
    edges.map((e) => ({ id: e.id, sourceId: e.source, targetId: e.target, label: null, edgeType: null, architectureId: 'a' })),
  );
}

describe('Auto-Fix', () => {
  const fixable = ALL_RULES.filter((r) => r.autoFix && (typeof r.autoFix.safety === 'function' || r.autoFix.safety !== 'MANUAL_ONLY') && r.scope === 'resource' && r.id !== 'AWS-ASG-001');

  test.each(fixable.map((r) => [r.id]))('%s: finding exists → fix → graph changed → finding gone → Terraform reflects → persists → idempotent', (ruleId) => {
    const [type, cfg] = FAILING[ruleId];
    const rg = type.startsWith('azure') ? [node('azure_resource_group')] : [];
    const target = node(type, cfg, { id: `target-${ruleId}` });
    const nodes = [...rg, target];
    const fid = findingIdFor(ruleId, target.id);

    // BEFORE
    expect(runAssessment({ nodes, edges: [] }).findings.some((f) => f.findingId === fid)).toBe(true);
    const tfBefore = generateCanonicalTerraform(nodes, []);

    // APPLY
    const r = applyAutoFix(nodes, [], fid, { confirmed: true });
    expect(r.status).toBe('RESOLVED');
    expect(r.after?.status === 'PASS' || r.after?.status === 'NOT_APPLICABLE').toBe(true);

    // AFTER: canonical graph changed only on the target resource
    const changed = r.nodes.find((n) => n.id === target.id)!;
    expect(changed.config).not.toEqual(target.config);
    for (const n of r.nodes.filter((x) => x.id !== target.id)) expect(n).toEqual(nodes.find((x) => x.id === n.id));
    // Terraform reflects the change
    const tfAfter = generateCanonicalTerraform(r.nodes, []);
    expect(tfAfter).not.toEqual(tfBefore);
    const expectRe = RULES_BY_ID.get(ruleId)!.autoFix!.terraformExpect;
    if (expectRe) expect(expectRe.test(tfAfter)).toBe(true);
    // Persistence preserves the change
    const persisted = persistRoundTrip(r.nodes, []);
    expect(runAssessment(persisted).findings.some((f) => f.findingId === fid)).toBe(false);
    // Idempotent
    const again = applyAutoFix(r.nodes, [], fid, { confirmed: true });
    expect(again.status).toBe('ALREADY_RESOLVED');
    expect(again.nodes).toBe(r.nodes);
  });

  test('every Auto-Fix-capable rule has a failing fixture (no untested fix)', () => {
    for (const r of fixable) expect(FAILING[r.id]).toBeDefined();
  });

  test('AWS-ASG-001 (relationship-based) resolves when the group is connected to a load balancer', () => {
    const asg = node('aws_auto_scaling', { healthCheckType: 'EC2' });
    const alb = node('aws_alb');
    const edges = [edge(alb, asg)];
    const fid = findingIdFor('AWS-ASG-001', asg.id);
    const r = applyAutoFix([asg, alb], edges, fid);
    expect(r.status).toBe('RESOLVED');
    expect(generateCanonicalTerraform(r.nodes, edges)).toMatch(/health_check_type\s*=\s*"ELB"/);
  });

  test('REVIEW_REQUIRED fixes are rejected without confirmation; MANUAL_ONLY is never applied', () => {
    const db = node('aws_rds', { publiclyAccessible: true });
    const fid = findingIdFor('AWS-RDS-001', db.id);
    const r = applyAutoFix([db], [], fid);
    expect(r.status).toBe('REJECTED');
    expect(r.nodes).toEqual([db]);
    const s3 = node('aws_s3', { loggingEnabled: false });
    const m = applyAutoFix([s3], [], findingIdFor('AWS-S3-003', s3.id), { confirmed: true });
    expect(m.status).toBe('REJECTED');
  });

  test('encryption fix safety depends on deployment state (deployed resource → review required)', () => {
    const planned = node('aws_rds', { encrypted: false });
    const deployed = node('aws_rds', { encrypted: false }, { importState: 'cloudcraft-managed' });
    const a = runAssessment({ nodes: [planned, deployed], edges: [] });
    expect(a.findings.find((f) => f.findingId === findingIdFor('AWS-RDS-002', planned.id))?.autoFix.safety).toBe('SAFE_AUTOFIX');
    expect(a.findings.find((f) => f.findingId === findingIdFor('AWS-RDS-002', deployed.id))?.autoFix.safety).toBe('REVIEW_REQUIRED');
  });

  test('failed verification rolls back (a patch that does not fix the finding)', () => {
    const rule = RULES_BY_ID.get('AWS-SQS-001')!;
    const original = rule.autoFix!.patch;
    rule.autoFix!.patch = () => ({ visibilityTimeoutSeconds: 31 }); // does not address encryption
    try {
      const q = node('aws_sqs', { encryption: false });
      const r = applyAutoFix([q], [], findingIdFor('AWS-SQS-001', q.id));
      expect(r.status).toBe('AUTO_FIX_FAILED');
      expect(r.reason).toMatch(/still evaluates to FAIL/);
      expect(r.nodes).toEqual([q]);
    } finally { rule.autoFix!.patch = original; }
  });

  test('preview contains current/proposed values, cost and Terraform diff', () => {
    const db = node('aws_rds', { multiAz: false });
    const p = planAutoFix([db], [], findingIdFor('AWS-RDS-006', db.id));
    if ('error' in p) throw new Error(p.error);
    expect(p.changes).toEqual([expect.objectContaining({ field: 'multiAz', current: 'Disabled / No', proposed: 'Enabled / Yes' })]);
    expect(p.cost.impact).toBe('POSSIBLE_INCREASE');
    expect(p.terraform.added.some((l) => /multi_az\s*=\s*true/.test(l))).toBe(true);
    expect(p.terraform.expectationMet).toBe(true);
  });

  test('Fix all safe issues only applies SAFE_AUTOFIX findings', () => {
    const { nodes, edges } = insecureAws();
    const before = runAssessment({ nodes, edges });
    const safe = safeFixCandidates(before.findings);
    expect(safe.every((f) => f.autoFix.safety === 'SAFE_AUTOFIX')).toBe(true);
    const bulk = applySafeFixes(nodes, edges);
    expect(bulk.results.every((r) => r.plan?.safety === 'SAFE_AUTOFIX')).toBe(true);
    const after = runAssessment({ nodes: bulk.nodes, edges });
    // Review-required findings are untouched
    for (const id of ['AWS-RDS-001', 'AWS-S3-001', 'AWS-SG-001']) expect(after.findings.some((f) => f.ruleId === id)).toBe(true);
    expect(after.findings.length).toBeLessThan(before.findings.length);
  });
});

// ─── Reports & snapshots ──────────────────────────────────────────────────────

function dbArch(nodes: CanvasNode[], edges: CanvasEdge[], revision = 3): DbArchitecture {
  return {
    id: 'arch-1', environmentId: 'env-1', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', revision,
    resources: nodes.map((n) => ({ id: n.id, resourceType: n.resourceType, provider: n.provider, label: n.label, positionX: n.position.x, positionY: n.position.y, configJson: JSON.stringify(n.config), region: null, groupId: n.groupId ?? null, locked: false, architectureId: 'arch-1' })),
    connections: edges.map((e) => ({ id: e.id, sourceId: e.source, targetId: e.target, label: null, edgeType: null, architectureId: 'arch-1' })),
  };
}

describe('Assessment snapshots and reports', () => {
  const scenarios: Array<[string, () => { nodes: CanvasNode[]; edges: CanvasEdge[] }]> = [
    ['AWS', () => insecureAws()],
    ['Azure', () => insecureAzure()],
    ['Multi-cloud', () => { const a = insecureAws(); const z = insecureAzure(); return { nodes: [...a.nodes, ...z.nodes], edges: a.edges }; }],
  ];

  test.each(scenarios)('%s report: all sections present, counts correct, no undefined/NaN, no internal IDs, disclaimer, revision', async (_name, make) => {
    const { nodes, edges } = make();
    const snap = buildSnapshot({ scanId: '00000000-1111-4222-8333-444444444444', project: { id: 'p1', name: 'QA Project', environment: 'production', region: 'us-east-1' }, arch: dbArch(nodes, edges, 7), createdBy: 'qa', reviews: [], now: '2026-09-24T10:00:00.000Z' });
    const report = buildReport(snap, { generatedAt: '2026-09-24T10:05:00.000Z' });

    // counts
    const sev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFORMATIONAL: 0 } as Record<string, number>;
    for (const f of snap.assessment.findings) sev[f.severity]++;
    expect(report.executive.counts).toEqual(sev);
    expect(report.security.findings.every((f) => f.domain === 'SECURITY')).toBe(true);
    expect(report.mapping).toHaveLength(snap.assessment.findings.length);
    expect(report.meta.architectureRevision).toBe(7);
    expect(report.meta.rulesetVersion).toBe(snap.assessment.rulesetVersion);
    expect(report.soc1.disclaimer).toMatch(/NOT a SOC 1/);
    expect(report.appendix.references.length).toBeGreaterThan(3);
    expect(report.inventory.length).toBeGreaterThan(0);

    const html = renderReportHtml(report);
    for (const h of ['Document Control', 'Executive Summary', 'Architecture Overview', 'Assessment Scope', 'Well-Architected Review', 'Security Assessment',
      'SOC 1 Readiness Analysis', 'Best-Practice Recommendations', 'Remediation Plan', 'Auto-Fix Summary', 'Resource Security Inventory',
      'Framework / Control Mapping', 'Appendix A', 'Appendix B', 'Appendix C', 'Appendix D', 'Appendix E']) {
      expect(html).toContain(h);
    }
    expect(html).not.toMatch(/\bundefined\b|\bNaN\b|\[object Object\]/);
    expect(html).not.toMatch(/node-internal-/); // internal node IDs never leak
    expect(html).not.toMatch(/SOC 1 (Certified|Compliant)/i);
    expect(html).toContain('Revision 7');

    const pdf = await renderReportPdf(report);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(20_000);
  }, 30_000);

  test('snapshot integrity: content hash is stable, changes with the architecture, and old snapshots do not change', () => {
    const { nodes, edges } = insecureAws();
    const s1 = buildSnapshot({ project: { id: 'p', name: 'P', environment: 'production' }, arch: dbArch(nodes, edges, 1), createdBy: 'u', reviews: [], now: '2026-09-24T00:00:00Z' });
    const s1b = buildSnapshot({ project: { id: 'p', name: 'P', environment: 'production' }, arch: dbArch(nodes, edges, 1), createdBy: 'u', reviews: [], now: '2026-09-24T00:00:00Z' });
    expect(s1.architecture.contentSha256).toBe(s1b.architecture.contentSha256);
    expect(s1.architecture.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    const frozen = JSON.stringify(s1);

    const fixed = applySafeFixes(nodes, edges).nodes;
    const s2 = buildSnapshot({ project: { id: 'p', name: 'P', environment: 'production' }, arch: dbArch(fixed, edges, 2), createdBy: 'u', reviews: [], now: '2026-09-25T00:00:00Z' });
    expect(s2.architecture.contentSha256).not.toBe(s1.architecture.contentSha256);
    expect(JSON.stringify(s1)).toBe(frozen); // the earlier snapshot is untouched

    const cmp = compareSnapshots(s1, s2);
    expect(cmp.resolvedFindings.length).toBeGreaterThan(0);
    expect(cmp.newFindings).toEqual([]);
    expect(cmp.regressions).toEqual([]);
  });

  test('regressions are detected when a previously passing check fails', () => {
    const db = node('aws_rds');
    const s1 = buildSnapshot({ project: { id: 'p', name: 'P', environment: 'production' }, arch: dbArch([db], [], 1), createdBy: 'u', reviews: [] });
    const broken = { ...db, config: { ...db.config, publiclyAccessible: true } };
    const s2 = buildSnapshot({ project: { id: 'p', name: 'P', environment: 'production' }, arch: dbArch([broken], [], 2), createdBy: 'u', reviews: [] });
    expect(compareSnapshots(s1, s2).regressions.map((f) => f.ruleId)).toContain('AWS-RDS-001');
  });

  test('secrets are redacted from snapshots and reports', () => {
    const fn = node('azure_functions', { appSettings: { DB_PASSWORD: 'hunter2' } });
    const lam = node('aws_lambda', { environmentVariables: { API_TOKEN: 'secret-token-value' } });
    const ec2 = node('aws_ec2', { userData: '#!/bin/bash\nexport PASSWORD=supersecret' });
    const safe = sanitizeNodes([fn, lam, ec2]);
    const text = JSON.stringify(safe);
    expect(text).not.toMatch(/hunter2|secret-token-value|supersecret/);
    expect(safe[0].config.appSettings).toBe('[redacted]');
    expect(contentSha256(safe, [])).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── Compliance mapping (technical indicators) ───────────────────────────────

describe('Framework control mapping (SOC 2 / HIPAA / PCI DSS technical indicators)', () => {
  test('default web security group egress (0.0.0.0/0) no longer fails boundary controls', () => {
    const r = ComplianceEngine.evaluate([node('aws_sg')], [], ['SOC2']);
    expect(r.results.find((x) => x.controlId === 'CC6.6')?.status).not.toBe('fail');
  });

  test('controls that cannot be observed are not_evaluated, and results carry a non-compliance disclaimer', () => {
    const r = ComplianceEngine.evaluate([node('aws_vpc')], [], ['PCI-DSS']);
    expect(r.results.find((x) => x.controlId === '8.4.2')?.status).toBe('not_evaluated');
    expect(r.disclaimer).toMatch(/does not determine SOC 2, HIPAA or PCI DSS compliance/);
  });

  test('failing technical indicators cite finding IDs as evidence', () => {
    const { nodes, edges } = insecureAws();
    const r = ComplianceEngine.evaluate(nodes, edges, ['HIPAA']);
    const ac = r.results.find((x) => x.controlId === '164.312(a)(1)')!;
    expect(ac.status).toBe('fail');
    expect(ac.evidence.some((e) => e.startsWith('AWS-RDS-001-'))).toBe(true);
  });
});

// ─── Rule-specific FAIL / PASS evidence for rules without an Auto-Fix fixture ─

describe('Rule-specific evaluation (non-auto-fixable rules)', () => {
  // [ruleId, resourceType, failing config, expected failing status, passing config]
  const CASES: Array<[string, string, Record<string, unknown>, 'FAIL' | 'WARNING', Record<string, unknown>]> = [
    ['AWS-S3-006', 'aws_s3', { lifecycleTransitionDays: 0, lifecycleExpirationDays: 0 }, 'WARNING', { lifecycleTransitionDays: 30 }],
    ['AWS-RDS-004', 'aws_rds', { enableCloudwatchLogsExports: [] }, 'FAIL', { enableCloudwatchLogsExports: ['postgresql'] }],
    ['AWS-EBS-002', 'aws_ebs', { snapshotSchedule: 'none' }, 'FAIL', { snapshotSchedule: 'daily' }],
    ['AWS-ELB-001', 'aws_alb', { listenerProtocol: 'HTTPS', certificateArn: '' }, 'FAIL', { listenerProtocol: 'HTTPS', certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/abc' }],
    ['AWS-CF-002', 'aws_cloudfront', { webAclId: '' }, 'FAIL', { webAclId: 'arn:aws:wafv2:us-east-1:111122223333:global/webacl/x/1' }],
    ['AWS-EKS-001', 'aws_eks', { endpointPublicAccess: true, publicAccessCidrs: '0.0.0.0/0' }, 'FAIL', { endpointPublicAccess: false }],
    ['AWS-IAM-001', 'aws_iam', { managedPolicyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'] }, 'FAIL', { managedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] }],
    ['AWS-SQS-002', 'aws_sqs', { deadLetterTargetArn: '' }, 'FAIL', { deadLetterTargetArn: 'arn:aws:sqs:us-east-1:111122223333:dlq' }],
    ['AZ-SQL-003', 'azure_sql', { auditingEnabled: false }, 'FAIL', { auditingEnabled: true }],
    ['AZ-RED-002', 'azure_redis', { publicNetworkAccessEnabled: true }, 'FAIL', { publicNetworkAccessEnabled: false }],
    ['AZ-VM-011', 'azure_vm', { availabilityZone: '' }, 'WARNING', { availabilityZone: '1' }],
    ['AZ-APP-010', 'azure_app_service', { healthCheckPath: '' }, 'WARNING', { healthCheckPath: '/health' }],
    ['AZ-AKS-002', 'azure_aks', { privateClusterEnabled: false }, 'FAIL', { privateClusterEnabled: true }],
  ];

  test.each(CASES)('%s on %s: insecure config → finding with evidence; compliant config → PASS', (ruleId, type, bad, badStatus, good) => {
    const rg = type.startsWith('azure') ? [node('azure_resource_group')] : [];
    const failing = node(type, bad);
    const evalBad = runAssessment({ nodes: [...rg, failing], edges: [] }).evaluations.find((e) => e.ruleId === ruleId && e.resourceIds[0] === failing.id)!;
    expect(evalBad.status).toBe(badStatus);
    expect(evalBad.evidence.length).toBeGreaterThan(0);
    const passing = node(type, good);
    expect(statusOf(runAssessment({ nodes: [...rg, passing], edges: [] }).evaluations, ruleId, passing.id)).toBe('PASS');
  });

  test('AWS-EKS-001: a public endpoint restricted to admin CIDRs is still reported, at LOW severity', () => {
    const eks = node('aws_eks', { endpointPublicAccess: true, publicAccessCidrs: '203.0.113.0/24' });
    const f = runAssessment({ nodes: [eks], edges: [] }).findings.find((x) => x.ruleId === 'AWS-EKS-001')!;
    expect(f.severity).toBe('LOW');
  });

  test('AWS-ELB-001 is NOT_APPLICABLE for plain HTTP listeners (no fabricated certificate finding)', () => {
    const alb = node('aws_alb', { listenerProtocol: 'HTTP', certificateArn: '' });
    expect(statusOf(runAssessment({ nodes: [alb], edges: [] }).evaluations, 'AWS-ELB-001', alb.id)).toBe('NOT_APPLICABLE');
  });

  test('AZ-AFD-002 / AWS-CF-002 accept a WAF connected in the diagram as evidence', () => {
    const rg = node('azure_resource_group');
    const afd = node('azure_front_door');
    const waf = node('azure_waf');
    expect(statusOf(runAssessment({ nodes: [rg, afd], edges: [] }).evaluations, 'AZ-AFD-002', afd.id)).toBe('FAIL');
    expect(statusOf(runAssessment({ nodes: [rg, afd, waf], edges: [edge(waf, afd)] }).evaluations, 'AZ-AFD-002', afd.id)).toBe('PASS');
    const cf = node('aws_cloudfront', { webAclId: '' });
    const acl = node('aws_waf');
    expect(statusOf(runAssessment({ nodes: [cf, acl], edges: [edge(acl, cf)] }).evaluations, 'AWS-CF-002', cf.id)).toBe('PASS');
  });
});

describe('Architecture (topology) rules', () => {
  const archStatus = (nodes: CanvasNode[], ruleId: string) => runAssessment({ nodes, edges: [] }).evaluations.find((e) => e.ruleId === ruleId)?.status;

  test('AWS-ARCH-001: lone EC2 fails; EC2 behind a load balancer passes; no EC2 is not applicable', () => {
    expect(archStatus([node('aws_ec2')], 'AWS-ARCH-001')).toBe('FAIL');
    expect(archStatus([node('aws_ec2'), node('aws_alb')], 'AWS-ARCH-001')).toBe('PASS');
    expect(archStatus([node('aws_s3')], 'AWS-ARCH-001')).toBe('NOT_APPLICABLE');
  });

  test('AWS-ARCH-003: two workloads without alarms warn; with an alarm pass; one workload is not applicable', () => {
    expect(archStatus([node('aws_ec2'), node('aws_rds')], 'AWS-ARCH-003')).toBe('WARNING');
    expect(archStatus([node('aws_ec2'), node('aws_rds'), node('aws_cloudwatch')], 'AWS-ARCH-003')).toBe('PASS');
    expect(archStatus([node('aws_ec2')], 'AWS-ARCH-003')).toBe('NOT_APPLICABLE');
  });

  test('AWS-ARCH-004 / AZ-ARCH-030: database + compute without a cache is an informational observation only', () => {
    expect(archStatus([node('aws_ec2'), node('aws_rds')], 'AWS-ARCH-004')).toBe('WARNING');
    expect(archStatus([node('aws_ec2'), node('aws_rds'), node('aws_elasticache')], 'AWS-ARCH-004')).toBe('PASS');
    const rg = node('azure_resource_group');
    expect(archStatus([rg, node('azure_vm'), node('azure_sql')], 'AZ-ARCH-030')).toBe('WARNING');
    expect(archStatus([rg, node('azure_vm'), node('azure_sql'), node('azure_redis')], 'AZ-ARCH-030')).toBe('PASS');
    const f = runAssessment({ nodes: [node('aws_ec2'), node('aws_rds')], edges: [] }).findings.find((x) => x.ruleId === 'AWS-ARCH-004')!;
    expect(f.severity).toBe('INFORMATIONAL');
  });
});


// ─── Evidence provenance: design-time vs discovered vs live-verified ─────────

describe('Evidence provenance', () => {
  const T0 = '2026-09-24T10:00:00.000Z';
  function importedS3(values: Record<string, unknown>, extraConfig: Record<string, unknown> = {}, importState = 'imported'): CanvasNode {
    return {
      id: 's3-imp', type: 'cloudNode', resourceType: 'aws_s3', provider: 'aws', label: 'discovered-bucket', position: { x: 0, y: 0 },
      importState: importState as CanvasNode['importState'],
      config: { ...values, ...extraConfig, imported: true, importState, _discovery: { source: 'aws-api', discoveredAt: T0, values } },
    } as CanvasNode;
  }
  const evalOf = (a: ReturnType<typeof runAssessment>, ruleId: string) => a.evaluations.find((e) => e.ruleId === ruleId)!;

  test('discovered values are labelled DISCOVERED; fields discovery did not return are unknown, not defaults', () => {
    // Discovery returned public-access settings but NOT encryption. The node also carries a
    // design value encryption=true (e.g. from an earlier design merged on re-import).
    const n = importedS3({ publicAccess: false, blockPublicAcls: true, blockPublicPolicy: true }, { encryption: true });
    const a = runAssessment({ nodes: [n], edges: [], evaluatedAt: T0 });
    const pub = evalOf(a, 'AWS-S3-001');
    expect(pub.status).toBe('PASS');
    expect(pub.provenance).toBe('DISCOVERED_CONFIGURATION');
    expect(pub.evidence.filter((e) => e.field).every((e) => e.source === 'DISCOVERED' && e.observedAt === T0)).toBe(true);

    const enc = evalOf(a, 'AWS-S3-002');
    expect(enc.status).toBe('INSUFFICIENT_DATA');
    expect(enc.observation).toMatch(/Discovery did not return/);
    expect(a.analysisMode).toBe('DESIGN_TIME_WITH_DISCOVERED_CONFIGURATION');
  });

  test('a planned change on a discovered resource is DESIGN evidence that shows the discovered value', () => {
    // Design says encryption enabled; discovery says it is not.
    const n = importedS3({ encryption: false, publicAccess: false, blockPublicAcls: true, blockPublicPolicy: true }, { encryption: true }, 'modified');
    const a = runAssessment({ nodes: [n], edges: [], evaluatedAt: T0 });
    const enc = evalOf(a, 'AWS-S3-002');
    expect(enc.status).toBe('PASS'); // the design passes …
    expect(enc.provenance).toBe('DESIGN_TIME'); // … but only as a design
    const item = enc.evidence.find((e) => e.field === 'encryption')!;
    expect(item.source).toBe('DESIGN');
    expect(item.discoveredValue).toBe('Disabled / No');
    // the unchanged fields are still attributed to discovery
    expect(evalOf(a, 'AWS-S3-001').provenance).toBe('DISCOVERED_CONFIGURATION');
  });

  test('LIVE_VERIFIED only from a fresh, matching provider read supplied to the assessment', () => {
    const values = { publicAccess: false, blockPublicAcls: true, blockPublicPolicy: true };
    const n = importedS3(values);
    const fresh = { source: 'aws-s3-GetPublicAccessBlock', observedAt: '2026-09-24T09:55:00.000Z', values };
    expect(evalOf(runAssessment({ nodes: [n], edges: [], evaluatedAt: T0, liveEvidence: { [n.id]: fresh } }), 'AWS-S3-001').provenance).toBe('LIVE_VERIFIED');

    // stale (older than 15 minutes)
    const stale = { ...fresh, observedAt: '2026-09-24T09:30:00.000Z' };
    expect(evalOf(runAssessment({ nodes: [n], edges: [], evaluatedAt: T0, liveEvidence: { [n.id]: stale } }), 'AWS-S3-001').provenance).toBe('DISCOVERED_CONFIGURATION');

    // live read disagrees with the configuration being assessed
    const drift = { ...fresh, values: { ...values, publicAccess: true } };
    expect(evalOf(runAssessment({ nodes: [n], edges: [], evaluatedAt: T0, liveEvidence: { [n.id]: drift } }), 'AWS-S3-001').provenance).not.toBe('LIVE_VERIFIED');

    // partial live read (one field) is not enough to call the evaluation live-verified
    const partial = { ...fresh, values: { publicAccess: false } };
    expect(evalOf(runAssessment({ nodes: [n], edges: [], evaluatedAt: T0, liveEvidence: { [n.id]: partial } }), 'AWS-S3-001').provenance).toBe('DISCOVERED_CONFIGURATION');
  });

  test('without live evidence nothing is ever LIVE_VERIFIED (design, discovered and legacy imports)', () => {
    const design = node('aws_s3');
    const a = runAssessment({ nodes: [design, importedS3({ publicAccess: false })], edges: [] });
    expect(a.evaluations.some((e) => e.provenance === 'LIVE_VERIFIED')).toBe(false);
    expect(a.analysisMode).not.toBe('INCLUDES_LIVE_VERIFIED_EVIDENCE');
  });

  test('Azure: discovered storage settings are assessed on discovered values only', () => {
    const rg = node('azure_resource_group');
    const values = { httpsOnly: true };
    const st: CanvasNode = {
      id: 'st-imp', type: 'cloudNode', resourceType: 'azure_storage', provider: 'azure', label: 'stdiscovered', position: { x: 0, y: 0 }, importState: 'imported',
      config: { ...values, allowBlobPublicAccess: false, imported: true, _discovery: { source: 'azure-arm', discoveredAt: T0, values } },
    } as CanvasNode;
    const a = runAssessment({ nodes: [rg, st], edges: [], evaluatedAt: T0 });
    expect(evalOf(a, 'AZ-STG-001').provenance).toBe('DISCOVERED_CONFIGURATION');
    expect(evalOf(a, 'AZ-STG-002').status).toBe('INSUFFICIENT_DATA'); // allowBlobPublicAccess not discovered
  });
});


// ─── NOT_EVALUATED disposition ───────────────────────────────────────────────

describe('Controls that cannot be evaluated are classified and explained', () => {
  test('every rule that can return NOT_EVALUATED has an evidence-availability classification', () => {
    const types = Array.from(new Set(ALL_RULES.flatMap((r) => r.resourceTypes ?? [])));
    const everything = [node('azure_resource_group'), ...types.filter((t) => t !== 'azure_resource_group').map((t) => node(t))];
    // Remove security groups so AWS-SG-003's not-modelled branch is exercised too.
    const a = runAssessment({ nodes: everything.filter((n) => n.resourceType !== 'aws_sg'), edges: [] });
    const notEvaluatedRules = new Set(a.evaluations.filter((e) => e.status === 'NOT_EVALUATED').map((e) => e.ruleId));
    for (const id of notEvaluatedRules) expect([id, EVIDENCE_AVAILABILITY[id]?.classes.length]).toEqual([id, expect.any(Number)]);
    for (const id of Object.keys(EVIDENCE_AVAILABILITY)) expect(RULES_BY_ID.has(id)).toBe(true);
  });

  test('AWS-EC2-003 (IMDSv2) is now evaluated from design and discovery, never assumed', () => {
    expect(statusOf(runAssessment({ nodes: [node('aws_ec2', { metadataHttpTokens: 'required' })], edges: [] }).evaluations, 'AWS-EC2-003')).toBe('PASS');
    expect(statusOf(runAssessment({ nodes: [node('aws_ec2', { metadataHttpTokens: 'optional' })], edges: [] }).evaluations, 'AWS-EC2-003')).toBe('FAIL');
    expect(statusOf(runAssessment({ nodes: [node('aws_ec2', { metadataHttpTokens: undefined })], edges: [] }).evaluations, 'AWS-EC2-003')).toBe('INSUFFICIENT_DATA');
    expect(EVIDENCE_AVAILABILITY['AWS-EC2-003']).toBeUndefined();
  });
});

// ─── Production hardening: scoring stress ────────────────────────────────────

describe('Score stress tests (score and coverage are independent)', () => {
  const ev = (status: Evaluation['status'], severity: Evaluation['severity'] = 'MEDIUM', provider: 'aws' | 'azure' = 'aws'): Evaluation => ({
    findingId: `x-${Math.random()}`, ruleId: 'X', ruleVersion: '1.0.0', provider, resourceIds: [], resourceLabels: [], status, severity,
    observation: '', evidence: [], provenance: 'DESIGN_TIME',
  });
  const many = (n: number, status: Evaluation['status'], sev: Evaluation['severity'] = 'MEDIUM') => Array.from({ length: n }, () => ev(status, sev));

  test('0 evaluated → Not scored (never 100), coverage null or 0', () => {
    expect(scoreOf([])).toMatchObject({ score: null, rating: 'Not scored' });
    expect(scoreOf([]).coverage.coveragePct).toBeNull();
    const onlyUnknown = scoreOf(many(5, 'NOT_EVALUATED'));
    expect(onlyUnknown).toMatchObject({ score: null, rating: 'Not scored' });
    expect(onlyUnknown.coverage.coveragePct).toBe(0);
  });

  test('1 evaluated (pass) of 1 applicable → 100, Strong, full coverage', () => {
    expect(scoreOf([ev('PASS')])).toMatchObject({ score: 100, rating: 'Strong', lowCoverage: false });
  });

  test('all pass → 100 Strong; all fail → 0 Weak', () => {
    expect(scoreOf(many(10, 'PASS'))).toMatchObject({ score: 100, rating: 'Strong' });
    expect(scoreOf(many(10, 'FAIL'))).toMatchObject({ score: 0, rating: 'Weak' });
  });

  test('one failing CRITICAL caps at 40 even when everything else passes', () => {
    const r = scoreOf([...many(50, 'PASS', 'HIGH'), ev('FAIL', 'CRITICAL')]);
    expect(r.score).toBe(40);
    expect(r.capApplied).toMatch(/CRITICAL/);
  });

  test('one failing HIGH caps at 70', () => {
    const r = scoreOf([...many(50, 'PASS', 'HIGH'), ev('FAIL', 'HIGH')]);
    expect(r.score).toBe(70);
    expect(r.capApplied).toMatch(/HIGH/);
  });

  test('mostly NOT_EVALUATED: passing checks never read as a strong posture', () => {
    const r = scoreOf([...many(2, 'PASS'), ...many(18, 'NOT_EVALUATED')]);
    expect(r.score).toBe(100); // the score describes only what was evaluated …
    expect(r.coverage.coveragePct).toBe(10); // … coverage is reported separately …
    expect(r.lowCoverage).toBe(true);
    expect(r.rating).toBe('Limited evidence'); // … and the rating is not "Strong"
  });

  test('mostly INSUFFICIENT_DATA behaves the same as NOT_EVALUATED (never a pass)', () => {
    const r = scoreOf([...many(3, 'PASS'), ...many(17, 'INSUFFICIENT_DATA')]);
    expect(r.coverage.insufficientData).toBe(17);
    expect(r.rating).toBe('Limited evidence');
  });

  test('low coverage does not hide poor results', () => {
    const r = scoreOf([ev('FAIL', 'HIGH'), ...many(18, 'NOT_EVALUATED')]);
    expect(r.rating).toBe('Weak');
  });

  test('informational-only failures do not move the score; informational-only evaluations are Not scored', () => {
    expect(scoreOf([...many(4, 'FAIL', 'INFORMATIONAL')])).toMatchObject({ score: null, rating: 'Not scored' });
    expect(scoreOf([...many(4, 'PASS'), ...many(4, 'FAIL', 'INFORMATIONAL')]).score).toBe(100);
  });

  test('warnings count as half a failure', () => {
    expect(scoreOf([ev('PASS'), ev('WARNING')]).score).toBe(75);
  });

  test('coverage exactly at the threshold is not low coverage', () => {
    const r = scoreOf([...many(6, 'PASS'), ...many(4, 'NOT_EVALUATED')]);
    expect(r.coverage.coveragePct).toBe(60);
    expect(r.lowCoverage).toBe(false);
    expect(r.rating).toBe('Strong');
  });

  test('mixed AWS/Azure: combined score equals scoring the union; per-provider pillars are separate', () => {
    const a = runAssessment({ nodes: [...insecureAws().nodes, ...insecureAzure().nodes], edges: [] });
    const sec = a.evaluations.filter((e) => RULES_BY_ID.get(e.ruleId)!.domain === 'SECURITY');
    expect(a.securityScore.score).toBe(scoreOf(sec).score);
    expect(a.pillarResults.filter((p) => p.provider === 'aws')).toHaveLength(6);
    expect(a.pillarResults.filter((p) => p.provider === 'azure')).toHaveLength(5);
  });

  test('a real sparse design is flagged and not rated Strong', () => {
    // An imported bucket with only one discovered setting: most checks lack data.
    const values = { publicAccess: false, blockPublicAcls: true, blockPublicPolicy: true };
    const s3: CanvasNode = { id: 's3', type: 'cloudNode', resourceType: 'aws_s3', provider: 'aws', label: 'b', position: { x: 0, y: 0 }, importState: 'imported',
      config: { ...values, _discovery: { source: 'aws-api', discoveredAt: '2026-09-24T00:00:00Z', values } } } as CanvasNode;
    const a = runAssessment({ nodes: [s3], edges: [] });
    expect(a.securityScore.lowCoverage).toBe(true);
    expect(['Strong', 'Good']).not.toContain(a.securityScore.rating);
  });
});

// ─── Production hardening: multi-cloud isolation ─────────────────────────────

describe('Multi-cloud isolation', () => {
  test('AWS resources are only evaluated by AWS rules and Azure resources only by Azure rules', () => {
    const a = runAssessment({ nodes: [...insecureAws().nodes, ...insecureAzure().nodes], edges: [] });
    const byId = new Map([...insecureAws().nodes, ...insecureAzure().nodes].map((n) => [n.id, n]));
    for (const e of a.evaluations) {
      const rule = RULES_BY_ID.get(e.ruleId)!;
      expect(e.provider).toBe(rule.provider);
      for (const id of e.resourceIds) {
        const n = a.evaluations.length && byId.get(id);
        if (n) expect(n.provider).toBe(rule.provider);
      }
    }
  });

  test('cross-cloud edges never make an AWS rule read Azure configuration (or vice versa)', () => {
    const rds = node('aws_rds', { publiclyAccessible: false, encrypted: true });
    const sql = node('azure_sql', { publicNetworkAccess: true });
    const rg = node('azure_resource_group');
    const a = runAssessment({ nodes: [rds, sql, rg], edges: [edge(rds, sql)] });
    const awsEvals = a.evaluations.filter((e) => e.provider === 'aws');
    expect(awsEvals.every((e) => e.resourceIds.every((id) => id !== sql.id))).toBe(true);
    // Azure SQL public access is reported by the Azure rule only
    expect(a.findings.filter((f) => f.resourceIds.includes(sql.id)).every((f) => f.ruleId.startsWith('AZ-'))).toBe(true);
  });

  test('a single-provider design gets no rules from the other provider', () => {
    expect(runAssessment({ nodes: insecureAws().nodes, edges: [] }).evaluations.some((e) => e.provider === 'azure')).toBe(false);
    expect(runAssessment({ nodes: insecureAzure().nodes, edges: [] }).evaluations.some((e) => e.provider === 'aws')).toBe(false);
  });
});

// ─── Production hardening: Auto-Fix full sequence, idempotency and rollback ──

describe('SAFE_AUTOFIX full sequence', () => {
  // A failing design-time fixture per rule. AWS-ASG-001 is relationship-based (needs a load balancer edge).
  const fixture = (ruleId: string): { nodes: CanvasNode[]; edges: CanvasEdge[]; target: CanvasNode } => {
    if (ruleId === 'AWS-ASG-001') {
      const target = node('aws_auto_scaling', { healthCheckType: 'EC2' }, { id: 'safe-AWS-ASG-001' });
      const alb = node('aws_alb');
      return { nodes: [target, alb], edges: [edge(alb, target)], target };
    }
    const [type, cfg] = FAILING[ruleId];
    const rg = type.startsWith('azure') ? [node('azure_resource_group')] : [];
    const target = node(type, cfg, { id: `safe-${ruleId}` });
    return { nodes: [...rg, target], edges: [], target };
  };
  // Rules whose fix is SAFE on a design-time resource (static SAFE, or dynamic safety resolving to SAFE).
  const safeRules = ALL_RULES.filter((r) => r.autoFix && r.scope === 'resource' && (FAILING[r.id] || r.id === 'AWS-ASG-001')).filter((r) => {
    const f = fixture(r.id);
    const plan = planAutoFix(f.nodes, f.edges, findingIdFor(r.id, f.target.id));
    return !('error' in plan) && plan.safety === 'SAFE_AUTOFIX';
  });

  test('covers every rule whose fix is SAFE_AUTOFIX on a design resource', () => {
    const staticSafe = ALL_RULES.filter((r) => r.autoFix && r.autoFix.safety === 'SAFE_AUTOFIX' && r.scope === 'resource').map((r) => r.id);
    expect(staticSafe.filter((id) => !safeRules.some((r) => r.id === id))).toEqual([]);
    expect(safeRules.length).toBeGreaterThanOrEqual(staticSafe.length);
  });

  test.each(safeRules.map((r) => [r.id]))('%s: finding → preview → apply → graph → security + WA rerun → Terraform → cost → persist → reload → still resolved → apply twice', (ruleId) => {
    const { nodes, edges, target } = fixture(ruleId);
    const fid = findingIdFor(ruleId, target.id);
    const pillar = RULES_BY_ID.get(ruleId)!.wellArchitected.pillar;

    // finding exists (security engine and Well-Architected view)
    expect(runAssessment({ nodes, edges }).findings.some((f) => f.findingId === fid)).toBe(true);
    const waBefore = new WellArchitectedRuleEngine().analyze({ architectureId: 'a', nodes, edges });
    expect(waBefore.findings.some((f) => f.ruleId === ruleId)).toBe(true);

    // preview
    const plan = planAutoFix(nodes, edges, fid);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.safety).toBe('SAFE_AUTOFIX'); // design-time resource
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.terraform.added.length + plan.terraform.removed.length).toBeGreaterThan(0);

    // apply
    const r = applyAutoFix(nodes, edges, fid, { confirmed: false }); // SAFE needs no confirmation
    expect(r.status).toBe('RESOLVED');
    // canonical graph changed on the target only
    expect(r.nodes.find((n) => n.id === target.id)!.config).not.toEqual(target.config);
    // security + WA rerun
    expect(runAssessment({ nodes: r.nodes, edges }).findings.some((f) => f.findingId === fid)).toBe(false);
    const waAfter = new WellArchitectedRuleEngine().analyze({ architectureId: 'a', nodes: r.nodes, edges });
    expect(waAfter.findings.some((f) => f.ruleId === ruleId)).toBe(false);
    expect(waAfter.pillarScores.find((p) => p.pillar === pillar)).toBeDefined();
    // cost impact matches the declared impact
    if (plan.cost.impact === 'NONE') expect(plan.cost.deltaMonthly).toBe(0);
    if (plan.cost.impact === 'POSSIBLE_DECREASE') expect(plan.cost.deltaMonthly).toBeLessThanOrEqual(0);
    if (plan.cost.impact === 'POSSIBLE_INCREASE') expect(plan.cost.deltaMonthly).toBeGreaterThanOrEqual(0);
    // persistence + reload
    const reloaded = persistRoundTrip(r.nodes, edges);
    expect(runAssessment(reloaded).findings.some((f) => f.findingId === fid)).toBe(false);
    // apply twice (idempotent) — also after reload
    expect(applyAutoFix(r.nodes, edges, fid).status).toBe('ALREADY_RESOLVED');
    expect(applyAutoFix(reloaded.nodes, reloaded.edges, fid).status).toBe('ALREADY_RESOLVED');
  });

});

describe('REVIEW_REQUIRED fixes show their full impact and never apply silently', () => {
  const reviewRules = ALL_RULES.filter((r) => r.autoFix && r.autoFix.safety === 'REVIEW_REQUIRED' && r.scope === 'resource' && FAILING[r.id]);
  test.each(reviewRules.map((r) => [r.id]))('%s', (ruleId) => {
    const [type, cfg] = FAILING[ruleId];
    const rg = type.startsWith('azure') ? [node('azure_resource_group')] : [];
    const target = node(type, cfg, { id: `rev-${ruleId}` });
    const nodes = [...rg, target];
    const fid = findingIdFor(ruleId, target.id);
    const plan = planAutoFix(nodes, [], fid);
    if ('error' in plan) throw new Error(plan.error);
    // current state, proposed state, affected resources, security / architecture / cost / Terraform impact
    expect(plan.changes.every((c) => c.current !== undefined && c.proposed !== undefined && c.label)).toBe(true);
    expect(plan.affectedResources.length).toBeGreaterThan(0);
    expect(plan.securityImprovement.length).toBeGreaterThan(10);
    expect(plan.architectureImpact.length).toBeGreaterThan(5);
    expect(plan.cost).toEqual(expect.objectContaining({ impact: expect.any(String), deltaMonthly: expect.any(Number) }));
    expect(plan.terraform.added.length + plan.terraform.removed.length).toBeGreaterThan(0);
    expect(plan.safetyReason.length).toBeGreaterThan(10);
    // without confirmation nothing changes
    const r = applyAutoFix(nodes, [], fid);
    expect(r.status).toBe('REJECTED');
    expect(r.nodes).toBe(nodes);
    // bulk "fix all safe" never includes it
    expect(safeFixCandidates(runAssessment({ nodes, edges: [] }).findings).some((f) => f.findingId === fid)).toBe(false);
  });
});

describe('Auto-Fix rollback (forced post-fix verification failures)', () => {
  const target = () => node('aws_ec2', { detailedMonitoring: false }, { id: 'rollback-ec2' });
  const fid = findingIdFor('AWS-EC2-010', 'rollback-ec2');
  const expectRestored = (r: ReturnType<typeof applyAutoFix>, nodes: CanvasNode[], snapshot: string) => {
    expect(r.status).toBe('AUTO_FIX_FAILED');
    expect(r.reason).toMatch(/left unchanged/);
    expect(r.nodes).toBe(nodes); // the original graph is returned …
    expect(JSON.stringify(r.nodes)).toBe(snapshot); // … and was not mutated
    expect(runAssessment({ nodes: r.nodes, edges: [] }).findings.some((f) => f.findingId === fid)).toBe(true);
  };

  test('canonical validation failure after the change', () => {
    const nodes = [target()]; const snap = JSON.stringify(nodes);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const canonical = require('@/lib/domain/canonicalArchitecture');
    const real = canonical.validateCanonicalArchitecture;
    let call = 0;
    const spy = jest.spyOn(canonical, 'validateCanonicalArchitecture').mockImplementation((...args: unknown[]) => {
      const res = real(...args);
      call += 1;
      return call === 2 ? { ...res, issues: [...res.issues, { code: 'FORCED', severity: 'critical', message: 'forced failure', affectedResourceIds: ['rollback-ec2'] }] } : res;
    });
    try { expectRestored(applyAutoFix(nodes, [], fid), nodes, snap); } finally { spy.mockRestore(); }
  });

  test('rule re-run still failing (patch does not fix it)', () => {
    const nodes = [target()]; const snap = JSON.stringify(nodes);
    const rule = RULES_BY_ID.get('AWS-EC2-010')!;
    const orig = rule.autoFix!.patch;
    rule.autoFix!.patch = () => ({ detailedMonitoring: false, name: 'changed' });
    try { expectRestored(applyAutoFix(nodes, [], fid), nodes, snap); } finally { rule.autoFix!.patch = orig; }
  });

  test('change introduces a new HIGH finding', () => {
    const nodes = [target()]; const snap = JSON.stringify(nodes);
    const rule = RULES_BY_ID.get('AWS-EC2-010')!;
    const orig = rule.autoFix!.patch;
    rule.autoFix!.patch = () => ({ detailedMonitoring: true, metadataHttpTokens: 'optional' }); // fixes the rule, breaks IMDSv2 (HIGH)
    try {
      const r = applyAutoFix(nodes, [], fid);
      expectRestored(r, nodes, snap);
      expect(r.reason).toMatch(/AWS-EC2-003/);
    } finally { rule.autoFix!.patch = orig; }
  });

  test('Terraform does not reflect the change', () => {
    const nodes = [target()]; const snap = JSON.stringify(nodes);
    const rule = RULES_BY_ID.get('AWS-EC2-010')!;
    const orig = rule.autoFix!.terraformExpect;
    rule.autoFix!.terraformExpect = /this_line_never_appears/;
    try { expectRestored(applyAutoFix(nodes, [], fid), nodes, snap); } finally { rule.autoFix!.terraformExpect = orig; }
  });

  test('bulk safe fixes: one failing fix is rolled back, the others still apply', () => {
    const ec2 = target();
    const s3 = node('aws_s3', { versioning: false }, { id: 'bulk-s3' });
    const nodes = [ec2, s3];
    const rule = RULES_BY_ID.get('AWS-EC2-010')!;
    const orig = rule.autoFix!.terraformExpect;
    rule.autoFix!.terraformExpect = /this_line_never_appears/;
    try {
      const summary = applySafeFixes(nodes, [], safeFixCandidates(runAssessment({ nodes, edges: [] }).findings).map((f) => f.findingId));
      expect(summary.results.find((x) => x.findingId === fid)!.status).toBe('AUTO_FIX_FAILED');
      expect(summary.nodes.find((n) => n.id === ec2.id)!.config).toEqual(ec2.config);
      expect(summary.resolved).toBeGreaterThan(0);
    } finally { rule.autoFix!.terraformExpect = orig; }
  });
});
