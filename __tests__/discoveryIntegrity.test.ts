/**
 * Discovery data integrity: when a provider API does not return a setting, discovery must
 * record it as UNKNOWN (absent) — never as a default that later reads as PASS or FAIL.
 * Runs the real adapters with SDK clients stubbed to return responses that omit fields,
 * then the real normalizer and assessment engine.
 */
jest.mock('@azure/arm-storage', () => ({
  StorageManagementClient: jest.fn().mockImplementation(() => ({
    storageAccounts: {
      list: async function* () {
        yield { id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/stunknown', name: 'stunknown', location: 'eastus', sku: { name: 'Standard_LRS' }, kind: 'StorageV2' };
        yield { id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/sthttps', name: 'sthttps', location: 'eastus', enableHttpsTrafficOnly: true };
      },
    },
  })),
}));

import { AwsDiscoveryAdapter } from '@/lib/cloud/adapters/awsAdapter';
import { AzureDiscoveryAdapter } from '@/lib/cloud/adapters/azureAdapter';
import { normalizeDiscoveredInfrastructure } from '@/lib/cloud/normalizer';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import type { CloudResource } from '@/lib/cloud/discovery/types';

type Priv = Record<string, (...a: unknown[]) => Promise<CloudResource[]>>;
const stubClient = (responses: Record<string, unknown>) => ({
  send: jest.fn(async (cmd: { constructor: { name: string } }) => responses[cmd.constructor.name] ?? {}),
});

function awsAdapterWith(responses: Record<string, unknown>) {
  const a = new AwsDiscoveryAdapter({ roleArn: 'arn:aws:iam::111122223333:role/x', externalId: 'e', region: 'us-east-1' } as never);
  const client = stubClient(responses);
  for (const m of ['_makeEc2Client', '_makeRdsClient', '_makeEksClient', '_makeElastiCacheClient', '_makeCloudFrontClient']) {
    (a as unknown as Record<string, unknown>)[m] = async () => client;
  }
  return a as unknown as Priv;
}

describe('AWS discovery never invents security state', () => {
  test('RDS: missing PubliclyAccessible / MultiAZ / StorageEncrypted stay unknown', async () => {
    const a = awsAdapterWith({ DescribeDBInstancesCommand: { DBInstances: [{ DBInstanceIdentifier: 'db1', DBInstanceArn: 'arn:aws:rds:us-east-1:111122223333:db:db1', Engine: 'postgres' }] } });
    const [res] = await a._discoverRdsInstances('us-east-1', '111122223333');
    expect(res.configuration.publiclyAccessible).toBeUndefined();
    expect(res.configuration.multiAz).toBeUndefined();
    expect(res.status).toBe('unknown');

    const { nodes } = normalizeDiscoveredInfrastructure([res], []);
    const disc = nodes[0].config._discovery as { values: Record<string, unknown> };
    expect(disc.values).not.toHaveProperty('publiclyAccessible');
    expect(disc.values.engine).toBe('postgres');

    const a2 = runAssessment({ nodes, edges: [] });
    const rds1 = a2.evaluations.find((e) => e.ruleId === 'AWS-RDS-001')!;
    expect(rds1.status).toBe('INSUFFICIENT_DATA');
    expect(rds1.observation).toMatch(/Discovery did not return/);
  });

  test('EBS: a volume without an Encrypted flag is not assumed encrypted', async () => {
    const a = awsAdapterWith({ DescribeVolumesCommand: { Volumes: [{ VolumeId: 'vol-1', Size: 20 }] } });
    const [res] = await a._discoverVolumes('us-east-1', '111122223333');
    expect(res.configuration.encrypted).toBeUndefined();
    const { nodes } = normalizeDiscoveredInfrastructure([res], []);
    expect(runAssessment({ nodes, edges: [] }).evaluations.find((e) => e.ruleId === 'AWS-EBS-001')!.status).toBe('INSUFFICIENT_DATA');
  });

  test('VPC: DNS attributes (not returned by DescribeVpcs) are unknown, not "enabled"', async () => {
    const a = awsAdapterWith({ DescribeVpcsCommand: { Vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16' }] } });
    const [res] = await a._discoverVpcs('us-east-1', '111122223333');
    expect(res.configuration.enableDnsSupport).toBeUndefined();
    expect(res.configuration.enableDnsHostnames).toBeUndefined();
  });

  test('explicit API values are kept exactly (false stays false)', async () => {
    const a = awsAdapterWith({ DescribeDBInstancesCommand: { DBInstances: [{ DBInstanceIdentifier: 'db2', DBInstanceArn: 'arn:aws:rds:us-east-1:111122223333:db:db2', Engine: 'mysql', PubliclyAccessible: true, MultiAZ: false, StorageEncrypted: false }] } });
    const [res] = await a._discoverRdsInstances('us-east-1', '111122223333');
    expect(res.configuration.publiclyAccessible).toBe(true);
    expect(res.configuration.multiAz).toBe(false);
    expect(res.configuration.encrypted).toBe(false);
    const { nodes } = normalizeDiscoveredInfrastructure([res], []);
    const e = runAssessment({ nodes, edges: [] }).evaluations.find((x) => x.ruleId === 'AWS-RDS-001')!;
    expect(e.status).toBe('FAIL');
    expect(e.provenance).toBe('DISCOVERED_CONFIGURATION');
  });
});

describe('Azure discovery never invents security state', () => {
  test('storage: enableHttpsTrafficOnly absent → unknown; present → discovered', async () => {
    const a = new AzureDiscoveryAdapter({ tenantId: 't', clientId: 'c', clientSecret: 's', subscriptionId: 's' } as never) as unknown as Priv;
    const res = await a._discoverStorageAccounts({} as never);
    const unknown = res.find((r) => r.name === 'stunknown')!;
    const https = res.find((r) => r.name === 'sthttps')!;
    expect(unknown.configuration.httpsOnly).toBeUndefined();
    expect(unknown.status).toBe('unknown');
    expect(https.configuration.httpsOnly).toBe(true);

    const { nodes } = normalizeDiscoveredInfrastructure(res, []);
    const a2 = runAssessment({ nodes, edges: [] });
    const byName = (n: string) => a2.evaluations.find((e) => e.ruleId === 'AZ-STG-001' && e.resourceLabels[0] === n)!;
    expect(byName('stunknown').status).toBe('INSUFFICIENT_DATA');
    expect(byName('sthttps').status).toBe('PASS');
    expect(byName('sthttps').provenance).toBe('DISCOVERED_CONFIGURATION');
  });
});

describe('No adapter literal fallbacks for configuration values', () => {
  // Static guard: `key: <api value> ?? <literal>,` inside adapter config objects invents a
  // discovered value. Identity/display fields and empty-list defaults are allowed.
  const fs = jest.requireActual('fs') as typeof import('fs');
  test.each(['lib/cloud/adapters/awsAdapter.ts', 'lib/cloud/adapters/azureAdapter.ts'])('%s', (file) => {
    const allowed = /^(tags|name|label|comment|description|displayName|resourceGroup|location|region|subscriptionId|accountId|dnsPrefix|kubernetesVersion|status)$/;
    const offenders = fs.readFileSync(file, 'utf8').split('\n')
      .map((l, i) => ({ l, i: i + 1, m: l.match(/^\s+([a-zA-Z]+):\s+.+\?\?\s*('[^']*'|\d+|true|false)\s*,/) }))
      .filter((x) => x.m && !allowed.test(x.m[1]))
      .map((x) => `${x.i}: ${x.l.trim()}`);
    expect(offenders).toEqual([]);
  });
});
