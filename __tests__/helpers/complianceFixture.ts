/** A realistic sample of the readiness report's input, for the renderer tests and for looking at the output by eye. */
import { createHash } from 'crypto';
import { groupEntries, type EntryRow } from '@/lib/compliance/entries';
import type { ConfigRow } from '@/lib/compliance/configuration';
import type { Evaluation } from '@/lib/engines/assessment/types';
import { buildReadinessReport, type ReadinessReport, type ReportInput } from '@/lib/compliance/report';
import type { ControlRecord, EvidenceRef, FrameworkId } from '@/lib/compliance/types';
import { soc2Defs, awsDefs, azureDefs } from '@/lib/compliance/frameworks';
import { analyzePeriod, type SnapshotRecord } from '@/lib/compliance/snapshots';

export const AS_OF = new Date('2026-10-26T00:00:00Z');
const ev = (ruleId: string, status: Evaluation['status'], extra: Partial<Evaluation> = {}): Evaluation => ({ ruleId, status, observation: `Observed for ${ruleId}.`, severity: 'MEDIUM', provenance: 'DESIGN_TIME', ...extra } as Evaluation);
const rec = (controlId: string, over: Partial<ControlRecord> = {}): ControlRecord => ({ controlId, status: 'implemented', owner: 'Priya Nair', note: '', naReason: '', reviewer: '', ...over });

const cfg = (resource: string, type: string, provider: 'AWS' | 'Azure', region: string, setting: string, observed: string, expected: string, result: ConfigRow['result'], source: ConfigRow['source'], extra: Partial<ConfigRow> = {}): ConfigRow => ({ resourceId: `${resource}-id`, resource, type, provider, region, setting, observed, expected, result, source, ...extra });
export const FIXTURE_CONFIG: ConfigRow[] = [
  cfg('orders-db', 'RDS instance', 'AWS', 'eu-west-1', 'Storage encryption', 'Disabled', 'Enabled', 'Fail', 'Discovered', { readAt: '2026-10-22T08:00:00Z' }),
  cfg('orders-db', 'RDS instance', 'AWS', 'eu-west-1', 'Multi-AZ', 'Enabled', 'Enabled', 'Pass', 'Discovered', { readAt: '2026-10-22T08:00:00Z' }),
  cfg('orders-db', 'RDS instance', 'AWS', 'eu-west-1', 'Backup retention', '7 days', '7 days or more', 'Pass', 'Design', { accountValue: '1 day' }),
  cfg('uploads', 'S3 bucket', 'AWS', 'eu-west-1', 'Public access', 'Blocked', 'Blocked', 'Pass', 'Live', { readAt: '2026-10-25T08:00:00Z' }),
  cfg('uploads', 'S3 bucket', 'AWS', 'eu-west-1', 'Versioning', 'Not set', 'Enabled', 'Unclear', 'Design'),
  cfg('web-sg', 'Security group', 'AWS', 'eu-west-1', 'SSH from the internet', 'Closed', 'Closed', 'Pass', 'Discovered', { readAt: '2026-10-22T08:00:00Z' }),
  cfg('reports-store', 'Storage account', 'Azure', 'westeurope', 'Secure transfer', 'Required', 'Required', 'Pass', 'Design'),
];

const row = (kind: string, key: string | null, data: Record<string, string>, n: number): EntryRow => ({ id: `entry-${n}`, kind, key, dataJson: JSON.stringify(data), updatedBy: 'priya@northwind.example', updatedAt: `2026-10-${String(10 + (n % 15)).padStart(2, '0')}T09:00:00Z` });
export const FIXTURE_TEAM = groupEntries([
  row('change', null, { date: '2026-09-14', change: 'Moved the orders database from a single instance to Multi-AZ.', systems: 'orders-db', criteria: 'A1.2, CC7.5', impact: 'Failover now automatic; recovery test repeated.', reviewedBy: 'Dana Li' }, 1),
  row('change', null, { date: '2026-08-02', change: 'Replaced the monitoring vendor.', systems: 'Monitoring', criteria: 'CC7.2', impact: 'Alert rules re-created and tested.', reviewedBy: 'Dana Li' }, 2),
  row('prior_finding', null, { priorId: 'PF-3', report: 'Internal review, March 2026', condition: 'No tested recovery plan.', remediation: 'Recovery plan written and tested in June.', closureEvidence: 'EV-004', statusNow: 'Closed', retestedBy: 'Dana Li', retestedOn: '2026-09-30' }, 3),
  row('walkthrough', 'CTL-01', { participant: 'Priya Nair (HR)', date: '2026-10-08', documents: 'Code of conduct v3; acceptance log', observed: 'New joiners accept the code in the onboarding tool; the log shows 41 of 41.', population: 'HR system joiner list, reconciled to the acceptance log', conclusion: 'Designed and in place.', preparer: 'Sam Okafor', reviewer: 'Dana Li' }, 4),
  row('cuec', 'CUEC-1', { status: 'Confirmed', contracts: 'Order form, clause 7.2', communicated: 'Customer onboarding guide' }, 5),
  row('cuec', 'CUEC-3', { status: 'Gap', note: 'The incident contact is not in the contract template yet; legal to add by 30 November.' }, 6),
  row('csoc', 'CSOC-1.1', { status: 'Confirmed', report: 'AWS SOC 2 Type 2, 1 Oct 2025 to 30 Sep 2026', ourControl: 'Annual review of the provider report' }, 7),
  row('provider_review', 'Amazon Web Services', { treatment: 'Carve-out', reportType: 'SOC 2 Type 2', period: '1 Oct 2025 to 30 Sep 2026', coversPeriod: 'No', bridgeLetter: '1 Oct 2026 to 26 Oct 2026', opinion: 'Unqualified; no exceptions relevant to our use.', reviewedBy: 'Dana Li', reviewedOn: '2026-10-20' }, 8),
  row('review_conclusion', 'main', { conclusion: 'AWS controls are adequately covered for the criteria in scope once the bridge letter is received. Azure and the two third-party services are not yet reviewed.', acceptedBy: 'Chief executive' }, 9),
  row('limitation_note', 'L-01', { owner: 'Sam Okafor', note: 'Evidence requested from HR.' }, 10),
  row('finding_plan', 'CTL-23', { milestones: 'Maintenance window booked 14 Nov; encryption enabled 15 Nov.', acceptance: 'The database reports encrypted storage and a re-scan passes.', closureEvidence: '' }, 11),
], { cpaFirm: 'Harbor & Pike LLP', scanProvider: 'Northwind Pen Tests Ltd', scanFrequency: 'annually' });

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
    if (n % 3 !== 0) evidence.push({ id: `raw-${n}`, title: `Evidence for ${d.id}`, kind: n % 4 === 0 ? 'link' : 'file', origin: n % 2 === 0 ? 'system' : 'manual', collectedAt: n % 9 === 0 ? '2025-01-15' : '2026-10-05', fileName: n % 4 === 0 ? undefined : `${d.id.toLowerCase()}.pdf`, sha256: createHash('sha256').update(`evidence file ${n}`).digest('hex'), controls: [d.id] });
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
    configuration: FIXTURE_CONFIG,
    team: FIXTURE_TEAM,
    architectureHistory: [{ date: '2026-10-12', label: 'Add Auth0 sign-in', summary: 'Added a third-party identity service.', author: 'Priya Nair' }, { date: '2026-09-14', label: 'Enable Multi-AZ', summary: 'orders-db', author: 'Sam Okafor' }],
  };
}

export const fixtureReport = (framework: FrameworkId = 'soc2'): ReadinessReport => buildReadinessReport(fixtureInput(framework));
