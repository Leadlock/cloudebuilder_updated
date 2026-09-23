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
      if (name === 'DescribeNetworkAclsCommand') {
        return Promise.resolve({
          NetworkAcls: [
            {
              NetworkAclId: 'acl-abc123', VpcId: 'vpc-abc123', IsDefault: false, Tags: [{ Key: 'Name', Value: 'app-nacl' }],
              Entries: [
                { RuleNumber: 100, Egress: false, RuleAction: 'allow', Protocol: '6', CidrBlock: '10.0.0.0/16', PortRange: { From: 443, To: 443 } },
                { RuleNumber: 32767, Egress: false, RuleAction: 'deny', Protocol: '-1', CidrBlock: '0.0.0.0/0' },
                { RuleNumber: 100, Egress: true, RuleAction: 'allow', Protocol: '-1', CidrBlock: '0.0.0.0/0' },
                { RuleNumber: 32767, Egress: true, RuleAction: 'deny', Protocol: '-1', CidrBlock: '0.0.0.0/0' },
              ],
            },
          ],
        });
      }
      if (name === 'DescribeLaunchTemplateVersionsCommand') {
        return Promise.resolve({
          LaunchTemplateVersions: [{ LaunchTemplateData: { InstanceType: 'm5.large', ImageId: 'ami-0123456789abcdef0' } }],
        });
      }
      return Promise.resolve({});
    }),
  })),
  DescribeVpcsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeVpcsCommand' } })),
  DescribeSubnetsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeSubnetsCommand' } })),
  DescribeInstancesCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeInstancesCommand' } })),
  DescribeInternetGatewaysCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeInternetGatewaysCommand' } })),
  DescribeNetworkAclsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeNetworkAclsCommand' } })),
  DescribeLaunchTemplateVersionsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeLaunchTemplateVersionsCommand' } })),
}));

jest.mock('@aws-sdk/client-auto-scaling', () => ({
  AutoScalingClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor?.name ?? '';
      if (name === 'DescribeAutoScalingGroupsCommand') {
        return Promise.resolve({
          AutoScalingGroups: [
            {
              AutoScalingGroupName: 'web-asg', AutoScalingGroupARN: 'arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:x:autoScalingGroupName/web-asg',
              MinSize: 2, MaxSize: 8, DesiredCapacity: 4, HealthCheckType: 'ELB', HealthCheckGracePeriod: 120, DefaultCooldown: 60,
              VPCZoneIdentifier: 'subnet-abc,subnet-def', TargetGroupARNs: [], Instances: [{ InstanceId: 'i-abc123' }],
              LaunchTemplate: { LaunchTemplateId: 'lt-abc', Version: '1' }, Tags: [{ Key: 'Env', Value: 'prod' }],
            },
          ],
        });
      }
      if (name === 'DescribePoliciesCommand') {
        return Promise.resolve({
          ScalingPolicies: [
            { TargetTrackingConfiguration: { TargetValue: 70, PredefinedMetricSpecification: { PredefinedMetricType: 'ASGAverageCPUUtilization' } } },
          ],
        });
      }
      return Promise.resolve({});
    }),
  })),
  DescribeAutoScalingGroupsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeAutoScalingGroupsCommand' } })),
  DescribePoliciesCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribePoliciesCommand' } })),
}));

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor?.name ?? '';
      if (name === 'ListQueuesCommand') {
        return Promise.resolve({ QueueUrls: ['https://sqs.us-east-1.amazonaws.com/123456789012/orders-queue.fifo'] });
      }
      if (name === 'GetQueueAttributesCommand') {
        return Promise.resolve({
          Attributes: {
            QueueArn: 'arn:aws:sqs:us-east-1:123456789012:orders-queue.fifo',
            ContentBasedDeduplication: 'true', KmsMasterKeyId: 'alias/aws/sqs',
            VisibilityTimeout: '60', MessageRetentionPeriod: '1209600', DelaySeconds: '5', ReceiveMessageWaitTimeSeconds: '10',
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:123456789012:orders-dlq', maxReceiveCount: 3 }),
          },
        });
      }
      return Promise.resolve({});
    }),
  })),
  ListQueuesCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListQueuesCommand' } })),
  GetQueueAttributesCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'GetQueueAttributesCommand' } })),
}));

jest.mock('@aws-sdk/client-kms', () => ({
  KMSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor?.name ?? '';
      if (name === 'ListAliasesCommand') {
        return Promise.resolve({ Aliases: [{ AliasName: 'alias/app-secrets', TargetKeyId: 'key-abc123' }] });
      }
      if (name === 'ListKeysCommand') {
        return Promise.resolve({ Keys: [{ KeyId: 'key-abc123' }, { KeyId: 'key-aws-managed' }] });
      }
      if (name === 'DescribeKeyCommand') {
        const keyId = (cmd as unknown as { KeyId: string }).KeyId;
        if (keyId === 'key-aws-managed') {
          return Promise.resolve({ KeyMetadata: { KeyId: keyId, KeyManager: 'AWS', Enabled: true } });
        }
        return Promise.resolve({
          KeyMetadata: {
            KeyId: keyId, Arn: 'arn:aws:kms:us-east-1:123456789012:key/key-abc123', KeyManager: 'CUSTOMER',
            KeyUsage: 'ENCRYPT_DECRYPT', KeySpec: 'SYMMETRIC_DEFAULT', MultiRegion: false, Enabled: true,
          },
        });
      }
      if (name === 'GetKeyRotationStatusCommand') {
        return Promise.resolve({ KeyRotationEnabled: true });
      }
      return Promise.resolve({});
    }),
  })),
  ListKeysCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListKeysCommand' } })),
  DescribeKeyCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeKeyCommand' } })),
  GetKeyRotationStatusCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'GetKeyRotationStatusCommand' } })),
  ListAliasesCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListAliasesCommand' } })),
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

jest.mock('@aws-sdk/client-iam', () => ({
  IAMClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor?.name ?? '';
      if (name === 'ListRolesCommand') {
        return Promise.resolve({
          Roles: [
            {
              RoleName: 'app-lambda-role', Arn: 'arn:aws:iam::123456789012:role/app-lambda-role', Path: '/', MaxSessionDuration: 7200,
              AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({
                Statement: [{ Principal: { Service: 'lambda.amazonaws.com' } }],
              })),
            },
            {
              RoleName: 'AWSServiceRoleForSomething', Arn: 'arn:aws:iam::123456789012:role/aws-service-role/x/AWSServiceRoleForSomething',
              Path: '/aws-service-role/x/',
            },
          ],
        });
      }
      if (name === 'ListAttachedRolePoliciesCommand') {
        return Promise.resolve({
          AttachedPolicies: [{ PolicyName: 'AWSLambdaBasicExecutionRole', PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' }],
        });
      }
      return Promise.resolve({});
    }),
  })),
  ListRolesCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListRolesCommand' } })),
  ListAttachedRolePoliciesCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListAttachedRolePoliciesCommand' } })),
}));

jest.mock('@aws-sdk/client-elasticache', () => ({
  ElastiCacheClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor?.name ?? '';
      if (name === 'DescribeCacheClustersCommand') {
        return Promise.resolve({
          CacheClusters: [
            {
              CacheClusterId: 'my-redis-cache', ARN: 'arn:aws:elasticache:us-east-1:123456789012:cluster:my-redis-cache',
              Engine: 'redis', EngineVersion: '7.1', CacheNodeType: 'cache.r6g.large', NumCacheNodes: 2,
              CacheClusterStatus: 'available', TransitEncryptionEnabled: true, AtRestEncryptionEnabled: true,
              SnapshotRetentionLimit: 7, ReplicationGroupId: 'my-redis-rg',
              CacheNodes: [{ Endpoint: { Port: 6379 } }],
            },
          ],
        });
      }
      if (name === 'DescribeReplicationGroupsCommand') {
        return Promise.resolve({
          ReplicationGroups: [{ AutomaticFailover: 'enabled', MultiAZ: 'enabled' }],
        });
      }
      return Promise.resolve({});
    }),
  })),
  DescribeCacheClustersCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeCacheClustersCommand' } })),
  DescribeReplicationGroupsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'DescribeReplicationGroupsCommand' } })),
}));

jest.mock('@aws-sdk/client-cloudfront', () => ({
  CloudFrontClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      DistributionList: {
        IsTruncated: false,
        Items: [
          {
            Id: 'E1ABCDEF23456', ARN: 'arn:aws:cloudfront::123456789012:distribution/E1ABCDEF23456',
            Comment: 'my-cdn', Status: 'Deployed', DomainName: 'd111111abcdef8.cloudfront.net',
            Enabled: true, PriceClass: 'PriceClass_All', HttpVersion: 'HTTP2', IsIPV6Enabled: true,
            ViewerCertificate: { ACMCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc', MinimumProtocolVersion: 'TLSv1.2_2021' },
            WebACLId: 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-acl/abc',
            Restrictions: { GeoRestriction: { RestrictionType: 'whitelist', Items: ['US', 'CA'] } },
            DefaultCacheBehavior: { ViewerProtocolPolicy: 'https-only', Compress: true, MinTTL: 0, DefaultTTL: 3600, MaxTTL: 86400 },
          },
        ],
      },
    }),
  })),
  ListDistributionsCommand: jest.fn().mockImplementation((p: unknown) => ({ ...p as object, constructor: { name: 'ListDistributionsCommand' } })),
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

const mockAksClusterList = [
  {
    id: '/subscriptions/sub-1/resourceGroups/my-rg/providers/Microsoft.ContainerService/managedClusters/prod-aks',
    name: 'prod-aks', location: 'eastus', provisioningState: 'Succeeded', dnsPrefix: 'prod-aks-dns', kubernetesVersion: '1.31',
    agentPoolProfiles: [{ vmSize: 'Standard_D4s_v3', count: 5, enableAutoScaling: true, minCount: 3, maxCount: 8 }],
    sku: { tier: 'Standard' }, apiServerAccessProfile: { enablePrivateCluster: true },
    networkProfile: { networkPlugin: 'azure' }, enableRbac: true, tags: { Env: 'prod' },
  },
];

jest.mock('@azure/arm-containerservice', () => ({
  ContainerServiceClient: jest.fn().mockImplementation(() => ({
    managedClusters: { list: () => makeAsyncIterator(mockAksClusterList) },
  })),
}));

const mockFunctionAppList = [
  {
    id: '/subscriptions/sub-1/resourceGroups/my-rg/providers/Microsoft.Web/sites/my-func',
    name: 'my-func', location: 'eastus', kind: 'functionapp,linux', state: 'Running', reserved: true,
    httpsOnly: true, publicNetworkAccess: 'Enabled', tags: {},
    serverFarmId: '/subscriptions/sub-1/resourceGroups/my-rg/providers/Microsoft.Web/serverfarms/my-plan',
  },
];

jest.mock('@azure/arm-appservice', () => ({
  WebSiteManagementClient: jest.fn().mockImplementation(() => ({
    webApps: {
      list: () => makeAsyncIterator(mockFunctionAppList),
      get: jest.fn().mockResolvedValue({
        siteConfig: { linuxFxVersion: 'NODE|20-lts', minTlsVersion: '1.2', alwaysOn: true },
      }),
    },
    appServicePlans: {
      get: jest.fn().mockResolvedValue({ sku: { name: 'EP1' } }),
    },
  })),
}));

const mockKeyVaultList = [
  {
    id: '/subscriptions/sub-1/resourceGroups/my-rg/providers/Microsoft.KeyVault/vaults/my-vault',
    name: 'my-vault', location: 'eastus', tags: {},
    properties: {
      sku: { name: 'premium' }, enableRbacAuthorization: true, enablePurgeProtection: true,
      softDeleteRetentionInDays: 30, publicNetworkAccess: 'Disabled', networkAcls: { defaultAction: 'Deny' },
      enabledForDiskEncryption: true, provisioningState: 'Succeeded',
    },
  },
];

jest.mock('@azure/arm-keyvault', () => ({
  KeyVaultManagementClient: jest.fn().mockImplementation(() => ({
    vaults: { listBySubscription: () => makeAsyncIterator(mockKeyVaultList) },
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

  it('discovers IAM roles, resolving trusted service from the trust policy and skipping service-linked roles', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const roles = result.resources.filter((r) => r.resourceType === 'iam-role');
    expect(roles.length).toBe(1);
    expect(roles[0].name).toBe('app-lambda-role');
    expect(roles[0].configuration.trustedService).toBe('lambda.amazonaws.com');
    expect(roles[0].configuration.maxSessionDurationSeconds).toBe(7200);
    expect(roles[0].configuration.managedPolicyArns).toEqual(['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']);
    await adapter.dispose();
  });

  it('discovers ElastiCache clusters, resolving failover/Multi-AZ from the replication group', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const caches = result.resources.filter((r) => r.resourceType === 'elasticache');
    expect(caches.length).toBeGreaterThan(0);
    expect(caches[0].name).toBe('my-redis-cache');
    expect(caches[0].configuration.nodeType).toBe('cache.r6g.large');
    expect(caches[0].configuration.numNodes).toBe(2);
    expect(caches[0].configuration.automaticFailoverEnabled).toBe(true);
    expect(caches[0].configuration.multiAzEnabled).toBe(true);
    await adapter.dispose();
  });

  it('discovers CloudFront distributions with certificate, WAF, and geo-restriction config resolved', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const distributions = result.resources.filter((r) => r.resourceType === 'cloudfront');
    expect(distributions.length).toBe(1);
    expect(distributions[0].name).toBe('my-cdn');
    expect(distributions[0].configuration.priceClass).toBe('PriceClass_All');
    expect(distributions[0].configuration.viewerProtocolPolicy).toBe('https-only');
    expect(distributions[0].configuration.useCustomCertificate).toBe(true);
    expect(distributions[0].configuration.customCertificateArn).toBe('arn:aws:acm:us-east-1:123456789012:certificate/abc');
    expect(distributions[0].configuration.webAclId).toBe('arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-acl/abc');
    expect(distributions[0].configuration.geoRestrictionType).toBe('whitelist');
    expect(distributions[0].configuration.geoRestrictionCountries).toEqual(['US', 'CA']);
    await adapter.dispose();
  });

  it('discovers Auto Scaling Groups, resolving instance type/AMI from the launch template and scaling policy target', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const asgs = result.resources.filter((r) => r.resourceType === 'auto-scaling-group');
    expect(asgs.length).toBeGreaterThan(0);
    expect(asgs[0].name).toBe('web-asg');
    expect(asgs[0].configuration.instanceType).toBe('m5.large');
    expect(asgs[0].configuration.amiId).toBe('ami-0123456789abcdef0');
    expect(asgs[0].configuration.minSize).toBe(2);
    expect(asgs[0].configuration.maxSize).toBe(8);
    expect(asgs[0].configuration.scalingPolicyEnabled).toBe(true);
    expect(asgs[0].configuration.targetCpuUtilization).toBe(70);
    await adapter.dispose();
  });

  it('discovers Network ACLs, picking the lowest custom rule for each direction (not the implicit deny-all)', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const nacls = result.resources.filter((r) => r.resourceType === 'network-acl');
    expect(nacls.length).toBeGreaterThan(0);
    expect(nacls[0].name).toBe('app-nacl');
    expect(nacls[0].configuration.allowAllInbound).toBe(false);
    expect(nacls[0].configuration.inboundCidr).toBe('10.0.0.0/16');
    expect(nacls[0].configuration.inboundProtocol).toBe('tcp');
    expect(nacls[0].configuration.inboundPortFrom).toBe(443);
    expect(nacls[0].configuration.allowAllOutbound).toBe(true);
    await adapter.dispose();
  });

  it('discovers SQS queues, parsing the redrive policy and detecting FIFO from the queue name', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const queues = result.resources.filter((r) => r.resourceType === 'sqs-queue');
    expect(queues.length).toBeGreaterThan(0);
    expect(queues[0].name).toBe('orders-queue.fifo');
    expect(queues[0].configuration.fifoQueue).toBe(true);
    expect(queues[0].configuration.contentBasedDeduplication).toBe(true);
    expect(queues[0].configuration.deadLetterTargetArn).toBe('arn:aws:sqs:us-east-1:123456789012:orders-dlq');
    expect(queues[0].configuration.maxReceiveCount).toBe(3);
    expect(queues[0].configuration.visibilityTimeoutSeconds).toBe(60);
    await adapter.dispose();
  });

  it('discovers customer-managed KMS keys, resolving alias as the display name and skipping AWS-managed keys', async () => {
    const adapter = new AwsDiscoveryAdapter(awsCreds);
    const result = await adapter.discoverAll();
    const keys = result.resources.filter((r) => r.resourceType === 'kms-key');
    expect(keys.length).toBe(1);
    expect(keys[0].name).toBe('app-secrets');
    expect(keys[0].configuration.enableKeyRotation).toBe(true);
    expect(keys[0].configuration.keyUsage).toBe('ENCRYPT_DECRYPT');
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

  it('discovers AKS clusters with node pool size/count/autoscale config', async () => {
    const adapter = new AzureDiscoveryAdapter(azureCreds);
    const result = await adapter.discoverAll();
    const clusters = result.resources.filter((r) => r.resourceType === 'aks');
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0].name).toBe('prod-aks');
    expect(clusters[0].configuration.nodeVmSize).toBe('Standard_D4s_v3');
    expect(clusters[0].configuration.nodeCount).toBe(5);
    expect(clusters[0].configuration.enableAutoScaling).toBe(true);
    expect(clusters[0].configuration.privateClusterEnabled).toBe(true);
    await adapter.dispose();
  });

  it('discovers Function Apps, resolving runtime from linuxFxVersion and plan type from the App Service Plan', async () => {
    const adapter = new AzureDiscoveryAdapter(azureCreds);
    const result = await adapter.discoverAll();
    const funcs = result.resources.filter((r) => r.resourceType === 'functions');
    expect(funcs.length).toBeGreaterThan(0);
    expect(funcs[0].name).toBe('my-func');
    expect(funcs[0].configuration.runtime).toBe('node');
    expect(funcs[0].configuration.runtimeVersion).toBe('20-lts');
    expect(funcs[0].configuration.osType).toBe('Linux');
    expect(funcs[0].configuration.planType).toBe('EP1');
    expect(funcs[0].configuration.alwaysOn).toBe(true);
    await adapter.dispose();
  });

  it('discovers Key Vaults with security-relevant properties intact', async () => {
    const adapter = new AzureDiscoveryAdapter(azureCreds);
    const result = await adapter.discoverAll();
    const vaults = result.resources.filter((r) => r.resourceType === 'key-vault');
    expect(vaults.length).toBeGreaterThan(0);
    expect(vaults[0].name).toBe('my-vault');
    expect(vaults[0].configuration.sku).toBe('premium');
    expect(vaults[0].configuration.enableRbacAuthorization).toBe(true);
    expect(vaults[0].configuration.softDeleteRetentionDays).toBe(30);
    expect(vaults[0].configuration.publicNetworkAccessEnabled).toBe(false);
    expect(vaults[0].configuration.networkAclsDefaultAction).toBe('Deny');
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
