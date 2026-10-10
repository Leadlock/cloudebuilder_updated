/**
 * Well-Architected review fixes:
 *  - a rule counts once in a score however many resources it is checked on (scores no longer drift toward "Strong" as a design grows);
 *  - VPC DNS is a Reliability check, not Operational Excellence;
 *  - a placeholder certificate is still a pass but is called a placeholder;
 *  - new checks for load balancer / CDN / web ACL visibility and for Performance, Sustainability and Cost;
 *  - the ALB and CloudFront logging settings reach the generated Terraform, with the bucket name validated;
 *  - pillar cards say how many different checks they rest on and flag thin ones;
 *  - the unwired live providers are gone.
 */
import { existsSync } from 'fs';
import path from 'path';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { ALL_RULES, RULES_BY_ID } from '@/lib/engines/assessment/rules';
import { scoreOf, THIN_PILLAR_RULES } from '@/lib/engines/assessment/scoring';
import type { Evaluation } from '@/lib/engines/assessment/types';
import { getResourceDefinition } from '@/lib/resources';
import { WellArchitectedRuleEngine } from '@/lib/engines/wellArchitected/WellArchitectedRuleEngine';
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';
import type { CanvasNode } from '@/types';

const ev = (ruleId: string, status: Evaluation['status'], severity: Evaluation['severity'] = 'MEDIUM'): Evaluation => ({
  findingId: `${ruleId}-${Math.random()}`, ruleId, ruleVersion: '1', provider: 'aws', resourceIds: [], resourceLabels: [], status, severity,
  observation: '', evidence: [], provenance: 'DESIGN_TIME',
});
const many = (ruleId: string, n: number, status: Evaluation['status'], severity: Evaluation['severity'] = 'MEDIUM') => Array.from({ length: n }, () => ev(ruleId, status, severity));

function node(id: string, resourceType: string, config: Record<string, unknown> = {}, extra: Partial<CanvasNode> = {}): CanvasNode {
  const def = getResourceDefinition(resourceType)!;
  return { id, type: 'cloudNode', resourceType, provider: resourceType.startsWith('azure_') ? 'azure' : 'aws', label: id, position: { x: 0, y: 0 }, config: { ...def.defaultConfig, ...config }, ...extra } as CanvasNode;
}
const statusOf = (nodes: CanvasNode[], ruleId: string, edges: { id: string; source: string; target: string }[] = []) =>
  runAssessment({ nodes, edges: edges as never }).evaluations.filter((e) => e.ruleId === ruleId).map((e) => e.status);

describe('scoring: a rule counts once however many resources it is checked on', () => {
  test('one failing rule is not hidden by many passing checks of other resources', () => {
    // 60 subnets all pass rule A; one resource fails rule B (both MEDIUM). Per rule, half the weight fails: 50, not ~98.
    const s = scoreOf([...many('A', 60, 'PASS'), ev('B', 'FAIL')]);
    expect(s.score).toBe(50);
  });

  test('a design with more resources does not score better for the same failures', () => {
    const small = scoreOf([...many('A', 2, 'PASS'), ev('B', 'FAIL')]).score;
    const large = scoreOf([...many('A', 200, 'PASS'), ev('B', 'FAIL')]).score;
    expect(large).toBe(small);
  });

  test('failure inside one rule is proportional: one failing subnet of four is a quarter of that rule', () => {
    // rule A (MEDIUM, weight 3) fails on 1 of 4 resources; rule B (MEDIUM) passes: failed 0.75 of total 6
    const s = scoreOf([...many('A', 3, 'PASS'), ev('A', 'FAIL'), ev('B', 'PASS')]);
    expect(s.score).toBe(88); // 100 * (1 - 0.75/6) = 87.5
  });

  test('a rule evaluated on one resource scores exactly as before, and warnings still count half', () => {
    expect(scoreOf([ev('A', 'PASS'), ev('B', 'FAIL')]).score).toBe(50);
    expect(scoreOf([ev('A', 'PASS'), ev('B', 'WARNING')]).score).toBe(75);
  });

  test('critical and high caps still apply however many checks pass', () => {
    expect(scoreOf([...many('A', 100, 'PASS', 'HIGH'), ev('B', 'FAIL', 'CRITICAL')]).score).toBeLessThanOrEqual(40);
    expect(scoreOf([...many('A', 100, 'PASS', 'HIGH'), ev('B', 'FAIL', 'HIGH')]).score).toBeLessThanOrEqual(70);
  });

  test('the published methodology says so', () => {
    expect(scoreOf([ev('A', 'PASS')]).methodology).toMatch(/counts once however many resources/);
  });
});

describe('pillar placement', () => {
  test('VPC DNS resolution is a Reliability check', () => {
    const r = RULES_BY_ID.get('AWS-VPC-003')!;
    expect(r.wellArchitected.pillar).toBe('reliability');
    expect(r.domain).toBe('RELIABILITY');
  });

  test('every rule\'s domain still matches its Well-Architected pillar', () => {
    const domainToPillar: Record<string, string> = { SECURITY: 'security', RELIABILITY: 'reliability', PERFORMANCE_EFFICIENCY: 'performance_efficiency', COST_OPTIMIZATION: 'cost_optimization', OPERATIONAL_EXCELLENCE: 'operational_excellence', SUSTAINABILITY: 'sustainability' };
    for (const r of ALL_RULES) expect([r.id, domainToPillar[r.domain]]).toEqual([r.id, r.wellArchitected.pillar]);
  });

  test('the thin pillars now have real, scorable checks', () => {
    const scorable = (provider: string, pillar: string) => ALL_RULES.filter((r) => r.provider === provider && r.wellArchitected.pillar === pillar && r.severity !== 'INFORMATIONAL').length;
    expect(scorable('aws', 'performance_efficiency')).toBeGreaterThanOrEqual(4);
    expect(scorable('aws', 'cost_optimization')).toBeGreaterThanOrEqual(4);
    expect(scorable('aws', 'sustainability')).toBeGreaterThanOrEqual(1);
    expect(scorable('azure', 'performance_efficiency')).toBeGreaterThanOrEqual(5);
  });

  test('every new rule is LOW and manual-only, so none blocks a deployment or changes a design on its own', () => {
    const added = ['AWS-ELB-005', 'AWS-CF-003', 'AWS-WAF-002', 'AWS-PERF-001', 'AWS-PERF-002', 'AWS-PERF-003', 'AWS-PERF-004', 'AWS-SUS-002', 'AWS-COST-002', 'AWS-COST-003', 'AZ-APP-020', 'AZ-APP-021', 'AZ-AFD-010', 'AZ-VMSS-010', 'AZ-AGW-010'];
    for (const id of added) {
      const r = RULES_BY_ID.get(id)!;
      expect([id, r.severity]).toEqual([id, 'LOW']);
      expect([id, r.autoFix]).toEqual([id, undefined]);
    }
  });
});

describe('ALB certificate placeholder', () => {
  const alb = (certificateArn: string) => runAssessment({ nodes: [node('alb', 'aws_alb', { listenerProtocol: 'HTTPS', certificateArn })], edges: [] }).evaluations.find((e) => e.ruleId === 'AWS-ELB-001')!;

  test('a placeholder is still a pass (so generated designs are not blocked) but is called a placeholder', () => {
    const e = alb('arn:aws:acm:us-east-1:123456789012:certificate/REPLACE-WITH-YOUR-CERTIFICATE-ID');
    expect(e.status).toBe('PASS');
    expect(e.observation).toMatch(/placeholder/i);
  });

  test('a real-looking ARN keeps the plain message', () => {
    const e = alb('arn:aws:acm:us-east-1:111122223333:certificate/0a1b2c3d-1111-2222-3333-444455556666');
    expect(e.status).toBe('PASS');
    expect(e.observation).not.toMatch(/placeholder/i);
  });
});

describe('new AWS checks', () => {
  const cases: [string, string, Record<string, unknown>, Record<string, unknown>, string][] = [
    // [rule, resource type, setting that breaks it, setting that satisfies it, status when broken]
    ['AWS-ELB-005', 'aws_alb', { accessLogsEnabled: false }, { accessLogsEnabled: true, accessLogsBucket: 'my-alb-logs' }, 'FAIL'],
    ['AWS-CF-003', 'aws_cloudfront', { loggingEnabled: false }, { loggingEnabled: true, loggingBucket: 'my-cf-logs' }, 'FAIL'],
    ['AWS-WAF-002', 'aws_waf', { cloudWatchMetricsEnabled: false }, { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true }, 'FAIL'],
    ['AWS-PERF-001', 'aws_cloudfront', { compressionEnabled: false }, { compressionEnabled: true }, 'WARNING'],
    ['AWS-PERF-002', 'aws_cloudfront', { httpVersion: 'http1.1' }, { httpVersion: 'http2and3' }, 'WARNING'],
    ['AWS-PERF-003', 'aws_auto_scaling', { scalingPolicyEnabled: false }, { scalingPolicyEnabled: true }, 'WARNING'],
    ['AWS-PERF-004', 'aws_rds', { enablePerformanceInsights: false }, { enablePerformanceInsights: true }, 'FAIL'],
    ['AWS-SUS-002', 'aws_auto_scaling', { instanceType: 'm5.large' }, { instanceType: 'm6g.large' }, 'WARNING'],
    ['AWS-SUS-002', 'aws_rds', { instanceClass: 'db.m5.large' }, { instanceClass: 'db.m6g.large' }, 'WARNING'],
    ['AWS-COST-002', 'aws_sqs', { receiveWaitTimeSeconds: 0 }, { receiveWaitTimeSeconds: 20 }, 'WARNING'],
    ['AWS-COST-003', 'aws_cloudwatch', { logRetentionDays: 0 }, { logRetentionDays: 90 }, 'WARNING'],
    ['AWS-COST-003', 'aws_ecs', { logRetentionDays: 0 }, { logRetentionDays: 30 }, 'WARNING'],
  ];

  test.each(cases)('%s on %s: raised when %j, passes when %j', (ruleId, type, bad, good, badStatus) => {
    expect(statusOf([node('r', type, bad)], ruleId)).toEqual([badStatus]);
    expect(statusOf([node('r', type, good)], ruleId)).toEqual(['PASS']);
  });

  test('access logging is for Application Load Balancers only', () => {
    expect(statusOf([node('nlb', 'aws_alb', { lbType: 'network', accessLogsEnabled: false })], 'AWS-ELB-005')).toEqual(['NOT_APPLICABLE']);
  });

  test('logging switched on with no valid bucket is a warning, never a pass', () => {
    expect(statusOf([node('alb', 'aws_alb', { accessLogsEnabled: true, accessLogsBucket: '' })], 'AWS-ELB-005')).toEqual(['WARNING']);
    expect(statusOf([node('cf', 'aws_cloudfront', { loggingEnabled: true, loggingBucket: 'Not A Bucket!' })], 'AWS-CF-003')).toEqual(['WARNING']);
  });

  test('a design saved before the logging settings existed reads them as "not enabled", not as missing data', () => {
    const old = node('alb', 'aws_alb');
    delete old.config['accessLogsEnabled'];
    delete old.config['accessLogsBucket'];
    expect(statusOf([old], 'AWS-ELB-005')).toEqual(['FAIL']);
  });

  test('Graviton check: x86 warns, Graviton passes, Windows and unknown families do not apply', () => {
    expect(statusOf([node('e', 'aws_ec2', { instanceType: 't3.medium', os: 'Ubuntu 24.04 LTS' })], 'AWS-SUS-002')).toEqual(['WARNING']);
    expect(statusOf([node('e', 'aws_ec2', { instanceType: 't4g.medium' })], 'AWS-SUS-002')).toEqual(['PASS']);
    expect(statusOf([node('e', 'aws_ec2', { instanceType: 't3.medium', os: 'Windows Server 2022' })], 'AWS-SUS-002')).toEqual(['NOT_APPLICABLE']);
    expect(statusOf([node('e', 'aws_ec2', { instanceType: 'g5.xlarge' })], 'AWS-SUS-002')).toEqual(['NOT_APPLICABLE']);
  });
});

describe('new Azure checks', () => {
  const cases: [string, string, Record<string, unknown>, Record<string, unknown>][] = [
    ['AZ-APP-020', 'azure_app_service', { http2Enabled: false }, { http2Enabled: true }],
    ['AZ-APP-021', 'azure_app_service', { alwaysOn: false }, { alwaysOn: true }],
    ['AZ-AFD-010', 'azure_front_door', { cachingEnabled: false }, { cachingEnabled: true }],
    ['AZ-VMSS-010', 'azure_vmss', { autoscaleEnabled: false }, { autoscaleEnabled: true }],
    ['AZ-AGW-010', 'azure_app_gateway', { autoscaleEnabled: false }, { autoscaleEnabled: true }],
  ];
  test.each(cases)('%s on %s: warns when %j, passes when %j', (ruleId, type, bad, good) => {
    expect(statusOf([node('r', type, bad)], ruleId)).toEqual(['WARNING']);
    expect(statusOf([node('r', type, good)], ruleId)).toEqual(['PASS']);
  });
});

describe('generated Terraform for the new logging settings', () => {
  const row = (id: string, resourceType: string, config: Record<string, unknown>): DbArchitectureResource => ({
    id, resourceType, provider: 'aws', label: id, positionX: 0, positionY: 0, configJson: JSON.stringify({ name: id, ...config }), region: null, groupId: null, locked: false, architectureId: 'a',
  } as DbArchitectureResource);
  const main = (resources: DbArchitectureResource[]) => new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections: [] })
    .files.map((f) => f.content).join('\n');

  test('an ALB with access logs and a valid bucket gets an access_logs block', () => {
    const tf = main([row('web_alb', 'aws_alb', { accessLogsEnabled: true, accessLogsBucket: 'my-alb-logs' })]);
    expect(tf).toMatch(/access_logs \{\s+bucket\s+= "my-alb-logs"\s+prefix\s+= "[^"]+"\s+enabled = true\s+\}/);
  });

  test('with logging off, or no valid bucket, there is no access_logs block (and a bad name cannot reach the HCL)', () => {
    expect(main([row('web_alb', 'aws_alb', { accessLogsEnabled: false, accessLogsBucket: 'my-alb-logs' })])).not.toContain('access_logs {');
    const evil = main([row('web_alb', 'aws_alb', { accessLogsEnabled: true, accessLogsBucket: 'x"\n}\nresource "aws_iam_user" "evil" {' })]);
    expect(evil).not.toContain('access_logs {');
    expect(evil).not.toContain('aws_iam_user');
    expect(evil).toMatch(/WARNING: access logs are enabled but no valid S3 bucket name/);
  });

  test('a CloudFront distribution with logging and a valid bucket gets a logging_config block', () => {
    const tf = main([row('cdn', 'aws_cloudfront', { loggingEnabled: true, loggingBucket: 'my-cf-logs' })]);
    expect(tf).toMatch(/logging_config \{\s+bucket\s+= "my-cf-logs\.s3\.amazonaws\.com"/);
    expect(main([row('cdn', 'aws_cloudfront', { loggingEnabled: true, loggingBucket: 'BAD NAME' })])).not.toContain('logging_config {');
  });
});

describe('pillar cards say how many different checks they rest on', () => {
  const awsDesign = () => ({
    nodes: [
      node('vpc', 'aws_vpc'),
      node('sub', 'aws_subnet', {}, { parentId: 'vpc' }), node('sub2', 'aws_subnet', {}, { parentId: 'vpc' }), node('sub3', 'aws_subnet', {}, { parentId: 'vpc' }),
      node('db', 'aws_rds'), node('bucket', 'aws_s3'), node('alb', 'aws_alb'), node('sg', 'aws_sg'),
    ],
    edges: [],
  });

  test('counts different rules, not resources (three subnets are one check)', () => {
    const wa = new WellArchitectedRuleEngine().analyze({ architectureId: 'a', ...awsDesign() });
    const security = wa.pillarScores.find((p) => p.pillar === 'security')!;
    expect(security.evaluatedChecks).toBeGreaterThan(security.evaluatedRules!);
    expect(security.evaluatedRules).toBeGreaterThanOrEqual(THIN_PILLAR_RULES);
    expect(security.limitedEvidence).toBe(false);
  });

  test('a pillar resting on fewer than five checks is flagged as limited evidence', () => {
    const wa = new WellArchitectedRuleEngine().analyze({ architectureId: 'a', ...awsDesign() });
    const cost = wa.pillarScores.find((p) => p.pillar === 'cost_optimization')!;
    expect(cost.evaluatedRules).toBeLessThan(THIN_PILLAR_RULES);
    expect(cost.limitedEvidence).toBe(true);
    // a pillar with nothing evaluated is also limited
    const none = new WellArchitectedRuleEngine().analyze({ architectureId: 'a', nodes: [node('vpc', 'aws_vpc')], edges: [] });
    expect(none.pillarScores.find((p) => p.pillar === 'sustainability')?.evaluatedRules).toBe(0);
    expect(none.pillarScores.find((p) => p.pillar === 'sustainability')?.limitedEvidence).toBe(true);
  });

  test('both clouds report the counts', () => {
    const wa = new WellArchitectedRuleEngine().analyze({ architectureId: 'a', nodes: [...awsDesign().nodes, node('app', 'azure_app_service')], edges: [] });
    expect(wa.provider).toBe('multi');
    for (const p of wa.pillarScores) expect(typeof p.evaluatedRules).toBe('number');
  });
});

describe('the unwired live providers are gone', () => {
  const root = path.resolve(__dirname, '..');
  test.each(['AwsWellArchitectedProvider.ts', 'AzureAdvisorProvider.ts'])('%s no longer exists', (file) => {
    expect(existsSync(path.join(root, 'lib/engines/wellArchitected/providers', file))).toBe(false);
  });

  test('the service only does design-time analysis', async () => {
    const mod = await import('@/lib/engines/wellArchitected/WellArchitectedFrameworkService');
    const svc = mod.wellArchitectedFrameworkService as unknown as Record<string, unknown>;
    expect(typeof svc['analyzeDesignTime']).toBe('function');
    for (const gone of ['fetchAwsLiveAssessment', 'fetchAzureLiveAssessment', 'mergeAssessments']) expect(svc[gone]).toBeUndefined();
  });
});
