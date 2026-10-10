/**
 * Live account evidence (CloudTrail, GuardDuty, root MFA, AWS Config) and VPC flow logs.
 *
 *  - the reader turns AWS answers into PASS / WARNING / FAIL, and a refused or failed read into UNAVAILABLE (never a pass);
 *  - the rules use only fresh readings, mark them LIVE_VERIFIED, and leave everything else NOT EVALUATED;
 *  - VPC flow logs are evaluated from the VPC's settings and written into Terraform.
 */
import { readAwsAccountControls, type AccountControlClients } from '@/lib/cloud/accountControls/readAwsAccountControls';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import type { AccountEvidenceMap } from '@/lib/engines/assessment/accountEvidence';
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';
import { getResourceDefinition } from '@/lib/resources';
import type { CanvasNode } from '@/types';

// ─── reader ──────────────────────────────────────────────────────────────────

const denied = () => Object.assign(new Error('nope'), { name: 'AccessDeniedException' });
const byCommand = (table: Record<string, unknown>) => ({
  send: async (c: unknown) => {
    const name = (c as { constructor: { name: string } }).constructor.name;
    const v = table[name];
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error(`unexpected ${name}`);
    return v;
  },
});
const healthy = {
  DescribeTrailsCommand: { trailList: [{ IsMultiRegionTrail: true, TrailARN: 'arn:t', LogFileValidationEnabled: true }] },
  GetTrailStatusCommand: { IsLogging: true },
  ListDetectorsCommand: { DetectorIds: ['d1'] },
  GetDetectorCommand: { Status: 'ENABLED' },
  GetAccountSummaryCommand: { SummaryMap: { AccountMFAEnabled: 1 } },
  DescribeConfigurationRecordersCommand: { ConfigurationRecorders: [{ recordingGroup: { allSupported: true } }] },
  DescribeConfigurationRecorderStatusCommand: { ConfigurationRecordersStatus: [{ recording: true }] },
};
const clientsFor = (t: Record<string, unknown>): AccountControlClients => ({
  cloudtrail: byCommand(t), iam: byCommand(t), guardduty: () => byCommand(t), config: () => byCommand(t),
});
const get = (rs: Awaited<ReturnType<typeof readAwsAccountControls>>, id: string) => rs.find((r) => r.controlId === id)!;

describe('readAwsAccountControls', () => {
  test('a healthy account passes all four controls', async () => {
    const rs = await readAwsAccountControls(clientsFor(healthy), ['us-east-1']);
    expect(rs.map((r) => r.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
  });

  test('clear negatives are FAIL; log file validation off is only a WARNING', async () => {
    const rs = await readAwsAccountControls(clientsFor({
      ...healthy,
      DescribeTrailsCommand: { trailList: [{ IsMultiRegionTrail: true, TrailARN: 'arn:t', LogFileValidationEnabled: false }] },
      ListDetectorsCommand: { DetectorIds: [] },
      GetAccountSummaryCommand: { SummaryMap: { AccountMFAEnabled: 0 } },
      DescribeConfigurationRecordersCommand: { ConfigurationRecorders: [] },
    }), ['us-east-1']);
    expect(get(rs, 'AWS-ACCT-001').status).toBe('WARNING');
    expect(get(rs, 'AWS-ACCT-002').status).toBe('FAIL');
    expect(get(rs, 'AWS-ACCT-003').status).toBe('FAIL');
    expect(get(rs, 'AWS-ACCT-004').status).toBe('FAIL');
  });

  test('a refused read is UNAVAILABLE and names the permission, and never hides the other controls', async () => {
    const rs = await readAwsAccountControls(clientsFor({ ...healthy, GetAccountSummaryCommand: denied() }), ['us-east-1']);
    const mfa = get(rs, 'AWS-ACCT-003');
    expect(mfa.status).toBe('UNAVAILABLE');
    expect(mfa.observation).toContain('iam:GetAccountSummary');
    expect(get(rs, 'AWS-ACCT-001').status).toBe('PASS');
  });

  test('a gap in one Region stays a FAIL even when another Region cannot be read', async () => {
    const clients: AccountControlClients = {
      ...clientsFor(healthy),
      guardduty: (region) => byCommand(region === 'eu-west-1' ? { ...healthy, ListDetectorsCommand: { DetectorIds: [] } } : { ...healthy, ListDetectorsCommand: denied() }),
    };
    const rs = await readAwsAccountControls(clients, ['eu-west-1', 'us-east-1']);
    expect(get(rs, 'AWS-ACCT-002').status).toBe('FAIL');
  });
});

// ─── rules ───────────────────────────────────────────────────────────────────

function node(id: string, resourceType: string, config: Record<string, unknown> = {}): CanvasNode {
  const def = getResourceDefinition(resourceType)!;
  return { id, type: 'cloudNode', resourceType, provider: 'aws', label: id, position: { x: 0, y: 0 }, config: { ...def.defaultConfig, ...config } } as CanvasNode;
}
const NOW = '2026-10-10T12:00:00.000Z';
const reading = (status: 'PASS' | 'FAIL' | 'UNAVAILABLE', observedAt = '2026-10-09T12:00:00.000Z') => ({ status, observation: `reading ${status}`, observedAt, accountLabel: 'prod' });
function evalOf(ruleId: string, accountEvidence: AccountEvidenceMap | undefined, nodes = [node('vpc', 'aws_vpc')]) {
  const r = runAssessment({ nodes, edges: [], accountEvidence, evaluatedAt: NOW });
  return r.evaluations.find((e) => e.ruleId === ruleId)!;
}

describe('account control rules', () => {
  test('without a reading the control is NOT EVALUATED', () => {
    expect(evalOf('AWS-ACCT-003', undefined).status).toBe('NOT_EVALUATED');
  });
  test('a fresh PASS counts and is LIVE_VERIFIED', () => {
    const e = evalOf('AWS-ACCT-003', { 'AWS-ACCT-003': reading('PASS') });
    expect(e.status).toBe('PASS');
    expect(e.provenance).toBe('LIVE_VERIFIED');
  });
  test('a fresh FAIL is a finding', () => {
    expect(evalOf('AWS-ACCT-003', { 'AWS-ACCT-003': reading('FAIL') }).status).toBe('FAIL');
  });
  test('a reading older than 7 days is not relied on', () => {
    expect(evalOf('AWS-ACCT-003', { 'AWS-ACCT-003': reading('PASS', '2026-09-01T00:00:00.000Z') }).status).toBe('NOT_EVALUATED');
  });
  test('an unreadable control stays NOT EVALUATED, never a pass', () => {
    expect(evalOf('AWS-ACCT-003', { 'AWS-ACCT-003': reading('UNAVAILABLE') }).status).toBe('NOT_EVALUATED');
  });
});

// ─── flow logs ───────────────────────────────────────────────────────────────

describe('VPC flow logs', () => {
  test('off is flagged; on with a bucket passes', () => {
    expect(['FAIL', 'WARNING']).toContain(evalOf('AWS-VPC-002', undefined, [node('vpc', 'aws_vpc', { flowLogsEnabled: false })]).status);
    expect(evalOf('AWS-VPC-002', undefined, [node('vpc', 'aws_vpc', { flowLogsEnabled: true, flowLogsBucket: 'my-flow-logs-bucket' })]).status).toBe('PASS');
  });

  const res = (config: Record<string, unknown>): DbArchitectureResource => ({
    id: 'vpc', resourceType: 'aws_vpc', provider: 'aws', label: 'main_vpc', positionX: 0, positionY: 0, configJson: JSON.stringify({ name: 'main_vpc', ...config }),
    region: null, groupId: null, locked: false, architectureId: 'a',
  } as DbArchitectureResource);
  const tf = (config: Record<string, unknown>) =>
    new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources: [res(config)], connections: [] }).files.find((f) => f.filename === 'main.tf')!.content;

  test('Terraform writes an S3 flow log only for a valid bucket', () => {
    expect(tf({ flowLogsEnabled: true, flowLogsBucket: 'my-flow-logs-bucket' })).toContain('arn:aws:s3:::my-flow-logs-bucket');
    const bad = tf({ flowLogsEnabled: true, flowLogsBucket: 'Not A Bucket!' });
    expect(bad).not.toContain('resource "aws_flow_log"');
    expect(bad).toContain('WARNING: VPC Flow Logs');
    expect(tf({ flowLogsEnabled: false })).not.toContain('aws_flow_log');
  });
});
