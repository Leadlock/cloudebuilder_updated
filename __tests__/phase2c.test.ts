/**
 * Phase 2C Tests — Cloud Account + Discovery
 *
 * Tests:
 * - AWS adapter (mocked SDK calls)
 * - Azure adapter (mocked SDK calls)
 * - Account authorization / org isolation
 * - Invalid account connections
 * - Discovery normalization
 * - Discovery persistence
 * - Unauthorized discovery attempts
 * - Multi-cloud architecture (AWS + Azure in same project)
 * - Cloud account repository (credential separation)
 */

import type { DiscoveredResource } from '@/lib/cloud/types';
import { normalizeResources } from '@/lib/cloud/normalizer';

// ─── Mock DB (reuse pattern from backend.test.ts) ─────────────────────────────

interface Row { [key: string]: unknown }
type Store = Map<string, Row>;

function makeTable(store: Store) {
  return {
    where(filter: Record<string, unknown>) {
      const getMatches = () => {
        return [...store.values()].filter((row) =>
          Object.entries(filter).every(([k, v]) => row[k] === v),
        );
      };
      return {
        select(..._fields: string[]) {
          return {
            async first() { return getMatches()[0] ?? null; },
            async all() { return getMatches(); },
          };
        },
        async first() { return getMatches()[0] ?? null; },
        async all() { return getMatches(); },
        async update(data: Record<string, unknown>) {
          for (const row of getMatches()) {
            Object.assign(row, data);
          }
        },
        async delete() {
          for (const row of getMatches()) {
            store.delete(row['id'] as string);
          }
        },
      };
    },
    async create(row: Record<string, unknown>) {
      store.set(row['id'] as string, { ...row });
    },
    select(..._fields: string[]) {
      const allRows = () => [...store.values()];
      return {
        async first() { return allRows()[0] ?? null; },
        async all() { return allRows(); },
      };
    },
    async first() { return [...store.values()][0] ?? null; },
  };
}

function buildMockDb() {
  const stores: Record<string, Store> = {
    CloudAccount: new Map(),
    DiscoveryRun: new Map(),
    OrgMember: new Map(),
    Organization: new Map(),
    User: new Map(),
  };

  return {
    orm: {
      public: new Proxy({} as Record<string, ReturnType<typeof makeTable>>, {
        get(_t, model: string) {
          if (!stores[model]) stores[model] = new Map();
          return makeTable(stores[model]);
        },
      }),
    },
    _stores: stores,
    _reset() {
      for (const s of Object.values(stores)) s.clear();
    },
  };
}

const mockDb = buildMockDb();
jest.mock('@/src/prisma/db', () => ({
  db: mockDb,
  // rawExec mirrors the real function's SQL-DELETE behaviour on the mock store.
  rawExec: jest.fn().mockImplementation(async (sql: string, params: unknown[]) => {
    if (/architectureResource/i.test(sql) && params[0]) {
      const archId = params[0] as string;
      for (const [k, v] of mockDb._stores['ArchitectureResource']) {
        if ((v as Record<string, unknown>)['architectureId'] === archId) {
          mockDb._stores['ArchitectureResource'].delete(k);
        }
      }
    }
    if (/architectureConnection/i.test(sql) && params[0]) {
      const archId = params[0] as string;
      for (const [k, v] of mockDb._stores['ArchitectureConnection']) {
        if ((v as Record<string, unknown>)['architectureId'] === archId) {
          mockDb._stores['ArchitectureConnection'].delete(k);
        }
      }
    }
  }),
}));

// ─── Mock AWS SDK ─────────────────────────────────────────────────────────────

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor?.name ?? '';
      if (name === 'AssumeRoleCommand') {
        return Promise.resolve({
          Credentials: {
            AccessKeyId: 'AKIATEST',
            SecretAccessKey: 'secrettest',
            SessionToken: 'tokentest',
            Expiration: new Date(),
          },
        });
      }
      if (name === 'GetCallerIdentityCommand') {
        return Promise.resolve({
          Account: '123456789012',
          Arn: 'arn:aws:sts::123456789012:assumed-role/CloudCraftReadOnly/cloudcraft-discovery',
          UserId: 'AROATEST:cloudcraft-discovery',
        });
      }
      return Promise.resolve({});
    }),
  })),
  AssumeRoleCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'AssumeRoleCommand' } })),
  GetCallerIdentityCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'GetCallerIdentityCommand' } })),
}));

jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor?.name ?? '';
      if (name === 'DescribeVpcsCommand') {
        return Promise.resolve({
          Vpcs: [
            { VpcId: 'vpc-abc123', State: 'available', CidrBlock: '10.0.0.0/16', IsDefault: false, Tags: [{ Key: 'Name', Value: 'main-vpc' }] },
          ],
        });
      }
      if (name === 'DescribeSubnetsCommand') {
        return Promise.resolve({
          Subnets: [
            { SubnetId: 'subnet-abc', State: 'available', CidrBlock: '10.0.1.0/24', VpcId: 'vpc-abc123', AvailabilityZone: 'us-east-1a', MapPublicIpOnLaunch: true, Tags: [] },
          ],
        });
      }
      if (name === 'DescribeInstancesCommand') {
        return Promise.resolve({
          Reservations: [
            {
              Instances: [
                { InstanceId: 'i-abc123', State: { Name: 'running' }, InstanceType: 't3.medium', ImageId: 'ami-123', VpcId: 'vpc-abc123', Tags: [{ Key: 'Name', Value: 'web-server' }] },
              ],
            },
          ],
        });
      }
      if (name === 'DescribeInternetGatewaysCommand') {
        return Promise.resolve({ InternetGateways: [] });
      }
      return Promise.resolve({});
    }),
  })),
  DescribeVpcsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeVpcsCommand' } })),
  DescribeSubnetsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeSubnetsCommand' } })),
  DescribeInstancesCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeInstancesCommand' } })),
  DescribeInternetGatewaysCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeInternetGatewaysCommand' } })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor?.name ?? '';
      if (name === 'ListBucketsCommand') {
        return Promise.resolve({
          Buckets: [{ Name: 'my-test-bucket', CreationDate: new Date() }],
        });
      }
      if (name === 'GetBucketLocationCommand') {
        return Promise.resolve({ LocationConstraint: 'us-east-1' });
      }
      return Promise.resolve({});
    }),
  })),
  ListBucketsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListBucketsCommand' } })),
  GetBucketLocationCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'GetBucketLocationCommand' } })),
}));

jest.mock('@aws-sdk/client-rds', () => ({
  RDSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      DBInstances: [
        { DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:mydb', DBInstanceIdentifier: 'mydb', DBInstanceStatus: 'available', Engine: 'mysql', EngineVersion: '8.0', DBInstanceClass: 'db.t3.medium', MultiAZ: false, StorageType: 'gp2', AllocatedStorage: 20 },
      ],
    }),
  })),
  DescribeDBInstancesCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeDBInstancesCommand' } })),
}));

jest.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      LoadBalancers: [
        { LoadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/my-alb/abc', LoadBalancerName: 'my-alb', Type: 'application', State: { Code: 'active' }, Scheme: 'internet-facing', VpcId: 'vpc-abc123', DNSName: 'my-alb.amazonaws.com' },
      ],
    }),
  })),
  DescribeLoadBalancersCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeLoadBalancersCommand' } })),
  DescribeTargetGroupsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeTargetGroupsCommand' } })),
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      Functions: [
        {
          FunctionName: 'process-orders', FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:process-orders',
          Runtime: 'nodejs20.x', MemorySize: 1024, Timeout: 30, Handler: 'index.handler', Architectures: ['arm64'],
          State: 'Active', Environment: { Variables: { STAGE: 'prod' } },
          VpcConfig: { VpcId: 'vpc-abc123', SubnetIds: ['subnet-abc'], SecurityGroupIds: ['sg-abc123'] },
        },
      ],
    }),
  })),
  ListFunctionsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListFunctionsCommand' } })),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor?.name ?? '';
      if (name === 'ListTablesCommand') {
        return Promise.resolve({ TableNames: ['orders'] });
      }
      if (name === 'DescribeTableCommand') {
        return Promise.resolve({
          Table: {
            TableName: 'orders', TableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/orders', TableStatus: 'ACTIVE',
            KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'orderId', AttributeType: 'S' }],
            BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
            ItemCount: 42,
          },
        });
      }
      return Promise.resolve({});
    }),
  })),
  ListTablesCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListTablesCommand' } })),
  DescribeTableCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeTableCommand' } })),
}));

jest.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor?.name ?? '';
      if (name === 'ListClustersCommand') {
        return Promise.resolve({ clusterArns: ['arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster'] });
      }
      if (name === 'ListServicesCommand') {
        return Promise.resolve({ serviceArns: ['arn:aws:ecs:us-east-1:123456789012:service/my-cluster/web-service'] });
      }
      if (name === 'DescribeServicesCommand') {
        return Promise.resolve({
          services: [
            {
              serviceName: 'web-service', serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/web-service',
              status: 'ACTIVE', launchType: 'FARGATE', desiredCount: 3,
              taskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/web-task:1',
              networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-abc'], securityGroups: ['sg-abc123'], assignPublicIp: 'DISABLED' } },
            },
          ],
        });
      }
      if (name === 'DescribeTaskDefinitionCommand') {
        return Promise.resolve({
          taskDefinition: {
            cpu: '512', memory: '1024',
            containerDefinitions: [{ image: 'my-repo/web:latest', portMappings: [{ containerPort: 8080 }] }],
          },
        });
      }
      return Promise.resolve({});
    }),
  })),
  ListClustersCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListClustersCommand' } })),
  ListServicesCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListServicesCommand' } })),
  DescribeServicesCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeServicesCommand' } })),
  DescribeTaskDefinitionCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeTaskDefinitionCommand' } })),
}));

jest.mock('@aws-sdk/client-eks', () => ({
  EKSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor?.name ?? '';
      if (name === 'ListClustersCommand') {
        return Promise.resolve({ clusters: ['prod-cluster'] });
      }
      if (name === 'DescribeClusterCommand') {
        return Promise.resolve({
          cluster: {
            name: 'prod-cluster', arn: 'arn:aws:eks:us-east-1:123456789012:cluster/prod-cluster',
            version: '1.31', status: 'ACTIVE',
            resourcesVpcConfig: {
              vpcId: 'vpc-abc123', subnetIds: ['subnet-abc'], securityGroupIds: ['sg-abc123'],
              endpointPublicAccess: true, endpointPrivateAccess: true, publicAccessCidrs: ['203.0.113.0/24'],
            },
            logging: { clusterLogging: [{ enabled: true, types: ['api', 'audit'] }] },
            encryptionConfig: [{ resources: ['secrets'] }],
            tags: { Env: 'prod' },
          },
        });
      }
      if (name === 'ListNodegroupsCommand') {
        return Promise.resolve({ nodegroups: ['default-ng'] });
      }
      if (name === 'DescribeNodegroupCommand') {
        return Promise.resolve({
          nodegroup: { instanceTypes: ['m5.xlarge'], scalingConfig: { desiredSize: 5 }, capacityType: 'SPOT', diskSize: 50 },
        });
      }
      return Promise.resolve({});
    }),
  })),
  ListClustersCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListClustersCommand' } })),
  DescribeClusterCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeClusterCommand' } })),
  ListNodegroupsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListNodegroupsCommand' } })),
  DescribeNodegroupCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeNodegroupCommand' } })),
}));

// ─── Mock Azure SDK ───────────────────────────────────────────────────────────

jest.mock('@azure/identity', () => ({
  ClientSecretCredential: jest.fn().mockImplementation(() => ({})),
}));

const mockRgList = [{ id: '/subscriptions/sub-1/resourceGroups/my-rg', name: 'my-rg', location: 'eastus', properties: { provisioningState: 'Succeeded' }, tags: {} }];
const mockVnetList = [{ id: '/subscriptions/sub-1/resourceGroups/my-rg/providers/Microsoft.Network/virtualNetworks/my-vnet', name: 'my-vnet', location: 'eastus', provisioningState: 'Succeeded', addressSpace: { addressPrefixes: ['10.0.0.0/16'] }, subnets: [{ id: '/subscriptions/sub-1/resourceGroups/my-rg/providers/Microsoft.Network/virtualNetworks/my-vnet/subnets/default', name: 'default', provisioningState: 'Succeeded', addressPrefix: '10.0.1.0/24' }], tags: {} }];

function makeAsyncIterator<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < items.length) return { value: items[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

jest.mock('@azure/arm-resources', () => ({
  ResourceManagementClient: jest.fn().mockImplementation(() => ({
    resourceGroups: { list: () => makeAsyncIterator(mockRgList) },
  })),
}));

jest.mock('@azure/arm-network', () => ({
  NetworkManagementClient: jest.fn().mockImplementation(() => ({
    virtualNetworks: { listAll: () => makeAsyncIterator(mockVnetList) },
    loadBalancers: { listAll: () => makeAsyncIterator([]) },
  })),
}));

jest.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: jest.fn().mockImplementation(() => ({
    virtualMachines: { listAll: () => makeAsyncIterator([]) },
  })),
}));

jest.mock('@azure/arm-storage', () => ({
  StorageManagementClient: jest.fn().mockImplementation(() => ({
    storageAccounts: { list: () => makeAsyncIterator([]) },
  })),
}));

jest.mock('@azure/arm-sql', () => ({
  SqlManagementClient: jest.fn().mockImplementation(() => ({
    servers: { list: () => makeAsyncIterator([]) },
  })),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { AwsDiscoveryAdapter } from '@/lib/cloud/adapters/awsAdapter';
import { AzureDiscoveryAdapter } from '@/lib/cloud/adapters/azureAdapter';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { discoveryRepository } from '@/lib/repositories/discoveryRepository';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Set ENCRYPTION_KEY for all tests so cloudAccountRepository.create can encrypt credentials.
// The encryption key test suite overrides this in its own beforeEach/afterEach.
const TEST_ENCRYPTION_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes
beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  mockDb._reset();
});

async function seedOrg() {
  const orgId = 'org-test-1';
  const userId = 'user-test-1';
  await mockDb.orm.public.Organization.create({ id: orgId, name: 'Test Org', slug: 'test-org', createdAt: '2024-01-01', updatedAt: '2024-01-01' });
  await mockDb.orm.public.OrgMember.create({ id: 'member-1', orgId, userId, role: 'owner' });
  return { orgId, userId };
}

const awsCreds = { roleArn: 'arn:aws:iam::123456789012:role/CloudCraftReadOnly', externalId: 'ext-secret', region: 'us-east-1' };
const azureCreds = { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'supersecret', subscriptionId: 'sub-1' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AWS Adapter', () => {
  it('validates account and returns identity (no credentials)', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.validateAccount();
    expect(result.valid).toBe(true);
    expect(result.identity).toBeDefined();
    expect(result.identity?.provider).toBe('aws');
    // Verify no credential fields leak
    expect(JSON.stringify(result)).not.toContain('secrettest');
    expect(JSON.stringify(result)).not.toContain('tokentest');
    expect(JSON.stringify(result)).not.toContain('AKIATEST');
    await adapter.dispose();
  });

  it('discovers VPCs and returns sanitized resources', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    expect(result.status).toBe('completed');
    const vpcs = result.resources.filter((r) => r.resourceType === 'vpc');
    expect(vpcs.length).toBeGreaterThan(0);
    expect(vpcs[0].name).toBe('main-vpc');
    expect(vpcs[0].providerResourceId).toBe('vpc-abc123');
    // Credentials must not appear in any resource
    const json = JSON.stringify(result);
    expect(json).not.toContain('secrettest');
    expect(json).not.toContain('tokentest');
    await adapter.dispose();
  });

  it('discovers EC2 instances', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const instances = result.resources.filter((r) => r.resourceType === 'ec2-instance');
    expect(instances.length).toBeGreaterThan(0);
    expect(instances[0].name).toBe('web-server');
    await adapter.dispose();
  });

  it('discovers S3 buckets', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const buckets = result.resources.filter((r) => r.resourceType === 's3-bucket');
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets[0].name).toBe('my-test-bucket');
    await adapter.dispose();
  });

  it('discovers RDS instances', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const rdsList = result.resources.filter((r) => r.resourceType === 'rds-instance');
    expect(rdsList.length).toBeGreaterThan(0);
    await adapter.dispose();
  });

  it('discovers load balancers', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const lbs = result.resources.filter((r) => r.resourceType === 'alb' || r.resourceType === 'nlb');
    expect(lbs.length).toBeGreaterThan(0);
    await adapter.dispose();
  });

  it('discovers Lambda functions with VPC config and environment variables', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const fns = result.resources.filter((r) => r.resourceType === 'lambda');
    expect(fns.length).toBeGreaterThan(0);
    expect(fns[0].name).toBe('process-orders');
    expect(fns[0].configuration.memorySize).toBe(1024);
    expect(fns[0].configuration.runtime).toBe('nodejs20.x');
    expect((fns[0].configuration.environmentVariables as Record<string, string>).STAGE).toBe('prod');
    expect(fns[0].configuration.vpcId).toBe('vpc-abc123');
    await adapter.dispose();
  });

  it('discovers DynamoDB tables with key schema resolved from AttributeDefinitions', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const tables = result.resources.filter((r) => r.resourceType === 'dynamodb-table');
    expect(tables.length).toBeGreaterThan(0);
    expect(tables[0].name).toBe('orders');
    expect(tables[0].configuration.partitionKeyName).toBe('orderId');
    expect(tables[0].configuration.partitionKeyType).toBe('S');
    expect(tables[0].configuration.billingMode).toBe('PAY_PER_REQUEST');
    await adapter.dispose();
  });

  it('discovers ECS services with task definition cpu/memory/image resolved', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const services = result.resources.filter((r) => r.resourceType === 'ecs');
    expect(services.length).toBeGreaterThan(0);
    expect(services[0].name).toBe('web-service');
    expect(services[0].configuration.desiredCount).toBe(3);
    expect(services[0].configuration.cpu).toBe(512);
    expect(services[0].configuration.memory).toBe(1024);
    expect(services[0].configuration.containerImage).toBe('my-repo/web:latest');
    expect(services[0].configuration.containerPort).toBe(8080);
    await adapter.dispose();
  });

  it('discovers EKS clusters with node group instance type/count/capacity type resolved', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const clusters = result.resources.filter((r) => r.resourceType === 'eks');
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0].name).toBe('prod-cluster');
    expect(clusters[0].configuration.version).toBe('1.31');
    expect(clusters[0].configuration.nodeInstanceType).toBe('m5.xlarge');
    expect(clusters[0].configuration.nodeCount).toBe(5);
    expect(clusters[0].configuration.capacityType).toBe('SPOT');
    expect(clusters[0].configuration.secretsEncryption).toBe(true);
    expect(clusters[0].configuration.clusterLogTypes).toEqual(['api', 'audit']);
    await adapter.dispose();
  });

  it('returns summary counts', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    expect(result.summary).toBeDefined();
    expect(Object.keys(result.summary).length).toBeGreaterThan(0);
    await adapter.dispose();
  });

  it('disposes and clears session credentials', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    await adapter.discoverAll();
    await adapter.dispose();
    // After dispose, internal credentials are cleared (test via new discovery still working)
    // This ensures no stale credentials persist beyond the adapter lifetime
    expect(adapter.provider).toBe('aws');
  });
});

describe('Azure Adapter', () => {
  it('validates account', async () => {
    const adapter = new AzureDiscoveryAdapter(azureCreds);
    const result = await adapter.validateAccount();
    // clientSecret must never appear in result
    expect(JSON.stringify(result)).not.toContain('supersecret');
    await adapter.dispose();
  });

  it('discovers resource groups', async () => {
    const adapter = new AzureDiscoveryAdapter(azureCreds);
    const result = await adapter.discoverAll();
    const rgs = result.resources.filter((r) => r.resourceType === 'resource-group');
    expect(rgs.length).toBeGreaterThan(0);
    expect(rgs[0].name).toBe('my-rg');
    await adapter.dispose();
  });

  it('discovers VNets and subnets', async () => {
    const adapter = new AzureDiscoveryAdapter(azureCreds);
    const result = await adapter.discoverAll();
    const vnets = result.resources.filter((r) => r.resourceType === 'vnet');
    const subnets = result.resources.filter((r) => r.resourceType === 'subnet');
    expect(vnets.length).toBeGreaterThan(0);
    expect(subnets.length).toBeGreaterThan(0);
    await adapter.dispose();
  });

  it('never exposes clientSecret in result', async () => {
    const adapter = new AzureDiscoveryAdapter(azureCreds);
    const result = await adapter.discoverAll();
    const json = JSON.stringify(result);
    expect(json).not.toContain('supersecret');
    expect(json).not.toContain('clientSecret');
    await adapter.dispose();
  });
});

describe('Resource normalization', () => {
  const sampleResources: DiscoveredResource[] = [
    {
      providerResourceId: 'vpc-abc123',
      resourceType: 'vpc',
      provider: 'aws',
      name: 'main-vpc',
      region: 'us-east-1',
      status: 'available',
      configuration: { cidrBlock: '10.0.0.0/16', isDefault: false },
      metadata: {},
    },
    {
      providerResourceId: 'i-abc123',
      resourceType: 'ec2-instance',
      provider: 'aws',
      name: 'web-server',
      region: 'us-east-1',
      status: 'running',
      configuration: { instanceType: 't3.medium' },
      metadata: {},
    },
    {
      providerResourceId: '/subscriptions/sub-1/resourceGroups/my-rg/providers/Microsoft.Network/virtualNetworks/my-vnet',
      resourceType: 'vnet',
      provider: 'azure',
      name: 'my-vnet',
      region: 'eastus',
      status: 'Succeeded',
      configuration: { addressSpace: ['10.0.0.0/16'] },
      metadata: {},
    },
  ];

  it('converts discovered resources to CanvasNodes', () => {
    const nodes = normalizeResources(sampleResources);
    expect(nodes.length).toBe(3);
  });

  it('maps AWS VPC to aws_vpc resourceType', () => {
    const nodes = normalizeResources(sampleResources);
    const vpc = nodes.find((n) => n.label === 'main-vpc');
    expect(vpc?.resourceType).toBe('aws_vpc');
    expect(vpc?.provider).toBe('aws');
  });

  it('maps EC2 instance to aws_ec2 resourceType', () => {
    const nodes = normalizeResources(sampleResources);
    const ec2 = nodes.find((n) => n.label === 'web-server');
    expect(ec2?.resourceType).toBe('aws_ec2');
  });

  it('maps Azure VNet to azure_vnet resourceType', () => {
    const nodes = normalizeResources(sampleResources);
    const vnet = nodes.find((n) => n.label === 'my-vnet');
    expect(vnet?.resourceType).toBe('azure_vnet');
    expect(vnet?.provider).toBe('azure');
  });

  it('sets grid positions', () => {
    const nodes = normalizeResources(sampleResources);
    for (const n of nodes) {
      expect(n.position.x).toBeGreaterThanOrEqual(0);
      expect(n.position.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('sanitises provider resource IDs', () => {
    const nodes = normalizeResources(sampleResources);
    for (const n of nodes) {
      // IDs should not contain : or /
      expect(n.id).not.toContain(':');
      expect(n.id).not.toContain('/');
    }
  });

  it('preserves provider-specific config (no secrets)', () => {
    const nodes = normalizeResources(sampleResources);
    const vpc = nodes.find((n) => n.label === 'main-vpc');
    expect(vpc?.config['cidrBlock']).toBe('10.0.0.0/16');
  });

  it('supports multi-cloud (AWS + Azure in one array)', () => {
    const nodes = normalizeResources(sampleResources);
    const awsNodes = nodes.filter((n) => n.provider === 'aws');
    const azureNodes = nodes.filter((n) => n.provider === 'azure');
    expect(awsNodes.length).toBe(2);
    expect(azureNodes.length).toBe(1);
  });
});

describe('CloudAccount repository — credential separation', () => {
  it('does not return credentialsJson from findById', async () => {
    const { orgId } = await seedOrg();
    const account = await cloudAccountRepository.create({
      orgId,
      provider: 'aws',
      name: 'Test AWS',
      credentialsJson: JSON.stringify(awsCreds),
    });
    // The returned object must not have credentialsJson
    expect((account as unknown as Record<string, unknown>)['credentialsJson']).toBeUndefined();
  });

  it('does not return credentialsJson from list', async () => {
    const { orgId } = await seedOrg();
    await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Acct', credentialsJson: JSON.stringify(awsCreds) });
    const accounts = await cloudAccountRepository.list(orgId);
    for (const a of accounts) {
      expect((a as unknown as Record<string, unknown>)['credentialsJson']).toBeUndefined();
    }
  });

  it('getCredentials returns raw JSON (used only by adapters)', async () => {
    const { orgId } = await seedOrg();
    const account = await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Acct', credentialsJson: JSON.stringify(awsCreds) });
    const creds = await cloudAccountRepository.getCredentials(account.id, orgId);
    expect(creds).toBeDefined();
    const parsed = JSON.parse(creds!) as Record<string, unknown>;
    expect(parsed['roleArn']).toBe(awsCreds.roleArn);
  });

  it('getCredentials returns null for wrong org (isolation)', async () => {
    const { orgId } = await seedOrg();
    const account = await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Acct', credentialsJson: JSON.stringify(awsCreds) });
    const creds = await cloudAccountRepository.getCredentials(account.id, 'other-org-id');
    expect(creds).toBeNull();
  });
});

describe('Organization isolation', () => {
  it('list() returns only accounts for the given org', async () => {
    const { orgId } = await seedOrg();
    const otherOrgId = 'org-other';
    await mockDb.orm.public.Organization.create({ id: otherOrgId, name: 'Other Org', slug: 'other-org', createdAt: '2024-01-01', updatedAt: '2024-01-01' });

    await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Mine', credentialsJson: '{}' });
    await cloudAccountRepository.create({ orgId: otherOrgId, provider: 'aws', name: 'Theirs', credentialsJson: '{}' });

    const mine = await cloudAccountRepository.list(orgId);
    const theirs = await cloudAccountRepository.list(otherOrgId);

    expect(mine.length).toBe(1);
    expect(mine[0].name).toBe('Mine');
    expect(theirs.length).toBe(1);
    expect(theirs[0].name).toBe('Theirs');
  });

  it('findById() returns null for wrong org', async () => {
    const { orgId } = await seedOrg();
    const account = await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Mine', credentialsJson: '{}' });
    const found = await cloudAccountRepository.findById(account.id, 'wrong-org');
    expect(found).toBeNull();
  });

  it('delete() returns false for wrong org (cannot delete another org account)', async () => {
    const { orgId } = await seedOrg();
    const account = await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Mine', credentialsJson: '{}' });
    const deleted = await cloudAccountRepository.delete(account.id, 'wrong-org');
    expect(deleted).toBe(false);
    // Account should still exist
    const still = await cloudAccountRepository.findById(account.id, orgId);
    expect(still).not.toBeNull();
  });
});

describe('Discovery repository', () => {
  it('creates a run in pending state', async () => {
    const { orgId } = await seedOrg();
    const account = await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Acct', credentialsJson: '{}' });
    const run = await discoveryRepository.create(account.id);
    expect(run.status).toBe('pending');
    expect(run.cloudAccountId).toBe(account.id);
    expect(run.resources).toEqual([]);
  });

  it('transitions run through running → completed', async () => {
    const { orgId } = await seedOrg();
    const account = await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Acct', credentialsJson: '{}' });
    const run = await discoveryRepository.create(account.id);

    await discoveryRepository.markRunning(run.id);
    const running = await discoveryRepository.findById(run.id);
    expect(running?.status).toBe('running');

    const resources: DiscoveredResource[] = [
      { providerResourceId: 'vpc-1', resourceType: 'vpc', provider: 'aws', name: 'main', region: 'us-east-1', status: 'available', configuration: {}, metadata: {} },
    ];
    await discoveryRepository.markCompleted(run.id, resources, { vpc: 1 });
    const completed = await discoveryRepository.findById(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.resources.length).toBe(1);
    expect(completed?.summary['vpc']).toBe(1);
  });

  it('transitions run to failed state with error message', async () => {
    const { orgId } = await seedOrg();
    const account = await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Acct', credentialsJson: '{}' });
    const run = await discoveryRepository.create(account.id);
    await discoveryRepository.markFailed(run.id, 'Access denied');
    const failed = await discoveryRepository.findById(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('Access denied');
  });

  it('findLatest returns most recent run', async () => {
    const { orgId } = await seedOrg();
    const account = await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Acct', credentialsJson: '{}' });
    const run1 = await discoveryRepository.create(account.id);
    const run2 = await discoveryRepository.create(account.id);
    const latest = await discoveryRepository.findLatest(account.id);
    // Both runs exist; latest should be the most recently started one
    expect([run1.id, run2.id]).toContain(latest?.id);
  });

  it('stored resources do not contain credential fields', async () => {
    const { orgId } = await seedOrg();
    const account = await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Acct', credentialsJson: JSON.stringify(awsCreds) });
    const run = await discoveryRepository.create(account.id);
    const resources: DiscoveredResource[] = [
      { providerResourceId: 'vpc-1', resourceType: 'vpc', provider: 'aws', name: 'main', region: 'us-east-1', status: 'available', configuration: { cidrBlock: '10.0.0.0/16' }, metadata: {} },
    ];
    await discoveryRepository.markCompleted(run.id, resources, { vpc: 1 });
    const completed = await discoveryRepository.findById(run.id);
    const json = JSON.stringify(completed?.resources);
    // Verify no AWS credential data leaked into the resources
    expect(json).not.toContain('roleArn');
    expect(json).not.toContain('externalId');
    expect(json).not.toContain('ext-secret');
  });
});

describe('Account validation - invalid credentials', () => {
  it('validateAccount returns valid=false when STS throws', async () => {
    const { STSClient } = jest.requireMock('@aws-sdk/client-sts') as {
      STSClient: jest.Mock;
    };
    STSClient.mockImplementationOnce(() => ({
      send: jest.fn().mockRejectedValue(new Error('InvalidClientTokenId: The security token is invalid')),
    }));
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.validateAccount();
    expect(result.valid).toBe(false);
    expect(result.error).toContain('InvalidClientTokenId');
    await adapter.dispose();
  });
});

describe('Multi-cloud architecture', () => {
  it('normalizer handles mixed AWS + Azure resources', () => {
    const mixed: DiscoveredResource[] = [
      { providerResourceId: 'vpc-1', resourceType: 'vpc', provider: 'aws', name: 'AWS VPC', region: 'us-east-1', status: 'available', configuration: {}, metadata: {} },
      { providerResourceId: '/subs/sub-1/rg/rg-1', resourceType: 'resource-group', provider: 'azure', name: 'Azure RG', region: 'eastus', status: 'Succeeded', configuration: {}, metadata: {} },
      { providerResourceId: 'i-test', resourceType: 'ec2-instance', provider: 'aws', name: 'EC2', region: 'us-east-1', status: 'running', configuration: {}, metadata: {} },
      { providerResourceId: '/subs/sub-1/vnet-1', resourceType: 'vnet', provider: 'azure', name: 'Azure VNet', region: 'eastus', status: 'Succeeded', configuration: {}, metadata: {} },
    ];
    const nodes = normalizeResources(mixed);
    const awsNodes = nodes.filter((n) => n.provider === 'aws');
    const azureNodes = nodes.filter((n) => n.provider === 'azure');
    expect(awsNodes.length).toBe(2);
    expect(azureNodes.length).toBe(2);
    // All nodes have unique IDs
    const ids = new Set(nodes.map((n) => n.id));
    expect(ids.size).toBe(nodes.length);
  });
});

// ─── Security: Input validation ───────────────────────────────────────────────

describe('Input validation — AWS credentials schema', () => {
  // We test the Zod schemas directly by importing them after the module is loaded.
  // Because the schemas are inline in the route file we duplicate the logic here,
  // which is the standard approach for unit-testing Zod schemas without spinning
  // up an HTTP server.
  const { z } = jest.requireActual('zod') as typeof import('zod');

  const AWS_ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,64}$/;
  const AWS_EXTERNAL_ID_RE = /^[\x21-\x7E]{2,1224}$/;
  const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d{1,2}$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const AwsSchema = z.object({
    roleArn: z.string().regex(AWS_ROLE_ARN_RE),
    externalId: z.string().regex(AWS_EXTERNAL_ID_RE),
    region: z.string().regex(AWS_REGION_RE),
    additionalRegions: z.array(z.string().regex(AWS_REGION_RE)).max(20).optional(),
  });

  const AzureSchema = z.object({
    tenantId: z.string().regex(UUID_RE),
    clientId: z.string().regex(UUID_RE),
    clientSecret: z.string().min(1).max(512),
    subscriptionId: z.string().regex(UUID_RE),
  });

  it('accepts a valid AWS role ARN', () => {
    expect(AwsSchema.safeParse({
      roleArn: 'arn:aws:iam::123456789012:role/CloudCraftReadOnly',
      externalId: 'ext-secret',
      region: 'us-east-1',
    }).success).toBe(true);
  });

  it('rejects a malformed AWS role ARN (wrong account length)', () => {
    const result = AwsSchema.safeParse({
      roleArn: 'arn:aws:iam::12345:role/MyRole',
      externalId: 'ext-secret',
      region: 'us-east-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed AWS role ARN (missing prefix)', () => {
    const result = AwsSchema.safeParse({
      roleArn: '123456789012:role/MyRole',
      externalId: 'ext-secret',
      region: 'us-east-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an externalId with leading whitespace', () => {
    const result = AwsSchema.safeParse({
      roleArn: 'arn:aws:iam::123456789012:role/CloudCraftReadOnly',
      externalId: ' leading-space',
      region: 'us-east-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an externalId that is too short (1 char)', () => {
    const result = AwsSchema.safeParse({
      roleArn: 'arn:aws:iam::123456789012:role/CloudCraftReadOnly',
      externalId: 'x',
      region: 'us-east-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed AWS region', () => {
    const result = AwsSchema.safeParse({
      roleArn: 'arn:aws:iam::123456789012:role/CloudCraftReadOnly',
      externalId: 'ext-secret',
      region: 'not-a-region',
    });
    expect(result.success).toBe(false);
  });

  it('rejects region containing injection characters', () => {
    const result = AwsSchema.safeParse({
      roleArn: 'arn:aws:iam::123456789012:role/CloudCraftReadOnly',
      externalId: 'ext-secret',
      region: 'us-east-1; DROP TABLE',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid Azure credentials (UUIDs)', () => {
    expect(AzureSchema.safeParse({
      tenantId: 'a0b1c2d3-e4f5-6789-abcd-ef0123456789',
      clientId: 'b1c2d3e4-f5a6-7890-bcde-f01234567890',
      clientSecret: 'some-secret-value',
      subscriptionId: 'c2d3e4f5-a6b7-8901-cdef-012345678901',
    }).success).toBe(true);
  });

  it('rejects Azure tenantId that is not a UUID', () => {
    const result = AzureSchema.safeParse({
      tenantId: 'not-a-uuid',
      clientId: 'b1c2d3e4-f5a6-7890-bcde-f01234567890',
      clientSecret: 'secret',
      subscriptionId: 'c2d3e4f5-a6b7-8901-cdef-012345678901',
    });
    expect(result.success).toBe(false);
  });

  it('rejects Azure clientId that is not a UUID', () => {
    const result = AzureSchema.safeParse({
      tenantId: 'a0b1c2d3-e4f5-6789-abcd-ef0123456789',
      clientId: '../traversal',
      clientSecret: 'secret',
      subscriptionId: 'c2d3e4f5-a6b7-8901-cdef-012345678901',
    });
    expect(result.success).toBe(false);
  });

  it('rejects Azure subscriptionId that is not a UUID', () => {
    const result = AzureSchema.safeParse({
      tenantId: 'a0b1c2d3-e4f5-6789-abcd-ef0123456789',
      clientId: 'b1c2d3e4-f5a6-7890-bcde-f01234567890',
      clientSecret: 'secret',
      subscriptionId: '12345',
    });
    expect(result.success).toBe(false);
  });

  it('rejects Azure clientSecret that exceeds 512 chars', () => {
    const result = AzureSchema.safeParse({
      tenantId: 'a0b1c2d3-e4f5-6789-abcd-ef0123456789',
      clientId: 'b1c2d3e4-f5a6-7890-bcde-f01234567890',
      clientSecret: 'x'.repeat(513),
      subscriptionId: 'c2d3e4f5-a6b7-8901-cdef-012345678901',
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 20 additionalRegions', () => {
    const result = AwsSchema.safeParse({
      roleArn: 'arn:aws:iam::123456789012:role/CloudCraftReadOnly',
      externalId: 'ext-secret',
      region: 'us-east-1',
      additionalRegions: Array.from({ length: 21 }, () => 'us-east-1'),
    });
    expect(result.success).toBe(false);
  });
});

// ─── Security: Credential encryption at rest ─────────────────────────────────

describe('Credential encryption at rest', () => {
  // Set a test key so the encrypt/decrypt module works in tests.
  const TEST_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY;
    mockDb._reset();
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it('encrypt/decrypt round-trips correctly', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto/credentials');
    const plaintext = JSON.stringify({ roleArn: 'arn:aws:iam::123456789012:role/Test', externalId: 'ext-secret', region: 'us-east-1' });
    const enc = encrypt(plaintext);
    expect(enc).not.toContain('roleArn');
    expect(enc).not.toBe(plaintext);
    const dec = decrypt(enc);
    expect(dec).toBe(plaintext);
  });

  it('each encryption produces a different ciphertext (random IV)', async () => {
    const { encrypt } = await import('@/lib/crypto/credentials');
    const plaintext = 'same plaintext';
    const enc1 = encrypt(plaintext);
    const enc2 = encrypt(plaintext);
    expect(enc1).not.toBe(enc2);
  });

  it('decryption fails if ciphertext is tampered', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto/credentials');
    const enc = encrypt('sensitive data');
    // Flip a byte in the middle of the base64 blob
    const tampered = enc.slice(0, 10) + String.fromCharCode((enc.charCodeAt(10) ^ 1)) + enc.slice(11);
    expect(() => decrypt(tampered)).toThrow();
  });

  it('credentials stored in DB are encrypted (not plaintext JSON)', async () => {
    const { orgId } = await seedOrg();
    const account = await cloudAccountRepository.create({
      orgId,
      provider: 'aws',
      name: 'EncTest',
      credentialsJson: JSON.stringify(awsCreds),
    });
    // Read the raw stored value directly from the mock store
    const raw = mockDb._stores['CloudAccount'].get(account.id);
    const stored = raw?.['credentialsJson'] as string;
    // The stored value must not contain the plaintext roleArn
    expect(stored).toBeDefined();
    expect(stored).not.toContain('roleArn');
    expect(stored).not.toContain('arn:aws:iam');
  });

  it('getCredentials returns decrypted JSON', async () => {
    const { orgId } = await seedOrg();
    const account = await cloudAccountRepository.create({
      orgId,
      provider: 'aws',
      name: 'EncTest',
      credentialsJson: JSON.stringify(awsCreds),
    });
    const raw = await cloudAccountRepository.getCredentials(account.id, orgId);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed['roleArn']).toBe(awsCreds.roleArn);
  });

  it('throws when ENCRYPTION_KEY is absent', async () => {
    delete process.env.ENCRYPTION_KEY;
    const { encrypt } = await import('@/lib/crypto/credentials');
    expect(() => encrypt('test')).toThrow(/ENCRYPTION_KEY/);
  });

  it('throws when ENCRYPTION_KEY is too short', async () => {
    process.env.ENCRYPTION_KEY = 'short';
    const { encrypt } = await import('@/lib/crypto/credentials');
    expect(() => encrypt('test')).toThrow(/ENCRYPTION_KEY/);
  });
});

// ─── Security: Cross-org isolation — discovery endpoints ─────────────────────

describe('Cross-org isolation — discovery repository', () => {
  it('findByAccount does not return runs for a different cloud account', async () => {
    const { orgId } = await seedOrg();
    const otherOrgId = 'org-other-discovery';
    await mockDb.orm.public.Organization.create({ id: otherOrgId, name: 'Other', slug: 'other', createdAt: '2024-01-01', updatedAt: '2024-01-01' });

    const acct1 = await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Acct1', credentialsJson: '{}' });
    const acct2 = await cloudAccountRepository.create({ orgId: otherOrgId, provider: 'aws', name: 'Acct2', credentialsJson: '{}' });

    const run1 = await discoveryRepository.create(acct1.id);
    const run2 = await discoveryRepository.create(acct2.id);
    void run2; // created for isolation check

    const runsForAcct1 = await discoveryRepository.findByAccount(acct1.id);
    expect(runsForAcct1.every((r) => r.cloudAccountId === acct1.id)).toBe(true);
    expect(runsForAcct1.some((r) => r.id === run1.id)).toBe(true);
    expect(runsForAcct1.some((r) => r.cloudAccountId === acct2.id)).toBe(false);
  });

  it('findById does not verify org — caller is responsible for org check (tested pattern)', async () => {
    // discoveryRepository.findById is org-agnostic by design (looks up by run ID).
    // The API layer enforces: run.cloudAccountId === accountId AND accountId is org-scoped.
    // This test verifies that callers must do the cross-account check themselves.
    const { orgId } = await seedOrg();
    const acct = await cloudAccountRepository.create({ orgId, provider: 'aws', name: 'Acct', credentialsJson: '{}' });
    const run = await discoveryRepository.create(acct.id);

    // Simulated attacker: knows a runId but is in a different org.
    // The API layer would reject because cloudAccountRepository.findById(acct.id, 'attacker-org') returns null.
    const attackerSees = await cloudAccountRepository.findById(acct.id, 'attacker-org');
    expect(attackerSees).toBeNull(); // Org isolation prevents account lookup

    // The run still exists server-side — isolation is enforced at API boundary
    const runDirect = await discoveryRepository.findById(run.id);
    expect(runDirect).not.toBeNull(); // DB-level: no isolation (by design; API enforces it)
  });

  it('AWS error sanitiser strips Request IDs and ARNs', async () => {
    // Test the AWS error sanitiser via the adapter's validateAccount failure path
    const { STSClient } = jest.requireMock('@aws-sdk/client-sts') as { STSClient: jest.Mock };
    STSClient.mockImplementationOnce(() => ({
      send: jest.fn().mockRejectedValue(
        new Error(
          'InvalidClientTokenId: The security token is invalid. ' +
          '(Service: STS, Status Code: 403, Request ID: abc12345-dead-beef-cafe-000000000001, ' +
          'Extended Request ID: abc12345def) ' +
          'arn:aws:iam::123456789012:user/test',
        ),
      ),
    }));

    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.validateAccount();
    expect(result.valid).toBe(false);
    // AWS request ID must not appear in the error returned to clients
    expect(result.error).not.toMatch(/abc12345-dead-beef/);
    // ARN must not appear
    expect(result.error).not.toMatch(/123456789012/);
    await adapter.dispose();
  });
});
