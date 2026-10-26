/**
 * The control sets the readiness module reports on, as ControlDefs: SOC 2 (the categories the company chose), the 56 questions of the AWS Well-Architected Framework and the
 * 59 recommendations of the Azure Well-Architected Framework. Question titles are AWS's and Microsoft's own; everything else here is written for CloudBuilder.
 */
import { AZURE_CHECKLIST, AZURE_PILLAR_LABEL } from '@/lib/azureReview/checklist';
import { SOC2_CRITERIA_BY_ID, type Soc2Category } from './soc2/criteria';
import { RULE_SETS, SOC2_CONTROLS, soc2CategoryOf } from './soc2/controls';
import type { ControlDef } from './model';
import type { FrameworkId } from './types';
import type { PlatformCheck } from './signals';

export const FRAMEWORK_LABEL: Record<FrameworkId, string> = { soc2: 'SOC 2 Type 1 readiness', 'aws-waf': 'AWS Well-Architected Framework', 'azure-waf': 'Azure Well-Architected Framework' };

export function soc2Defs(categories: readonly Soc2Category[] = ['security', 'availability', 'confidentiality']): ControlDef[] {
  return SOC2_CONTROLS.filter((c) => categories.includes(soc2CategoryOf(c))).map((c) => {
    const crit = SOC2_CRITERIA_BY_ID.get(c.criterion)!;
    return { id: c.id, group: c.criterion, title: c.title, ownerRole: c.ownerRole, activity: c.activity, frequency: c.frequency, evidence: c.evidence, rules: c.rules, platform: c.platform,
      effect: `Weakens ${c.criterion} (${crit.name}): ${crit.asks}` };
  });
}

// ── AWS Well-Architected Framework ─────────────────────────────────────────
type Pillar = 'Operational Excellence' | 'Security' | 'Reliability' | 'Performance Efficiency' | 'Cost Optimization' | 'Sustainability';
const OWNER: Record<Pillar, string> = { 'Operational Excellence': 'Cloud operations lead', Security: 'Security lead', Reliability: 'Engineering lead', 'Performance Efficiency': 'Architecture lead', 'Cost Optimization': 'FinOps lead', Sustainability: 'Architecture lead' };
const aws = (ids: readonly string[]) => ids.filter((i) => i.startsWith('AWS-'));
const qa = (...ids: string[]) => ids.map((i) => `WAQ-AWS-${i}`);

type Row = [id: string, pillar: Pillar, title: string, area: string, rules: string[], platform?: PlatformCheck[]];
const AWS_ROWS: Row[] = [
  ['OPS 1', 'Operational Excellence', 'How do you determine what your priorities are?', 'business and compliance priorities guide operational decisions', []],
  ['OPS 2', 'Operational Excellence', 'How do you structure your organization to support your business outcomes?', 'teams own what they run, with clear responsibilities', qa('OPS-08')],
  ['OPS 3', 'Operational Excellence', 'How does your organizational culture support your business outcomes?', 'leaders support learning, safe experiments and blameless reviews', qa('OPS-05')],
  ['OPS 4', 'Operational Excellence', 'How do you design your workload so that you can understand its state?', 'the workload reports its own state through logs, metrics and traces', ['AWS-ARCH-003', 'AWS-LAMBDA-001', 'AWS-EC2-010', ...qa('OPS-06')]],
  ['OPS 5', 'Operational Excellence', 'How do you reduce defects, ease remediation, and improve flow into production?', 'changes reach production through automation and review', qa('OPS-01', 'OPS-07'), ['approvals']],
  ['OPS 6', 'Operational Excellence', 'How do you mitigate deployment risks?', 'releases are small, reversible and watched', qa('OPS-02')],
  ['OPS 7', 'Operational Excellence', 'How do you know that you are ready to support a workload?', 'runbooks and readiness checks exist before launch', qa('OPS-03')],
  ['OPS 8', 'Operational Excellence', 'How do you understand the health of your workload?', 'workload health is measured against targets', ['AWS-ARCH-003', ...qa('OPS-06')]],
  ['OPS 9', 'Operational Excellence', 'How do you understand the health of your operations?', 'the health of operations (releases, incidents) is measured', qa('OPS-06')],
  ['OPS 10', 'Operational Excellence', 'How do you manage workload and operations events?', 'events are detected, triaged and escalated by a process', qa('OPS-04', 'OPS-03')],
  ['OPS 11', 'Operational Excellence', 'How do you evolve operations?', 'operations improve from experience and reviews', qa('OPS-05')],
  ['SEC 1', 'Security', 'How do you securely operate your workload?', 'accounts are separated, the root account is protected and security controls are automated', ['AWS-ACCT-003', ...qa('SEC-01')]],
  ['SEC 2', 'Security', 'How do you manage identities for people and machines?', 'people and machines use strong or temporary credentials, and secrets are managed', ['AWS-ACCT-003', ...qa('SEC-01', 'SEC-03')], ['mfa']],
  ['SEC 3', 'Security', 'How do you manage permissions for people and machines?', 'permissions are least-privilege and reviewed', ['AWS-IAM-001', ...qa('SEC-02')], ['restricted-deploy']],
  ['SEC 4', 'Security', 'How do you detect and investigate security events?', 'security events are logged, collected and alerted on', aws(RULE_SETS.LOGGING)],
  ['SEC 5', 'Security', 'How do you protect your network resources?', 'networks are layered and traffic is controlled', aws(RULE_SETS.BOUNDARY)],
  ['SEC 6', 'Security', 'How do you protect your compute resources?', 'compute is hardened, patched and reachable only as needed', ['AWS-EC2-003', 'AWS-EC2-001', ...qa('SEC-05')]],
  ['SEC 7', 'Security', 'How do you classify your data?', 'data is classified and handled by how sensitive it is', qa('SEC-06')],
  ['SEC 8', 'Security', 'How do you protect your data at rest?', 'stored data is encrypted and access is controlled', aws(RULE_SETS.AT_REST)],
  ['SEC 9', 'Security', 'How do you protect your data in transit?', 'data in motion is encrypted and traffic is authenticated', aws(RULE_SETS.IN_TRANSIT)],
  ['SEC 10', 'Security', 'How do you anticipate, respond to, and recover from incidents?', 'incidents are planned for, rehearsed and recovered from', qa('SEC-04'), ['audit-log']],
  ['REL 1', 'Reliability', 'How do you manage Service Quotas and constraints?', 'quotas and limits are known and watched', qa('REL-05')],
  ['REL 2', 'Reliability', 'How do you plan your network topology?', 'the network is planned for connectivity, growth and failure', ['AWS-ARCH-002', 'AWS-VPC-003']],
  ['REL 3', 'Reliability', 'How do you design your workload service architecture?', 'the workload is split into small services that can fail independently', []],
  ['REL 4', 'Reliability', 'How do you design interactions in a distributed system to prevent failures?', 'interactions are designed to prevent failures (limits, loose coupling)', ['AWS-SQS-002']],
  ['REL 5', 'Reliability', 'How do you design interactions in a distributed system to mitigate or withstand failures?', 'interactions withstand failure (timeouts, retries, fallbacks)', ['AWS-SQS-002', ...qa('REL-06')]],
  ['REL 6', 'Reliability', 'How do you monitor workload resources?', 'resources are monitored and alarms notify people', ['AWS-ARCH-003', 'AWS-EC2-010', ...qa('OPS-06')]],
  ['REL 7', 'Reliability', 'How do you design your workload to adapt to changes in demand?', 'capacity follows demand automatically', [...aws(RULE_SETS.CAPACITY), ...qa('REL-04')]],
  ['REL 8', 'Reliability', 'How do you implement change?', 'changes are controlled, tested and reversible', qa('OPS-01', 'OPS-02', 'OPS-07'), ['approvals']],
  ['REL 9', 'Reliability', 'How do you back up data?', 'data is backed up, protected, and restores are tested', [...aws(RULE_SETS.BACKUP), ...qa('REL-01')]],
  ['REL 10', 'Reliability', 'How do you use fault isolation to protect your workload?', 'the workload runs in more than one failure zone', ['AWS-ARCH-002', 'AWS-RDS-006', 'AWS-ELC-003']],
  ['REL 11', 'Reliability', 'How do you design your workload to withstand component failures?', 'a failed component is replaced without an outage', ['AWS-ASG-001', 'AWS-ELB-004', 'AWS-ARCH-001']],
  ['REL 12', 'Reliability', 'How do you test reliability?', 'failure and recovery are tested on purpose', qa('REL-06', 'REL-03')],
  ['REL 13', 'Reliability', 'How do you plan for disaster recovery (DR)?', 'recovery objectives are set and the plan is tested', qa('REL-02', 'REL-03', 'REL-01')],
  ['PERF 1', 'Performance Efficiency', 'How do you select appropriate cloud resources and architecture for your workload?', 'resources and architecture are chosen against measured needs', qa('PERF-01', 'PERF-03')],
  ['PERF 2', 'Performance Efficiency', 'How do you select and use compute resources in your workload?', 'compute is sized and scaled to the workload', ['AWS-SUS-002', 'AWS-PERF-003']],
  ['PERF 3', 'Performance Efficiency', 'How do you select and use data management resources in your workload?', 'data stores are chosen and tuned for their access patterns', ['AWS-ARCH-004', 'AWS-PERF-004', ...qa('PERF-05')]],
  ['PERF 4', 'Performance Efficiency', 'How do you select and configure networking resources in your workload?', 'networking is chosen for latency and throughput', ['AWS-PERF-001', 'AWS-PERF-002', 'AWS-CF-001']],
  ['PERF 5', 'Performance Efficiency', 'How do your organizational practices and culture contribute to performance efficiency in your workload?', 'performance is measured, tested and reviewed as a habit', qa('PERF-02', 'PERF-04')],
  ['COST 1', 'Cost Optimization', 'How do you implement cloud financial management?', 'someone owns the cloud budget and cost is reported', qa('COST-01')],
  ['COST 2', 'Cost Optimization', 'How do you govern usage?', 'usage is governed by policies and tagging', qa('COST-02')],
  ['COST 3', 'Cost Optimization', 'How do you monitor usage and cost?', 'cost and usage are monitored with alerts', ['AWS-COST-003', ...qa('COST-01', 'COST-03')]],
  ['COST 4', 'Cost Optimization', 'How do you decommission resources?', 'unused resources are found and removed', ['AWS-S3-006', ...qa('COST-03')]],
  ['COST 5', 'Cost Optimization', 'How do you evaluate cost when you select services?', 'cost is compared when services are chosen', qa('COST-03')],
  ['COST 6', 'Cost Optimization', 'How do you meet cost targets when you select resource type, size and number?', 'resources are sized to meet cost targets', ['AWS-COST-001', ...qa('COST-03')]],
  ['COST 7', 'Cost Optimization', 'How do you use pricing models to reduce cost?', 'steady load uses commitment discounts where it pays', qa('COST-04')],
  ['COST 8', 'Cost Optimization', 'How do you plan for data transfer charges?', 'data transfer is planned and charged to its owner', []],
  ['COST 9', 'Cost Optimization', 'How do you manage demand, and supply resources?', 'supply follows demand', ['AWS-PERF-003', ...qa('COST-05')]],
  ['COST 10', 'Cost Optimization', 'How do you evaluate new services?', 'new services are reviewed for cost and fit', []],
  ['COST 11', 'Cost Optimization', 'How do you evaluate the cost of effort?', 'the cost of people\'s time is weighed against savings', []],
  ['SUS 1', 'Sustainability', 'How do you select Regions for your workload?', 'regions are chosen with environmental impact in mind', qa('SUS-01')],
  ['SUS 2', 'Sustainability', 'How do you align cloud resources to your demand?', 'resources match demand and are not idle', ['AWS-PERF-003', ...qa('SUS-05')]],
  ['SUS 3', 'Sustainability', 'How do you take advantage of software and architecture patterns to support your sustainability goals?', 'efficient patterns reduce the resources needed', ['AWS-SUS-001', 'AWS-SUS-002', ...qa('SUS-04')]],
  ['SUS 4', 'Sustainability', 'How do you take advantage of data management policies and patterns to support your sustainability goals?', 'data is kept only as long as it is needed', ['AWS-S3-006', 'AWS-COST-003', ...qa('SUS-03')]],
  ['SUS 5', 'Sustainability', 'How do you select and use cloud hardware and services in your architecture to support your sustainability goals?', 'efficient hardware and managed services are preferred', ['AWS-SUS-001', 'AWS-SUS-002', ...qa('SUS-04')]],
  ['SUS 6', 'Sustainability', 'How do your organizational processes support your sustainability goals?', 'sustainability is measured and part of how work is done', qa('SUS-02')],
];

export function awsDefs(): ControlDef[] {
  return AWS_ROWS.map(([id, pillar, title, area, rules, platform]) => ({
    id, group: pillar, title, ownerRole: OWNER[pillar], activity: `In place when ${area}.`,
    evidence: [`Something that shows ${area}: a configuration export, a written standard or a dated record`], rules, platform,
    effect: `Weakens the ${pillar} pillar of the AWS Well-Architected Framework.`,
  }));
}

// ── Azure Well-Architected Framework ──────────────────────────────────────
const AZ_OWNER: Record<string, string> = { reliability: 'Engineering lead', security: 'Security lead', cost_optimization: 'FinOps lead', operational_excellence: 'Cloud operations lead', performance_efficiency: 'Architecture lead' };

export function azureDefs(): ControlDef[] {
  return AZURE_CHECKLIST.map((i) => ({
    id: i.code, group: AZURE_PILLAR_LABEL[i.pillar], title: i.title, ownerRole: AZ_OWNER[i.pillar] ?? 'Architecture lead', activity: 'Followed when the design and the way the team works match Microsoft\'s recommendation.',
    evidence: ['A configuration export, a written standard or a dated record that shows the recommendation is followed'], rules: [...i.evidence],
    effect: `Weakens the ${AZURE_PILLAR_LABEL[i.pillar]} pillar of the Azure Well-Architected Framework.`,
  }));
}

export function defsFor(framework: FrameworkId, soc2Categories?: readonly Soc2Category[]): ControlDef[] {
  return framework === 'soc2' ? soc2Defs(soc2Categories) : framework === 'aws-waf' ? awsDefs() : azureDefs();
}
