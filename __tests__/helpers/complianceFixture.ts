/** A realistic sample of the readiness report's input, for the renderer tests and for looking at the output by eye. */
import type { Evaluation } from '@/lib/engines/assessment/types';
import { buildReadinessReport, type ReadinessReport, type ReportInput } from '@/lib/compliance/report';
import type { ControlRecord, EvidenceRef, FrameworkId } from '@/lib/compliance/types';
import { soc2Defs, awsDefs, azureDefs } from '@/lib/compliance/frameworks';
import { analyzePeriod, type SnapshotRecord } from '@/lib/compliance/snapshots';

export const AS_OF = new Date('2026-10-26T00:00:00Z');
const ev = (ruleId: string, status: Evaluation['status'], extra: Partial<Evaluation> = {}): Evaluation => ({ ruleId, status, observation: `Observed for ${ruleId}.`, severity: 'MEDIUM', provenance: 'DESIGN_TIME', ...extra } as Evaluation);
const rec = (controlId: string, over: Partial<ControlRecord> = {}): ControlRecord => ({ controlId, status: 'implemented', owner: 'Priya Nair', note: '', naReason: '', reviewer: '', ...over });

/** Weekly snapshots over the quarter before AS_OF, with a few controls that dipped and a two-week hole in September. */
function fixturePeriod(framework: FrameworkId, ids: string[]) {
  const days = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'];
  const snaps: SnapshotRecord[] = days.map((d, k) => ({ id: d, takenAt: `${d}T06:00:00.000Z`, trigger: 'scheduled', readiness: 'Not ready',
    controls: ids.map((id, n) => ({ id, score: n % 7 === 6 ? null : n % 5 === 0 && k % 4 === 3 ? 2 : n % 9 === 8 ? 1 : 3, confidence: 'Medium', failing: n % 11 === 3 && k > 5 ? ['AWS-RDS-002'] : [], evidence: 1 })) }));
  return analyzePeriod(framework, snaps, new Date('2026-07-28T00:00:00Z'), new Date('2026-10-26T23:59:59Z'));
}

export function fixtureInput(framework: FrameworkId = 'soc2'): ReportInput {
  const defs = framework === 'soc2' ? soc2Defs() : framework === 'aws-waf' ? awsDefs() : azureDefs();
  const records: Record<string, ControlRecord> = {};
  const evidence: Array<EvidenceRef & { controls: string[] }> = [];
  defs.forEach((d, n) => {
    if (n % 7 === 6) return;                                                                            // nobody has assessed it
    if (n % 11 === 10) { records[d.id] = rec(d.id, { status: 'planned', owner: 'Sam Okafor' }); return; }   // missing
    if (n % 13 === 12) { records[d.id] = rec(d.id, { status: 'not_applicable', naReason: 'The company has no office; the cloud provider holds the hardware.' }); return; }
    records[d.id] = rec(d.id, n % 5 === 0 ? { reviewer: 'Dana Li', reviewedAt: '2026-10-01' } : {});
    if (n % 3 !== 0) evidence.push({ id: `raw-${n}`, title: `Evidence for ${d.id}`, kind: n % 4 === 0 ? 'link' : 'file', origin: n % 2 === 0 ? 'system' : 'manual', collectedAt: n % 9 === 0 ? '2025-01-15' : '2026-10-05', fileName: n % 4 === 0 ? undefined : `${d.id.toLowerCase()}.pdf`, sha256: 'ab12cd34ef567890'.repeat(4), controls: [d.id] });
  });
  return {
    framework, company: 'Northwind Data Ltd', preparedBy: 'Priya Nair (Security lead)', asOf: AS_OF, generatedAt: new Date('2026-10-26T09:30:00Z'), version: 2,
    system: { name: 'Northwind Analytics Platform', description: 'A web application that lets customers upload and analyse their sales data.', environment: 'production', providers: ['aws', 'azure'], regions: ['eu-west-1', 'westeurope'], services: ['Databases x3', 'Virtual machines x4', 'Storage x2'], thirdParties: [{ vendor: 'Datadog', use: 'Monitoring', dataHeld: 'Non-sensitive data' }, { vendor: 'Auth0', use: 'Sign-in and identity', dataHeld: 'Personal data' }] },
    categories: framework === 'soc2' ? ['security', 'availability'] : undefined, exclusions: { confidentiality: 'The service holds no data its customers classify as confidential.' },
    records, evidence,
    evaluations: [ev('AWS-S3-002', 'PASS', { provenance: 'DISCOVERED_CONFIGURATION' }), ev('AWS-RDS-002', 'FAIL', { severity: 'HIGH', observation: 'RDS storage encryption is disabled on orders-db.' }), ev('AWS-ACCT-003', 'PASS', { provenance: 'LIVE_VERIFIED' }), ev('AWS-SG-001', 'PASS'), ev('WAQ-AWS-SEC-04', 'FAIL', { observation: 'Answered "No". There is no tested incident response plan.' })],
    facts: { members: 5, mfaEnrolled: 4, approvalsLast90d: 12, auditEventsLast90d: 240, deployRestricted: true, lastAssessmentAt: '2026-10-20T00:00:00Z', lastDiscoveryAt: '2026-10-22T00:00:00Z' },
    findingRecords: { 'CTL-23': { controlId: 'CTL-23', owner: 'Sam Okafor', targetDate: '2026-11-30', status: 'in_progress', managementResponse: 'Encryption will be switched on during the November maintenance window.', acceptedBy: '', retestedBy: '' } },
    signoffs: [{ role: 'preparer', name: 'Priya Nair', email: 'priya@northwind.example', signedAt: '2026-10-26T09:45:00Z' }],
    accountRead: true,
    period: fixturePeriod(framework, defs.map((d) => d.id)),
  };
}

export const fixtureReport = (framework: FrameworkId = 'soc2'): ReadinessReport => buildReadinessReport(fixtureInput(framework));
