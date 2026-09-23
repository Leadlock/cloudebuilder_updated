/**
 * AWS Discovery Adapter
 *
 * Uses AWS SDK v3 with STS cross-account role assumption (AssumeRole).
 * Discovers:
 * - VPCs, Subnets, Internet Gateways, NAT Gateways, Route Tables, Security Groups
 * - EC2 instances, EBS volumes
 * - S3 buckets, RDS instances
 * - Application & Network Load Balancers, Target Groups, Target Health
 * - Lambda functions, DynamoDB tables
 * - ECS services (Fargate & EC2 launch types), EKS clusters & node groups
 * - IAM roles (user-managed only — aws-service-role/* roles are skipped),
 *   ElastiCache clusters (Redis/Valkey, with replication group failover/Multi-AZ state)
 * - Accessible Regions
 *
 * Reconstructs full infrastructure topology and relationships:
 * - VPC contains Subnets
 * - Subnet contains EC2, RDS, ALB, VPC-attached Lambda functions, ECS services, EKS clusters
 * - Internet Gateway -> VPC
 * - NAT Gateway -> Subnet
 * - Route Table -> Subnet
 * - ALB -> Target Group -> EC2
 * - Security Group -> EC2 / RDS / ALB / Lambda / ECS / EKS
 * - EC2 -> EBS Volume
 * - DynamoDB tables are discovered as regional resources (not VPC-attached)
 *
 * Security contract:
 * - Credentials are accepted at construction time and used strictly inside this file.
 * - Temporary STS credentials are never logged or returned to callers.
 * - Only sanitised resource data is returned.
 * - Least-privilege read-only permissions required.
 */
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  EC2Client,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeInstancesCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeVolumesCommand,
  DescribeRegionsCommand,
} from '@aws-sdk/client-ec2';
import { S3Client, ListBucketsCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient, ListTablesCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import {
  ECSClient,
  ListClustersCommand as ListEcsClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs';
import {
  EKSClient,
  ListClustersCommand as ListEksClustersCommand,
  DescribeClusterCommand,
  ListNodegroupsCommand,
  DescribeNodegroupCommand,
} from '@aws-sdk/client-eks';
import { IAMClient, ListRolesCommand, ListAttachedRolePoliciesCommand } from '@aws-sdk/client-iam';
import {
  ElastiCacheClient,
  DescribeCacheClustersCommand,
  DescribeReplicationGroupsCommand,
} from '@aws-sdk/client-elasticache';
import type {
  AwsRoleCredentials,
  DiscoveredResource,
  DiscoveryResult,
  AccountValidationResult,
  AwsAccountIdentity,
} from '../types';
import type {
  CloudResource,
  CloudRelationship,
  DiscoveredTopology,
  DiscoveryOptions,
} from '../discovery/types';
import { retryWithBackoff, computeConfigHash } from '../discovery/utils';
import type { InfrastructureDiscoveryProvider } from '../provider';

// ─── Minimum required permissions for discovery ───────────────────────────────

export const REQUIRED_AWS_PERMISSIONS = [
  'ec2:DescribeVpcs',
  'ec2:DescribeSubnets',
  'ec2:DescribeInstances',
  'ec2:DescribeInternetGateways',
  'ec2:DescribeNatGateways',
  'ec2:DescribeRouteTables',
  'ec2:DescribeSecurityGroups',
  'ec2:DescribeVolumes',
  'ec2:DescribeRegions',
  's3:ListAllMyBuckets',
  's3:GetBucketLocation',
  'rds:DescribeDBInstances',
  'elasticloadbalancing:DescribeLoadBalancers',
  'elasticloadbalancing:DescribeTargetGroups',
  'elasticloadbalancing:DescribeTargetHealth',
  'lambda:ListFunctions',
  'dynamodb:ListTables',
  'dynamodb:DescribeTable',
  'ecs:ListClusters',
  'ecs:ListServices',
  'ecs:DescribeServices',
  'ecs:DescribeTaskDefinition',
  'eks:ListClusters',
  'eks:DescribeCluster',
  'eks:ListNodegroups',
  'eks:DescribeNodegroup',
  'iam:ListRoles',
  'iam:ListAttachedRolePolicies',
  'elasticache:DescribeCacheClusters',
  'elasticache:DescribeReplicationGroups',
  'sts:GetCallerIdentity',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nameTag(tags: Array<{ Key?: string; Value?: string }> | undefined): string {
  return tags?.find((t) => t.Key === 'Name')?.Value ?? '';
}

function tagsToMap(tags: Array<{ Key?: string; Value?: string }> | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of tags ?? []) {
    if (t.Key) map[t.Key] = t.Value ?? '';
  }
  return map;
}

function now(): string {
  return new Date().toISOString();
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class AwsDiscoveryAdapter implements InfrastructureDiscoveryProvider {
  readonly provider = 'aws' as const;

  private readonly _credentials: AwsRoleCredentials;
  private _sessionCredentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  } | null = null;

  constructor(credentials: AwsRoleCredentials) {
    this._credentials = credentials;
  }

  // ── STS role assumption ──────────────────────────────────────────────────

  private async _assumeRole(): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  }> {
    if (this._sessionCredentials) return this._sessionCredentials;

    const stsClient = new STSClient({ region: this._credentials.region });
    const assumed = await retryWithBackoff(() =>
      stsClient.send(
        new AssumeRoleCommand({
          RoleArn: this._credentials.roleArn,
          RoleSessionName: 'cloudcraft-discovery',
          ExternalId: this._credentials.externalId,
          DurationSeconds: 3600,
        }),
      ),
    );

    if (
      !assumed.Credentials?.AccessKeyId ||
      !assumed.Credentials?.SecretAccessKey ||
      !assumed.Credentials?.SessionToken
    ) {
      throw new Error('STS AssumeRole did not return valid credentials');
    }

    this._sessionCredentials = {
      accessKeyId: assumed.Credentials.AccessKeyId,
      secretAccessKey: assumed.Credentials.SecretAccessKey,
      sessionToken: assumed.Credentials.SessionToken,
    };

    return this._sessionCredentials;
  }

  private async _makeEc2Client(region: string): Promise<EC2Client> {
    const creds = await this._assumeRole();
    return new EC2Client({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
  }

  private async _makeS3Client(): Promise<S3Client> {
    const creds = await this._assumeRole();
    return new S3Client({
      region: this._credentials.region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
  }

  private async _makeRdsClient(region: string): Promise<RDSClient> {
    const creds = await this._assumeRole();
    return new RDSClient({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
  }

  private async _makeElbClient(region: string): Promise<ElasticLoadBalancingV2Client> {
    const creds = await this._assumeRole();
    return new ElasticLoadBalancingV2Client({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
  }

  private async _makeLambdaClient(region: string): Promise<LambdaClient> {
    const creds = await this._assumeRole();
    return new LambdaClient({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
  }

  private async _makeDynamoDbClient(region: string): Promise<DynamoDBClient> {
    const creds = await this._assumeRole();
    return new DynamoDBClient({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
  }

  private async _makeEcsClient(region: string): Promise<ECSClient> {
    const creds = await this._assumeRole();
    return new ECSClient({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
  }

  private async _makeEksClient(region: string): Promise<EKSClient> {
    const creds = await this._assumeRole();
    return new EKSClient({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
  }

  // IAM is a global service; requests still need a region to resolve an endpoint.
  private async _makeIamClient(): Promise<IAMClient> {
    const creds = await this._assumeRole();
    return new IAMClient({
      region: this._credentials.region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
  }

  private async _makeElastiCacheClient(region: string): Promise<ElastiCacheClient> {
    const creds = await this._assumeRole();
    return new ElastiCacheClient({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
  }

  // ── Account validation ───────────────────────────────────────────────────

  async validateAccount(): Promise<AccountValidationResult> {
    try {
      const creds = await this._assumeRole();
      const stsClient = new STSClient({
        region: this._credentials.region,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });

      const identity = await retryWithBackoff(() =>
        stsClient.send(new GetCallerIdentityCommand({})),
      );
      if (!identity.Account || !identity.Arn || !identity.UserId) {
        return {
          valid: false,
          permissionsOk: false,
          missingPermissions: REQUIRED_AWS_PERMISSIONS,
          error: 'STS GetCallerIdentity returned incomplete response',
        };
      }

      // Lightweight check
      const ec2 = await this._makeEc2Client(this._credentials.region);
      const missingPermissions: string[] = [];
      try {
        await retryWithBackoff(() => ec2.send(new DescribeVpcsCommand({ MaxResults: 5 })));
      } catch {
        missingPermissions.push('ec2:DescribeVpcs', 'ec2:DescribeSubnets', 'ec2:DescribeInstances');
      }

      const accountIdentity: AwsAccountIdentity = {
        provider: 'aws',
        accountId: identity.Account,
        arn: identity.Arn,
        userId: identity.UserId,
        region: this._credentials.region,
      };

      return {
        valid: missingPermissions.length === 0,
        identity: accountIdentity,
        permissionsOk: missingPermissions.length === 0,
        missingPermissions,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AwsDiscoveryAdapter] validateAccount failed:', message);
      return {
        valid: false,
        permissionsOk: false,
        missingPermissions: REQUIRED_AWS_PERMISSIONS,
        error: sanitiseAwsError(message),
      };
    }
  }

  // ── Region discovery ─────────────────────────────────────────────────────

  async discoverRegions(): Promise<string[]> {
    try {
      const ec2 = await this._makeEc2Client(this._credentials.region);
      const resp = await retryWithBackoff(() => ec2.send(new DescribeRegionsCommand({ AllRegions: false })));
      const regions = (resp.Regions ?? []).map((r) => r.RegionName).filter((r): r is string => Boolean(r));
      return regions.length > 0 ? regions : [this._credentials.region];
    } catch (err) {
      console.warn('[AwsDiscoveryAdapter] Failed to dynamically query regions; fallback to configured region:', err);
      return [this._credentials.region];
    }
  }

  // ── Legacy / Simple discoverAll ──────────────────────────────────────────

  async discoverAll(regions?: string[]): Promise<DiscoveryResult> {
    const targetRegions = regions && regions.length > 0
      ? regions
      : [
          this._credentials.region,
          ...(this._credentials.additionalRegions ?? []),
        ];

    const topology = await this.discoverTopology({
      regions: targetRegions,
    });

    const resources: DiscoveredResource[] = topology.resources.map((r) => ({
      providerResourceId: r.resourceId || r.arn || '',
      resourceType: r.resourceType as DiscoveredResource['resourceType'],
      provider: 'aws',
      name: r.name,
      region: r.region,
      status: r.status,
      configuration: r.configuration,
      metadata: r.metadata,
    }));

    return {
      accountId: topology.accountId,
      provider: 'aws',
      status: topology.status === 'failed' ? 'failed' : 'completed',
      startedAt: topology.startedAt,
      completedAt: topology.completedAt,
      resources,
      relationships: topology.relationships,
      error: topology.error,
      summary: topology.summary,
    };
  }

  // ── Production Topology Discovery ────────────────────────────────────────

  async discoverTopology(options: DiscoveryOptions = {}): Promise<DiscoveredTopology> {
    const startedAt = now();
    const warnings: string[] = [];
    let accountId = 'unknown';

    try {
      const creds = await this._assumeRole();
      const sts = new STSClient({
        region: this._credentials.region,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
      const id = await retryWithBackoff(() => sts.send(new GetCallerIdentityCommand({})));
      accountId = id.Account ?? 'unknown';
    } catch (err) {
      console.error('[AwsDiscoveryAdapter] Identity query error:', err);
    }

    // Resolve target regions
    let targetRegions: string[] = [];
    if (options.regions && options.regions.includes('*')) {
      targetRegions = await this.discoverRegions();
    } else if (options.regions && options.regions.length > 0) {
      targetRegions = options.regions;
    } else {
      targetRegions = [
        this._credentials.region,
        ...(this._credentials.additionalRegions ?? []),
      ];
    }
    const uniqueRegions = [...new Set(targetRegions.filter(Boolean))];

    const allResources: CloudResource[] = [];
    const allRelationships: CloudRelationship[] = [];
    const unsupportedResources: DiscoveredTopology['unsupportedResources'] = [];

    options.onProgress?.({
      stage: 'connecting',
      message: 'Connected to AWS via IAM Role',
      resourcesDiscovered: 0,
      relationshipsDiscovered: 0,
      unsupportedCount: 0,
      percent: 5,
    });

    try {
      // 1. Global S3 Buckets
      try {
        options.onProgress?.({
          stage: 'scanning_storage',
          message: 'Scanning S3 buckets...',
          resourcesDiscovered: allResources.length,
          relationshipsDiscovered: allRelationships.length,
          unsupportedCount: 0,
          percent: 15,
        });
        const s3Resources = await this._discoverS3(accountId);
        allResources.push(...s3Resources);
      } catch (s3Err) {
        warnings.push(`S3 discovery error: ${s3Err instanceof Error ? s3Err.message : String(s3Err)}`);
      }

      // 1b. Global IAM Roles
      try {
        options.onProgress?.({
          stage: 'scanning_storage',
          message: 'Scanning IAM roles...',
          resourcesDiscovered: allResources.length,
          relationshipsDiscovered: allRelationships.length,
          unsupportedCount: 0,
          percent: 18,
        });
        const iamResources = await this._discoverIamRoles(accountId);
        allResources.push(...iamResources);
      } catch (iamErr) {
        warnings.push(`IAM discovery error: ${iamErr instanceof Error ? iamErr.message : String(iamErr)}`);
      }

      // 2. Region-scoped resources
      const stepPercent = 75 / (uniqueRegions.length || 1);
      let currentProgress = 20;

      for (const region of uniqueRegions) {
        if (options.signal?.aborted) throw new Error('Discovery cancelled by user');

        options.onProgress?.({
          stage: 'scanning_vpcs',
          currentRegion: region,
          message: `Discovering networking and compute in ${region}...`,
          resourcesDiscovered: allResources.length,
          relationshipsDiscovered: allRelationships.length,
          unsupportedCount: unsupportedResources.length,
          percent: Math.min(90, Math.round(currentProgress)),
        });

        try {
          const [vpcs, subnets, igws, nats, routeTables, sgs] = await Promise.all([
            this._discoverVpcs(region, accountId),
            this._discoverSubnets(region, accountId),
            this._discoverInternetGateways(region, accountId),
            this._discoverNatGateways(region, accountId),
            this._discoverRouteTables(region, accountId),
            this._discoverSecurityGroups(region, accountId),
          ]);

          const [instances, volumes] = await Promise.all([
            this._discoverEc2Instances(region, accountId),
            this._discoverVolumes(region, accountId),
          ]);

          const [rdsList, lbs, tgs] = await Promise.all([
            this._discoverRdsInstances(region, accountId),
            this._discoverLoadBalancers(region, accountId),
            this._discoverTargetGroups(region, accountId),
          ]);

          const [lambdas, dynamoTables] = await Promise.all([
            this._discoverLambdaFunctions(region, accountId),
            this._discoverDynamoDbTables(region, accountId),
          ]);

          const [ecsServices, eksClusters] = await Promise.all([
            this._discoverEcsServices(region, accountId),
            this._discoverEksClusters(region, accountId),
          ]);

          const elastiCacheClusters = await this._discoverElastiCacheClusters(region, accountId);

          allResources.push(
            ...vpcs,
            ...subnets,
            ...igws,
            ...nats,
            ...routeTables,
            ...sgs,
            ...instances,
            ...volumes,
            ...rdsList,
            ...lbs,
            ...tgs,
            ...lambdas,
            ...dynamoTables,
            ...ecsServices,
            ...eksClusters,
            ...elastiCacheClusters,
          );

          // Build topology relationships for this region
          const regionRelationships = this._reconstructAwsRelationships({
            vpcs,
            subnets,
            instances,
            igws,
            nats,
            routeTables,
            sgs,
            volumes,
            rdsList,
            lbs,
            tgs,
            lambdas,
            ecsServices,
            eksClusters,
            elastiCacheClusters,
          });
          allRelationships.push(...regionRelationships);

        } catch (regionErr) {
          const msg = `Region ${region} partial failure: ${regionErr instanceof Error ? regionErr.message : String(regionErr)}`;
          console.error(`[AwsDiscoveryAdapter] ${msg}`);
          warnings.push(msg);
        }

        currentProgress += stepPercent;
      }

      options.onProgress?.({
        stage: 'building_relationships',
        message: 'Reconstructing infrastructure relationships and canvas topology...',
        resourcesDiscovered: allResources.length,
        relationshipsDiscovered: allRelationships.length,
        unsupportedCount: unsupportedResources.length,
        percent: 95,
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AwsDiscoveryAdapter] discoverTopology failed:', message);
      return {
        accountId,
        provider: 'aws',
        status: 'failed',
        startedAt,
        completedAt: now(),
        scannedRegions: uniqueRegions,
        resources: [],
        relationships: [],
        summary: {},
        unsupportedResources: [],
        warnings,
        error: sanitiseAwsError(message),
      };
    }

    const summary = buildSummary(allResources);

    options.onProgress?.({
      stage: 'completed',
      message: `Discovery complete. Found ${allResources.length} resources and ${allRelationships.length} relationships.`,
      resourcesDiscovered: allResources.length,
      relationshipsDiscovered: allRelationships.length,
      unsupportedCount: unsupportedResources.length,
      percent: 100,
    });

    return {
      accountId,
      provider: 'aws',
      status: warnings.length > 0 && allResources.length === 0 ? 'failed' : 'completed',
      startedAt,
      completedAt: now(),
      scannedRegions: uniqueRegions,
      resources: allResources,
      relationships: allRelationships,
      summary,
      unsupportedResources,
      warnings,
    };
  }

  // ── Per-service discovery helpers with pagination ─────────────────────────

  private async _discoverVpcs(region: string, accountId: string): Promise<CloudResource[]> {
    const ec2 = await this._makeEc2Client(region);
    const results: CloudResource[] = [];
    let nextToken: string | undefined = undefined;

    do {
      const resp = await retryWithBackoff(() =>
        ec2.send(new DescribeVpcsCommand({ NextToken: nextToken })),
      );
      for (const vpc of resp.Vpcs ?? []) {
        const id = safeString(vpc.VpcId);
        if (!id) continue;
        const name = nameTag(vpc.Tags) || id;
        const config = {
          cidrBlock: vpc.CidrBlock ?? '10.0.0.0/16',
          isDefault: vpc.IsDefault ?? false,
          dhcpOptionsId: vpc.DhcpOptionsId ?? null,
          instanceTenancy: vpc.InstanceTenancy ?? 'default',
          enableDnsSupport: true,
          enableDnsHostnames: true,
          source: 'aws-api',
          imported: true,
        };
        results.push({
          id,
          provider: 'aws',
          accountId,
          region,
          resourceType: 'vpc',
          name,
          arn: `arn:aws:ec2:${region}:${accountId}:vpc/${id}`,
          resourceId: id,
          tags: tagsToMap(vpc.Tags),
          status: safeString(vpc.State) || 'available',
          configuration: config,
          metadata: { ownerId: vpc.OwnerId ?? accountId },
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
      nextToken = resp.NextToken;
    } while (nextToken);

    return results;
  }

  private async _discoverSubnets(region: string, accountId: string): Promise<CloudResource[]> {
    const ec2 = await this._makeEc2Client(region);
    const results: CloudResource[] = [];
    let nextToken: string | undefined = undefined;

    do {
      const resp = await retryWithBackoff(() =>
        ec2.send(new DescribeSubnetsCommand({ NextToken: nextToken })),
      );
      for (const subnet of resp.Subnets ?? []) {
        const id = safeString(subnet.SubnetId);
        if (!id) continue;
        const name = nameTag(subnet.Tags) || id;
        const config = {
          cidrBlock: subnet.CidrBlock ?? '10.0.1.0/24',
          vpcId: subnet.VpcId ?? null,
          availabilityZone: subnet.AvailabilityZone ?? `${region}a`,
          availableIpAddressCount: subnet.AvailableIpAddressCount ?? null,
          mapPublicIpOnLaunch: subnet.MapPublicIpOnLaunch ?? false,
          source: 'aws-api',
          imported: true,
        };
        results.push({
          id,
          provider: 'aws',
          accountId,
          region,
          resourceType: 'subnet',
          name,
          arn: `arn:aws:ec2:${region}:${accountId}:subnet/${id}`,
          resourceId: id,
          tags: tagsToMap(subnet.Tags),
          status: safeString(subnet.State) || 'available',
          configuration: config,
          parentResourceId: subnet.VpcId,
          metadata: { ownerId: subnet.OwnerId ?? accountId },
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
      nextToken = resp.NextToken;
    } while (nextToken);

    return results;
  }

  private async _discoverEc2Instances(region: string, accountId: string): Promise<CloudResource[]> {
    const ec2 = await this._makeEc2Client(region);
    const results: CloudResource[] = [];
    let nextToken: string | undefined = undefined;

    do {
      const resp = await retryWithBackoff(() =>
        ec2.send(new DescribeInstancesCommand({ NextToken: nextToken })),
      );
      for (const reservation of resp.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          const id = safeString(instance.InstanceId);
          if (!id) continue;
          const name = nameTag(instance.Tags) || id;
          const config = {
            instanceType: instance.InstanceType ?? 't3.medium',
            imageId: instance.ImageId ?? 'ami-unknown',
            vpcId: instance.VpcId ?? null,
            subnetId: instance.SubnetId ?? null,
            privateIpAddress: instance.PrivateIpAddress ?? null,
            publicIpAddress: instance.PublicIpAddress ?? null,
            architecture: instance.Architecture ?? 'x86_64',
            platform: instance.Platform ?? 'linux',
            keyName: instance.KeyName ?? '',
            securityGroupIds: (instance.SecurityGroups ?? []).map((sg) => sg.GroupId).filter(Boolean),
            blockDeviceMappings: (instance.BlockDeviceMappings ?? []).map((bdm) => ({
              deviceName: bdm.DeviceName,
              volumeId: bdm.Ebs?.VolumeId,
            })),
            source: 'aws-api',
            imported: true,
          };
          results.push({
            id,
            provider: 'aws',
            accountId,
            region,
            resourceType: 'ec2-instance',
            name,
            arn: `arn:aws:ec2:${region}:${accountId}:instance/${id}`,
            resourceId: id,
            tags: tagsToMap(instance.Tags),
            status: instance.State?.Name ?? 'running',
            configuration: config,
            parentResourceId: instance.SubnetId || instance.VpcId,
            metadata: {
              launchTime: instance.LaunchTime?.toISOString() ?? null,
            },
            configurationHash: computeConfigHash(config),
            discoveredAt: now(),
          });
        }
      }
      nextToken = resp.NextToken;
    } while (nextToken);

    return results;
  }

  private async _discoverInternetGateways(region: string, accountId: string): Promise<CloudResource[]> {
    const ec2 = await this._makeEc2Client(region);
    const results: CloudResource[] = [];
    try {
      const resp = await retryWithBackoff(() =>
        ec2.send(new DescribeInternetGatewaysCommand({})),
      );
      for (const igw of resp.InternetGateways ?? []) {
        const id = safeString(igw.InternetGatewayId);
        if (!id) continue;
        const name = nameTag(igw.Tags) || id;
        const attachedVpcId = igw.Attachments?.[0]?.VpcId ?? null;
        const config = {
          attachedVpcId,
          vpcId: attachedVpcId,
          source: 'aws-api',
          imported: true,
        };
        results.push({
          id,
          provider: 'aws',
          accountId,
          region,
          resourceType: 'internet-gateway',
          name,
          arn: `arn:aws:ec2:${region}:${accountId}:internet-gateway/${id}`,
          resourceId: id,
          tags: tagsToMap(igw.Tags),
          status: 'available',
          configuration: config,
          parentResourceId: attachedVpcId ?? undefined,
          metadata: { attachments: igw.Attachments ?? [] },
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
    } catch {
      // Ignored if permissions not granted
    }
    return results;
  }

  private async _discoverNatGateways(region: string, accountId: string): Promise<CloudResource[]> {
    const ec2 = await this._makeEc2Client(region);
    const results: CloudResource[] = [];
    try {
      const resp = await retryWithBackoff(() =>
        ec2.send(new DescribeNatGatewaysCommand({})),
      );
      for (const nat of resp.NatGateways ?? []) {
        const id = safeString(nat.NatGatewayId);
        if (!id) continue;
        const name = nameTag(nat.Tags) || id;
        const config = {
          vpcId: nat.VpcId ?? null,
          subnetId: nat.SubnetId ?? null,
          connectivityType: nat.ConnectivityType ?? 'public',
          publicIp: nat.NatGatewayAddresses?.[0]?.PublicIp ?? null,
          source: 'aws-api',
          imported: true,
        };
        results.push({
          id,
          provider: 'aws',
          accountId,
          region,
          resourceType: 'nat-gateway',
          name,
          arn: `arn:aws:ec2:${region}:${accountId}:natgateway/${id}`,
          resourceId: id,
          tags: tagsToMap(nat.Tags),
          status: safeString(nat.State) || 'available',
          configuration: config,
          parentResourceId: nat.SubnetId || nat.VpcId,
          metadata: {},
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
    } catch {
      // Best effort
    }
    return results;
  }

  private async _discoverRouteTables(region: string, accountId: string): Promise<CloudResource[]> {
    const ec2 = await this._makeEc2Client(region);
    const results: CloudResource[] = [];
    try {
      const resp = await retryWithBackoff(() =>
        ec2.send(new DescribeRouteTablesCommand({})),
      );
      for (const rt of resp.RouteTables ?? []) {
        const id = safeString(rt.RouteTableId);
        if (!id) continue;
        const name = nameTag(rt.Tags) || id;
        const isMain = rt.Associations?.some((a) => a.Main) ?? false;
        const associatedSubnetIds = (rt.Associations ?? [])
          .map((a) => a.SubnetId)
          .filter(Boolean);
        const config = {
          vpcId: rt.VpcId ?? null,
          isMain,
          associatedSubnetIds,
          routes: (rt.Routes ?? []).map((r) => ({
            destinationCidr: r.DestinationCidrBlock,
            gatewayId: r.GatewayId,
            natGatewayId: r.NatGatewayId,
          })),
          source: 'aws-api',
          imported: true,
        };
        results.push({
          id,
          provider: 'aws',
          accountId,
          region,
          resourceType: 'route-table',
          name,
          arn: `arn:aws:ec2:${region}:${accountId}:route-table/${id}`,
          resourceId: id,
          tags: tagsToMap(rt.Tags),
          status: 'available',
          configuration: config,
          parentResourceId: rt.VpcId,
          metadata: {},
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
    } catch {
      // Best effort
    }
    return results;
  }

  private async _discoverSecurityGroups(region: string, accountId: string): Promise<CloudResource[]> {
    const ec2 = await this._makeEc2Client(region);
    const results: CloudResource[] = [];
    try {
      const resp = await retryWithBackoff(() =>
        ec2.send(new DescribeSecurityGroupsCommand({})),
      );
      for (const sg of resp.SecurityGroups ?? []) {
        const id = safeString(sg.GroupId);
        if (!id) continue;
        const name = sg.GroupName || id;
        const config = {
          groupName: sg.GroupName,
          description: sg.Description,
          vpcId: sg.VpcId ?? null,
          allowHttp: (sg.IpPermissions ?? []).some((p) => p.FromPort === 80),
          allowHttps: (sg.IpPermissions ?? []).some((p) => p.FromPort === 443),
          allowSsh: (sg.IpPermissions ?? []).some((p) => p.FromPort === 22),
          source: 'aws-api',
          imported: true,
        };
        results.push({
          id,
          provider: 'aws',
          accountId,
          region,
          resourceType: 'security-group',
          name,
          arn: `arn:aws:ec2:${region}:${accountId}:security-group/${id}`,
          resourceId: id,
          tags: tagsToMap(sg.Tags),
          status: 'available',
          configuration: config,
          parentResourceId: sg.VpcId,
          metadata: {},
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
    } catch {
      // Best effort
    }
    return results;
  }

  private async _discoverVolumes(region: string, accountId: string): Promise<CloudResource[]> {
    const ec2 = await this._makeEc2Client(region);
    const results: CloudResource[] = [];
    try {
      const resp = await retryWithBackoff(() =>
        ec2.send(new DescribeVolumesCommand({})),
      );
      for (const vol of resp.Volumes ?? []) {
        const id = safeString(vol.VolumeId);
        if (!id) continue;
        const name = nameTag(vol.Tags) || id;
        const attachedInstanceId = vol.Attachments?.[0]?.InstanceId ?? null;
        const config = {
          sizeGb: vol.Size ?? 50,
          volumeType: vol.VolumeType ?? 'gp3',
          encrypted: vol.Encrypted ?? true,
          attachedInstanceId,
          source: 'aws-api',
          imported: true,
        };
        results.push({
          id,
          provider: 'aws',
          accountId,
          region,
          resourceType: 'ebs-volume',
          name,
          arn: `arn:aws:ec2:${region}:${accountId}:volume/${id}`,
          resourceId: id,
          tags: tagsToMap(vol.Tags),
          status: safeString(vol.State) || 'in-use',
          configuration: config,
          parentResourceId: attachedInstanceId ?? undefined,
          metadata: {},
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
    } catch {
      // Best effort
    }
    return results;
  }

  private async _discoverS3(accountId: string): Promise<CloudResource[]> {
    const s3 = await this._makeS3Client();
    const resp = await retryWithBackoff(() => s3.send(new ListBucketsCommand({})));
    const results: CloudResource[] = [];

    for (const bucket of resp.Buckets ?? []) {
      if (!bucket.Name) continue;
      let bucketRegion = this._credentials.region;
      try {
        const locResp = await retryWithBackoff(() =>
          s3.send(new GetBucketLocationCommand({ Bucket: bucket.Name })),
        );
        bucketRegion = locResp.LocationConstraint ?? 'us-east-1';
        if (bucketRegion === 'EU') bucketRegion = 'eu-west-1';
      } catch {
        // Fallback to configured region
      }

      const config = {
        bucketName: bucket.Name,
        region: bucketRegion,
        versioning: true,
        encryption: true,
        publicAccess: false,
        source: 'aws-api',
        imported: true,
      };

      results.push({
        id: `s3-${bucket.Name}`,
        provider: 'aws',
        accountId,
        region: bucketRegion,
        resourceType: 's3-bucket',
        name: bucket.Name,
        arn: `arn:aws:s3:::${bucket.Name}`,
        resourceId: bucket.Name,
        tags: {},
        status: 'available',
        configuration: config,
        metadata: {
          creationDate: bucket.CreationDate?.toISOString() ?? null,
        },
        configurationHash: computeConfigHash(config),
        discoveredAt: now(),
      });
    }

    return results;
  }

  private async _discoverRdsInstances(region: string, accountId: string): Promise<CloudResource[]> {
    const rds = await this._makeRdsClient(region);
    const resp = await retryWithBackoff(() => rds.send(new DescribeDBInstancesCommand({})));
    return (resp.DBInstances ?? []).map((db) => {
      const arn = safeString(db.DBInstanceArn);
      const name = db.DBInstanceIdentifier ?? 'unnamed-rds';
      const subnetGroupVpcId = db.DBSubnetGroup?.VpcId ?? null;
      const subnets = (db.DBSubnetGroup?.Subnets ?? []).map((s) => s.SubnetIdentifier);

      const config = {
        name,
        engine: db.Engine ?? 'postgres',
        engineVersion: db.EngineVersion ?? null,
        instanceClass: db.DBInstanceClass ?? 'db.t3.medium',
        multiAz: db.MultiAZ ?? false,
        storageType: db.StorageType ?? 'gp3',
        allocatedStorage: db.AllocatedStorage ?? 50,
        vpcId: subnetGroupVpcId,
        subnetId: subnets[0] ?? null,
        endpoint: db.Endpoint?.Address ?? null,
        port: db.Endpoint?.Port ?? 5432,
        securityGroupIds: (db.VpcSecurityGroups ?? []).map((sg) => sg.VpcSecurityGroupId),
        source: 'aws-api',
        imported: true,
      };

      return {
        id: db.DBInstanceIdentifier || arn,
        provider: 'aws',
        accountId,
        region,
        resourceType: 'rds-instance',
        name,
        arn,
        resourceId: db.DBInstanceIdentifier || arn,
        tags: tagsToMap(db.TagList),
        status: db.DBInstanceStatus ?? 'available',
        configuration: config,
        parentResourceId: subnets[0] || subnetGroupVpcId || undefined,
        metadata: {
          publiclyAccessible: db.PubliclyAccessible ?? false,
        },
        configurationHash: computeConfigHash(config),
        discoveredAt: now(),
      };
    });
  }

  private async _discoverLoadBalancers(region: string, accountId: string): Promise<CloudResource[]> {
    const elb = await this._makeElbClient(region);
    const resp = await retryWithBackoff(() => elb.send(new DescribeLoadBalancersCommand({})));
    return (resp.LoadBalancers ?? []).map((lb) => {
      const arn = safeString(lb.LoadBalancerArn);
      const name = lb.LoadBalancerName ?? 'unnamed-lb';
      const subnetIds = (lb.AvailabilityZones ?? []).map((az) => az.SubnetId).filter(Boolean);

      const config = {
        name,
        scheme: lb.Scheme ?? 'internet-facing',
        lbType: lb.Type === 'network' ? 'network' : 'application',
        vpcId: lb.VpcId ?? null,
        subnetId: subnetIds[0] ?? null,
        dnsName: lb.DNSName ?? null,
        securityGroupIds: lb.SecurityGroups ?? [],
        source: 'aws-api',
        imported: true,
      };

      return {
        id: lb.LoadBalancerName || arn,
        provider: 'aws',
        accountId,
        region,
        resourceType: lb.Type === 'network' ? 'nlb' : 'alb',
        name,
        arn,
        resourceId: lb.LoadBalancerName || arn,
        tags: {},
        status: lb.State?.Code ?? 'active',
        configuration: config,
        parentResourceId: subnetIds[0] || lb.VpcId,
        metadata: {
          availabilityZones: (lb.AvailabilityZones ?? []).map((az) => az.ZoneName),
        },
        configurationHash: computeConfigHash(config),
        discoveredAt: now(),
      };
    });
  }

  private async _discoverTargetGroups(region: string, accountId: string): Promise<CloudResource[]> {
    const elb = await this._makeElbClient(region);
    const results: CloudResource[] = [];
    try {
      const resp = await retryWithBackoff(() => elb.send(new DescribeTargetGroupsCommand({})));
      for (const tg of resp.TargetGroups ?? []) {
        const arn = safeString(tg.TargetGroupArn);
        const name = tg.TargetGroupName ?? 'tg';
        let targetInstanceIds: string[] = [];

        try {
          const health = await retryWithBackoff(() =>
            elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: arn })),
          );
          targetInstanceIds = (health.TargetHealthDescriptions ?? [])
            .map((th) => th.Target?.Id)
            .filter((id): id is string => Boolean(id));
        } catch {
          // Non-fatal
        }

        const config = {
          name,
          port: tg.Port,
          protocol: tg.Protocol,
          vpcId: tg.VpcId ?? null,
          targetType: tg.TargetType ?? 'instance',
          loadBalancerArns: tg.LoadBalancerArns ?? [],
          targetInstanceIds,
          source: 'aws-api',
          imported: true,
        };

        results.push({
          id: tg.TargetGroupName || arn,
          provider: 'aws',
          accountId,
          region,
          resourceType: 'target-group',
          name,
          arn,
          resourceId: tg.TargetGroupName || arn,
          tags: {},
          status: 'active',
          configuration: config,
          parentResourceId: tg.VpcId,
          metadata: {},
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
    } catch {
      // Best effort
    }
    return results;
  }

  private async _discoverLambdaFunctions(region: string, accountId: string): Promise<CloudResource[]> {
    const lambda = await this._makeLambdaClient(region);
    const results: CloudResource[] = [];
    try {
      let marker: string | undefined;
      do {
        const resp = await retryWithBackoff(() =>
          lambda.send(new ListFunctionsCommand({ Marker: marker })),
        );
        for (const fn of resp.Functions ?? []) {
          const name = safeString(fn.FunctionName);
          if (!name) continue;
          const vpcConfig = fn.VpcConfig;
          const subnetId = vpcConfig?.SubnetIds?.[0] ?? null;
          const config = {
            name,
            runtime: fn.Runtime ?? 'nodejs20.x',
            memorySize: fn.MemorySize ?? 512,
            timeout: fn.Timeout ?? 15,
            handler: fn.Handler ?? 'index.handler',
            architecture: (fn.Architectures ?? ['x86_64'])[0] ?? 'x86_64',
            environmentVariables: fn.Environment?.Variables ?? {},
            subnetId,
            vpcId: vpcConfig?.VpcId ?? null,
            securityGroupIds: vpcConfig?.SecurityGroupIds ?? [],
            source: 'aws-api',
            imported: true,
          };
          results.push({
            id: name,
            provider: 'aws',
            accountId,
            region,
            resourceType: 'lambda',
            name,
            arn: safeString(fn.FunctionArn),
            resourceId: name,
            tags: {},
            status: fn.State ?? 'Active',
            configuration: config,
            parentResourceId: subnetId || vpcConfig?.VpcId || undefined,
            metadata: { lastModified: fn.LastModified ?? null },
            configurationHash: computeConfigHash(config),
            discoveredAt: now(),
          });
        }
        marker = resp.NextMarker;
      } while (marker);
    } catch {
      // Best effort
    }
    return results;
  }

  private async _discoverDynamoDbTables(region: string, accountId: string): Promise<CloudResource[]> {
    const ddb = await this._makeDynamoDbClient(region);
    const results: CloudResource[] = [];
    try {
      const tableNames: string[] = [];
      let lastEvaluatedTableName: string | undefined;
      do {
        const resp = await retryWithBackoff(() =>
          ddb.send(new ListTablesCommand({ ExclusiveStartTableName: lastEvaluatedTableName })),
        );
        tableNames.push(...(resp.TableNames ?? []));
        lastEvaluatedTableName = resp.LastEvaluatedTableName;
      } while (lastEvaluatedTableName);

      for (const tableName of tableNames) {
        try {
          const desc = await retryWithBackoff(() =>
            ddb.send(new DescribeTableCommand({ TableName: tableName })),
          );
          const table = desc.Table;
          if (!table) continue;

          const keySchema = table.KeySchema ?? [];
          const partitionKeyName = keySchema.find((k) => k.KeyType === 'HASH')?.AttributeName ?? 'id';
          const sortKeyName = keySchema.find((k) => k.KeyType === 'RANGE')?.AttributeName ?? '';
          const attrType = (attrName: string): string =>
            table.AttributeDefinitions?.find((a) => a.AttributeName === attrName)?.AttributeType ?? 'S';

          const config = {
            name: tableName,
            tableName,
            billingMode: table.BillingModeSummary?.BillingMode ?? 'PAY_PER_REQUEST',
            readCapacity: table.ProvisionedThroughput?.ReadCapacityUnits ?? 5,
            writeCapacity: table.ProvisionedThroughput?.WriteCapacityUnits ?? 5,
            partitionKeyName,
            partitionKeyType: attrType(partitionKeyName),
            sortKeyName,
            sortKeyType: sortKeyName ? attrType(sortKeyName) : 'S',
            streamEnabled: table.StreamSpecification?.StreamEnabled ?? false,
            streamViewType: table.StreamSpecification?.StreamViewType ?? 'NEW_AND_OLD_IMAGES',
            tableClass: table.TableClassSummary?.TableClass ?? 'STANDARD',
            source: 'aws-api',
            imported: true,
          };

          results.push({
            id: tableName,
            provider: 'aws',
            accountId,
            region,
            resourceType: 'dynamodb-table',
            name: tableName,
            arn: safeString(table.TableArn),
            resourceId: tableName,
            tags: {},
            status: table.TableStatus ?? 'ACTIVE',
            configuration: config,
            metadata: { itemCount: table.ItemCount ?? 0 },
            configurationHash: computeConfigHash(config),
            discoveredAt: now(),
          });
        } catch {
          // Skip tables we can't describe (e.g. missing dynamodb:DescribeTable)
        }
      }
    } catch {
      // Best effort
    }
    return results;
  }

  private async _discoverEcsServices(region: string, accountId: string): Promise<CloudResource[]> {
    const ecs = await this._makeEcsClient(region);
    const results: CloudResource[] = [];
    try {
      const clusterArns: string[] = [];
      let nextToken: string | undefined;
      do {
        const resp = await retryWithBackoff(() => ecs.send(new ListEcsClustersCommand({ nextToken })));
        clusterArns.push(...(resp.clusterArns ?? []));
        nextToken = resp.nextToken;
      } while (nextToken);

      for (const clusterArn of clusterArns) {
        try {
          const serviceArns: string[] = [];
          let svcToken: string | undefined;
          do {
            const resp = await retryWithBackoff(() =>
              ecs.send(new ListServicesCommand({ cluster: clusterArn, nextToken: svcToken })),
            );
            serviceArns.push(...(resp.serviceArns ?? []));
            svcToken = resp.nextToken;
          } while (svcToken);
          if (serviceArns.length === 0) continue;

          // DescribeServices accepts at most 10 service ARNs per call.
          for (let i = 0; i < serviceArns.length; i += 10) {
            const batch = serviceArns.slice(i, i + 10);
            const descResp = await retryWithBackoff(() =>
              ecs.send(new DescribeServicesCommand({ cluster: clusterArn, services: batch })),
            );
            for (const svc of descResp.services ?? []) {
              const name = safeString(svc.serviceName);
              if (!name) continue;

              let cpu = 256;
              let memory = 512;
              let containerImage = 'nginx:latest';
              let containerPort = 80;
              if (svc.taskDefinition) {
                try {
                  const tdResp = await retryWithBackoff(() =>
                    ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: svc.taskDefinition })),
                  );
                  const td = tdResp.taskDefinition;
                  if (td) {
                    cpu = Number(td.cpu) || cpu;
                    memory = Number(td.memory) || memory;
                    const container = td.containerDefinitions?.[0];
                    if (container) {
                      containerImage = container.image ?? containerImage;
                      containerPort = container.portMappings?.[0]?.containerPort ?? containerPort;
                    }
                  }
                } catch {
                  // Best effort — keep defaults if task definition lookup fails
                }
              }

              const netConfig = svc.networkConfiguration?.awsvpcConfiguration;
              const subnetId = netConfig?.subnets?.[0] ?? null;
              const config = {
                name,
                launchType: svc.launchType ?? 'FARGATE',
                desiredCount: svc.desiredCount ?? 1,
                cpu,
                memory,
                containerImage,
                containerPort,
                assignPublicIp: netConfig?.assignPublicIp === 'ENABLED',
                subnetId,
                securityGroupIds: netConfig?.securityGroups ?? [],
                source: 'aws-api',
                imported: true,
              };

              results.push({
                id: name,
                provider: 'aws',
                accountId,
                region,
                resourceType: 'ecs',
                name,
                arn: safeString(svc.serviceArn),
                resourceId: name,
                tags: {},
                status: svc.status ?? 'ACTIVE',
                configuration: config,
                parentResourceId: subnetId ?? undefined,
                metadata: { clusterArn },
                configurationHash: computeConfigHash(config),
                discoveredAt: now(),
              });
            }
          }
        } catch {
          // Best effort per cluster
        }
      }
    } catch {
      // Best effort
    }
    return results;
  }

  private async _discoverEksClusters(region: string, accountId: string): Promise<CloudResource[]> {
    const eks = await this._makeEksClient(region);
    const results: CloudResource[] = [];
    try {
      const clusterNames: string[] = [];
      let nextToken: string | undefined;
      do {
        const resp = await retryWithBackoff(() => eks.send(new ListEksClustersCommand({ nextToken })));
        clusterNames.push(...(resp.clusters ?? []));
        nextToken = resp.nextToken;
      } while (nextToken);

      for (const clusterName of clusterNames) {
        try {
          const descResp = await retryWithBackoff(() =>
            eks.send(new DescribeClusterCommand({ name: clusterName })),
          );
          const cluster = descResp.cluster;
          if (!cluster) continue;

          let nodeInstanceType = 't3.medium';
          let nodeCount = 3;
          let capacityType = 'ON_DEMAND';
          let nodeDiskSizeGb = 20;
          try {
            const ngListResp = await retryWithBackoff(() =>
              eks.send(new ListNodegroupsCommand({ clusterName })),
            );
            const firstNg = ngListResp.nodegroups?.[0];
            if (firstNg) {
              const ngResp = await retryWithBackoff(() =>
                eks.send(new DescribeNodegroupCommand({ clusterName, nodegroupName: firstNg })),
              );
              const ng = ngResp.nodegroup;
              if (ng) {
                nodeInstanceType = ng.instanceTypes?.[0] ?? nodeInstanceType;
                nodeCount = ng.scalingConfig?.desiredSize ?? nodeCount;
                capacityType = ng.capacityType ?? capacityType;
                nodeDiskSizeGb = ng.diskSize ?? nodeDiskSizeGb;
              }
            }
          } catch {
            // Best effort — node group details are supplementary
          }

          const subnetId = cluster.resourcesVpcConfig?.subnetIds?.[0] ?? null;
          const vpcId = cluster.resourcesVpcConfig?.vpcId ?? null;
          const config = {
            name: clusterName,
            version: cluster.version ?? '1.30',
            nodeCount,
            nodeInstanceType,
            capacityType,
            nodeDiskSizeGb,
            endpointPublicAccess: cluster.resourcesVpcConfig?.endpointPublicAccess ?? true,
            endpointPrivateAccess: cluster.resourcesVpcConfig?.endpointPrivateAccess ?? false,
            publicAccessCidrs: (cluster.resourcesVpcConfig?.publicAccessCidrs ?? ['0.0.0.0/0']).join(','),
            clusterLogTypes: (cluster.logging?.clusterLogging ?? [])
              .filter((l) => l.enabled)
              .flatMap((l) => l.types ?? []),
            secretsEncryption: (cluster.encryptionConfig ?? []).length > 0,
            vpcId,
            subnetId,
            securityGroupIds: cluster.resourcesVpcConfig?.securityGroupIds ?? [],
            source: 'aws-api',
            imported: true,
          };

          results.push({
            id: clusterName,
            provider: 'aws',
            accountId,
            region,
            resourceType: 'eks',
            name: clusterName,
            arn: safeString(cluster.arn),
            resourceId: clusterName,
            tags: cluster.tags ?? {},
            status: cluster.status ?? 'ACTIVE',
            configuration: config,
            parentResourceId: subnetId || vpcId || undefined,
            metadata: {},
            configurationHash: computeConfigHash(config),
            discoveredAt: now(),
          });
        } catch {
          // Best effort per cluster
        }
      }
    } catch {
      // Best effort
    }
    return results;
  }

  private async _discoverIamRoles(accountId: string): Promise<CloudResource[]> {
    const iam = await this._makeIamClient();
    const results: CloudResource[] = [];
    try {
      let marker: string | undefined;
      do {
        const resp = await retryWithBackoff(() => iam.send(new ListRolesCommand({ Marker: marker })));
        for (const role of resp.Roles ?? []) {
          const name = safeString(role.RoleName);
          if (!name) continue;
          // Skip AWS service-linked roles — not user-managed infrastructure.
          if (role.Path?.startsWith('/aws-service-role/')) continue;

          let trustedService = 'ec2.amazonaws.com';
          try {
            const policyDoc = role.AssumeRolePolicyDocument
              ? JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument))
              : null;
            const principal = policyDoc?.Statement?.[0]?.Principal?.Service;
            if (typeof principal === 'string') trustedService = principal;
            else if (Array.isArray(principal) && principal[0]) trustedService = principal[0];
          } catch {
            // Best effort — keep default if the trust policy can't be parsed
          }

          let managedPolicyArns: string[] = [];
          try {
            const policiesResp = await retryWithBackoff(() =>
              iam.send(new ListAttachedRolePoliciesCommand({ RoleName: name })),
            );
            managedPolicyArns = (policiesResp.AttachedPolicies ?? [])
              .map((p) => p.PolicyArn)
              .filter((arn): arn is string => Boolean(arn));
          } catch {
            // Best effort
          }

          const config = {
            name,
            trustedService,
            managedPolicyArns,
            maxSessionDurationSeconds: role.MaxSessionDuration ?? 3600,
            source: 'aws-api',
            imported: true,
          };

          results.push({
            id: name,
            provider: 'aws',
            accountId,
            region: 'global',
            resourceType: 'iam-role',
            name,
            arn: safeString(role.Arn),
            resourceId: name,
            tags: {},
            status: 'active',
            configuration: config,
            metadata: { createDate: role.CreateDate?.toISOString() ?? null },
            configurationHash: computeConfigHash(config),
            discoveredAt: now(),
          });
        }
        marker = resp.Marker;
      } while (marker);
    } catch {
      // Best effort
    }
    return results;
  }

  private async _discoverElastiCacheClusters(region: string, accountId: string): Promise<CloudResource[]> {
    const ec = await this._makeElastiCacheClient(region);
    const results: CloudResource[] = [];
    try {
      // Replication group state (automatic failover / Multi-AZ) is looked up
      // per group on demand, since DescribeCacheClusters doesn't return it.
      const replicationGroupCache = new Map<string, { automaticFailover: boolean; multiAz: boolean }>();

      let marker: string | undefined;
      do {
        const resp = await retryWithBackoff(() =>
          ec.send(new DescribeCacheClustersCommand({ Marker: marker, ShowCacheNodeInfo: true })),
        );
        for (const cluster of resp.CacheClusters ?? []) {
          const id = safeString(cluster.CacheClusterId);
          if (!id) continue;

          let automaticFailoverEnabled = false;
          let multiAzEnabled = false;
          const replicationGroupId = cluster.ReplicationGroupId;
          if (replicationGroupId) {
            if (!replicationGroupCache.has(replicationGroupId)) {
              try {
                const rgResp = await retryWithBackoff(() =>
                  ec.send(new DescribeReplicationGroupsCommand({ ReplicationGroupId: replicationGroupId })),
                );
                const rg = rgResp.ReplicationGroups?.[0];
                replicationGroupCache.set(replicationGroupId, {
                  automaticFailover: rg?.AutomaticFailover === 'enabled',
                  multiAz: rg?.MultiAZ === 'enabled',
                });
              } catch {
                replicationGroupCache.set(replicationGroupId, { automaticFailover: false, multiAz: false });
              }
            }
            const rgInfo = replicationGroupCache.get(replicationGroupId)!;
            automaticFailoverEnabled = rgInfo.automaticFailover;
            multiAzEnabled = rgInfo.multiAz;
          }

          const config = {
            name: id,
            engine: cluster.Engine ?? 'redis',
            engineVersion: cluster.EngineVersion ?? '7.1',
            nodeType: cluster.CacheNodeType ?? 'cache.t3.medium',
            numNodes: cluster.NumCacheNodes ?? 1,
            automaticFailoverEnabled,
            multiAzEnabled,
            transitEncryption: cluster.TransitEncryptionEnabled ?? false,
            atRestEncryption: cluster.AtRestEncryptionEnabled ?? false,
            port: cluster.CacheNodeType ? (cluster.CacheNodes?.[0]?.Endpoint?.Port ?? 6379) : 6379,
            snapshotRetentionLimit: cluster.SnapshotRetentionLimit ?? 0,
            source: 'aws-api',
            imported: true,
          };

          results.push({
            id,
            provider: 'aws',
            accountId,
            region,
            resourceType: 'elasticache',
            name: id,
            arn: safeString(cluster.ARN),
            resourceId: id,
            tags: {},
            status: cluster.CacheClusterStatus ?? 'available',
            configuration: config,
            metadata: { replicationGroupId: replicationGroupId ?? null },
            configurationHash: computeConfigHash(config),
            discoveredAt: now(),
          });
        }
        marker = resp.Marker;
      } while (marker);
    } catch {
      // Best effort
    }
    return results;
  }

  // ── Relationship & Topology Reconstructor ────────────────────────────────

  private _reconstructAwsRelationships(catalog: {
    vpcs: CloudResource[];
    subnets: CloudResource[];
    instances: CloudResource[];
    igws: CloudResource[];
    nats: CloudResource[];
    routeTables: CloudResource[];
    sgs: CloudResource[];
    volumes: CloudResource[];
    rdsList: CloudResource[];
    lbs: CloudResource[];
    tgs: CloudResource[];
    lambdas: CloudResource[];
    ecsServices: CloudResource[];
    eksClusters: CloudResource[];
    elastiCacheClusters: CloudResource[];
  }): CloudRelationship[] {
    const rels: CloudRelationship[] = [];
    const added = new Set<string>();

    const addRel = (source: string, target: string, type: CloudRelationship['relationshipType'], label?: string) => {
      if (!source || !target || source === target) return;
      const key = `${source}->${target}:${type}`;
      if (added.has(key)) return;
      added.add(key);
      rels.push({
        sourceResourceId: source,
        targetResourceId: target,
        relationshipType: type,
        label,
      });
    };

    // 1. Subnet in VPC (Containment)
    for (const subnet of catalog.subnets) {
      const vpcId = subnet.configuration.vpcId as string;
      if (vpcId) addRel(vpcId, subnet.id, 'containment', 'Subnet in VPC');
    }

    // 2. EC2 in Subnet (Containment & Network)
    for (const ec2 of catalog.instances) {
      const subnetId = ec2.configuration.subnetId as string;
      const vpcId = ec2.configuration.vpcId as string;
      if (subnetId) {
        addRel(subnetId, ec2.id, 'containment', 'Compute in Subnet');
      } else if (vpcId) {
        addRel(vpcId, ec2.id, 'containment', 'Compute in VPC');
      }
    }

    // 3. RDS in Subnet / VPC
    for (const rds of catalog.rdsList) {
      const subnetId = rds.configuration.subnetId as string;
      const vpcId = rds.configuration.vpcId as string;
      if (subnetId) {
        addRel(subnetId, rds.id, 'containment', 'Database in Subnet');
      } else if (vpcId) {
        addRel(vpcId, rds.id, 'containment', 'Database in VPC');
      }
    }

    // 4. ALB in Subnet / VPC
    for (const lb of catalog.lbs) {
      const subnetId = lb.configuration.subnetId as string;
      const vpcId = lb.configuration.vpcId as string;
      if (subnetId) {
        addRel(subnetId, lb.id, 'containment', 'Load Balancer in Subnet');
      } else if (vpcId) {
        addRel(vpcId, lb.id, 'containment', 'Load Balancer in VPC');
      }
    }

    // 4b. Lambda in Subnet / VPC (VPC-attached functions only)
    for (const fn of catalog.lambdas) {
      const subnetId = fn.configuration.subnetId as string;
      const vpcId = fn.configuration.vpcId as string;
      if (subnetId) {
        addRel(subnetId, fn.id, 'containment', 'Function in Subnet');
      } else if (vpcId) {
        addRel(vpcId, fn.id, 'containment', 'Function in VPC');
      }
    }

    // 4c. ECS services / EKS clusters in Subnet / VPC
    for (const svc of catalog.ecsServices) {
      const subnetId = svc.configuration.subnetId as string;
      if (subnetId) addRel(subnetId, svc.id, 'containment', 'Service in Subnet');
    }
    for (const cluster of catalog.eksClusters) {
      const subnetId = cluster.configuration.subnetId as string;
      const vpcId = cluster.configuration.vpcId as string;
      if (subnetId) {
        addRel(subnetId, cluster.id, 'containment', 'Cluster in Subnet');
      } else if (vpcId) {
        addRel(vpcId, cluster.id, 'containment', 'Cluster in VPC');
      }
    }

    // 5. Internet Gateway to VPC
    for (const igw of catalog.igws) {
      const vpcId = (igw.configuration.attachedVpcId as string) || (igw.configuration.vpcId as string);
      if (vpcId) addRel(igw.id, vpcId, 'network', 'IGW attached to VPC');
    }

    // 6. NAT Gateway to Subnet
    for (const nat of catalog.nats) {
      const subnetId = nat.configuration.subnetId as string;
      if (subnetId) addRel(subnetId, nat.id, 'network', 'NAT in Subnet');
    }

    // 7. Route Table to Subnets
    for (const rt of catalog.routeTables) {
      const subnets = (rt.configuration.associatedSubnetIds as string[]) ?? [];
      for (const sId of subnets) {
        addRel(rt.id, sId, 'association', 'Route Table Association');
      }
    }

    // 8. ALB -> Target Group -> EC2 (Traffic Flow)
    for (const tg of catalog.tgs) {
      const lbArns = (tg.configuration.loadBalancerArns as string[]) ?? [];
      for (const lbArn of lbArns) {
        // Find matching LB
        const lb = catalog.lbs.find((l) => l.arn === lbArn || l.id === lbArn);
        if (lb) addRel(lb.id, tg.id, 'traffic', 'Forwards to');
      }
      const instanceIds = (tg.configuration.targetInstanceIds as string[]) ?? [];
      for (const iId of instanceIds) {
        const inst = catalog.instances.find((i) => i.id === iId || i.resourceId === iId);
        if (inst) addRel(tg.id, inst.id, 'traffic', 'Targets');
      }
    }

    // 9. Security Groups to Resources
    for (const sg of catalog.sgs) {
      for (const ec2 of catalog.instances) {
        const sgIds = (ec2.configuration.securityGroupIds as string[]) ?? [];
        if (sgIds.includes(sg.id) || sgIds.includes(sg.resourceId)) {
          addRel(sg.id, ec2.id, 'security', 'Protects');
        }
      }
      for (const rds of catalog.rdsList) {
        const sgIds = (rds.configuration.securityGroupIds as string[]) ?? [];
        if (sgIds.includes(sg.id) || sgIds.includes(sg.resourceId)) {
          addRel(sg.id, rds.id, 'security', 'Protects');
        }
      }
      for (const fn of catalog.lambdas) {
        const sgIds = (fn.configuration.securityGroupIds as string[]) ?? [];
        if (sgIds.includes(sg.id) || sgIds.includes(sg.resourceId)) {
          addRel(sg.id, fn.id, 'security', 'Protects');
        }
      }
      for (const svc of catalog.ecsServices) {
        const sgIds = (svc.configuration.securityGroupIds as string[]) ?? [];
        if (sgIds.includes(sg.id) || sgIds.includes(sg.resourceId)) {
          addRel(sg.id, svc.id, 'security', 'Protects');
        }
      }
      for (const cluster of catalog.eksClusters) {
        const sgIds = (cluster.configuration.securityGroupIds as string[]) ?? [];
        if (sgIds.includes(sg.id) || sgIds.includes(sg.resourceId)) {
          addRel(sg.id, cluster.id, 'security', 'Protects');
        }
      }
    }

    // 10. EC2 to EBS Volume Attachment
    for (const vol of catalog.volumes) {
      const instanceId = vol.configuration.attachedInstanceId as string;
      if (instanceId) {
        const inst = catalog.instances.find((i) => i.id === instanceId || i.resourceId === instanceId);
        if (inst) addRel(inst.id, vol.id, 'storage', 'Attached Volume');
      }
    }

    return rels;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    this._sessionCredentials = null;
  }
}

// ─── Summary builder ──────────────────────────────────────────────────────────

function buildSummary(resources: Array<DiscoveredResource | CloudResource>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of resources) {
    counts[r.resourceType] = (counts[r.resourceType] ?? 0) + 1;
  }
  return counts;
}

// ─── Error sanitiser ──────────────────────────────────────────────────────────

function sanitiseAwsError(message: string): string {
  return message
    .replace(/\s*\(Service:[^)]*\)/gi, '')
    .replace(/\s*Request ID:\s*[0-9a-f-]+/gi, '')
    .replace(/arn:[a-z0-9*-]+:[a-z0-9*-]+:[^:\s]*:[^:\s]*:[^\s,)]+/gi, '[arn]')
    .trim();
}
