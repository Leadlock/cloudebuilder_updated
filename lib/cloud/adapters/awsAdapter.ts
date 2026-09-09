/**
 * AWS Discovery Adapter
 *
 * Uses AWS SDK v3 with STS cross-account role assumption (AssumeRole).
 * Discovers: VPCs, Subnets, EC2 instances, S3 buckets, RDS instances, ALBs/NLBs.
 *
 * Security contract:
 * - Credentials are accepted at construction time and used only inside this file.
 * - Temporary STS credentials are never logged or returned to callers.
 * - Only sanitised resource data is returned in DiscoveredResource objects.
 * - All log statements use structured, credential-free messages.
 */
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EC2Client, DescribeVpcsCommand, DescribeSubnetsCommand, DescribeInstancesCommand, DescribeInternetGatewaysCommand } from '@aws-sdk/client-ec2';
import { S3Client, ListBucketsCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import type {
  AwsRoleCredentials,
  DiscoveredResource,
  DiscoveryResult,
  AccountValidationResult,
  AwsAccountIdentity,
} from '../types';
import type { InfrastructureDiscoveryProvider } from '../provider';

// ─── Minimum required permissions for discovery ───────────────────────────────

const REQUIRED_PERMISSIONS = [
  'ec2:DescribeVpcs',
  'ec2:DescribeSubnets',
  'ec2:DescribeInstances',
  'ec2:DescribeInternetGateways',
  's3:ListAllMyBuckets',
  'rds:DescribeDBInstances',
  'elasticloadbalancing:DescribeLoadBalancers',
  'sts:GetCallerIdentity',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nameTag(tags: Array<{ Key?: string; Value?: string }> | undefined): string {
  return tags?.find((t) => t.Key === 'Name')?.Value ?? '';
}

function now(): string {
  return new Date().toISOString();
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class AwsDiscoveryAdapter implements InfrastructureDiscoveryProvider {
  readonly provider = 'aws' as const;

  private readonly _credentials: AwsRoleCredentials;
  // Resolved STS session — populated lazily, never returned externally
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
    const assumed = await stsClient.send(
      new AssumeRoleCommand({
        RoleArn: this._credentials.roleArn,
        RoleSessionName: 'cloudcraft-discovery',
        ExternalId: this._credentials.externalId,
        DurationSeconds: 3600,
      }),
    );

    if (
      !assumed.Credentials?.AccessKeyId ||
      !assumed.Credentials?.SecretAccessKey ||
      !assumed.Credentials?.SessionToken
    ) {
      throw new Error('STS AssumeRole did not return valid credentials');
    }

    // Store in memory only — never logged, never serialised
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

      const identity = await stsClient.send(new GetCallerIdentityCommand({}));
      if (!identity.Account || !identity.Arn || !identity.UserId) {
        return {
          valid: false,
          permissionsOk: false,
          missingPermissions: REQUIRED_PERMISSIONS,
          error: 'STS GetCallerIdentity returned incomplete response',
        };
      }

      // Attempt lightweight EC2 call to confirm read permissions
      const ec2 = await this._makeEc2Client(this._credentials.region);
      const missingPermissions: string[] = [];
      try {
        await ec2.send(new DescribeVpcsCommand({ MaxResults: 5 }));
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
      // Log the full message server-side for diagnostics
      console.error('[AwsDiscoveryAdapter] validateAccount failed:', message);
      // Return a sanitised message — strip AWS request IDs and ARNs so they
      // don't leak into API responses. AWS SDK errors follow the pattern
      // "ErrorCode: human message (Service: STS, Status Code: N, Request ID: uuid)"
      const sanitised = sanitiseAwsError(message);
      return {
        valid: false,
        permissionsOk: false,
        missingPermissions: REQUIRED_PERMISSIONS,
        error: sanitised,
      };
    }
  }

  // ── Discovery ────────────────────────────────────────────────────────────

  async discoverAll(): Promise<DiscoveryResult> {
    const startedAt = now();
    const resources: DiscoveredResource[] = [];
    const regions = [
      this._credentials.region,
      ...(this._credentials.additionalRegions ?? []),
    ];

    // Deduplicate regions
    const uniqueRegions = [...new Set(regions)];

    let accountId = 'unknown';
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
      const identity = await stsClient.send(new GetCallerIdentityCommand({}));
      accountId = identity.Account ?? 'unknown';
    } catch (err) {
      console.error('[AwsDiscoveryAdapter] Failed to resolve caller identity:', err instanceof Error ? err.message : String(err));
    }

    try {
      // Run S3 globally (S3 is global service)
      const s3Resources = await this._discoverS3();
      resources.push(...s3Resources);

      // Discover region-scoped resources
      for (const region of uniqueRegions) {
        try {
          const [vpcs, subnets, ec2, rdsList, lbs] = await Promise.all([
            this._discoverVpcs(region),
            this._discoverSubnets(region),
            this._discoverEc2Instances(region),
            this._discoverRdsInstances(region),
            this._discoverLoadBalancers(region),
          ]);
          resources.push(...vpcs, ...subnets, ...ec2, ...rdsList, ...lbs);
        } catch (regionErr) {
          console.error(
            `[AwsDiscoveryAdapter] Region ${region} partial failure:`,
            regionErr instanceof Error ? regionErr.message : String(regionErr),
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AwsDiscoveryAdapter] discoverAll failed:', message);
      return {
        accountId,
        provider: 'aws',
        status: 'failed',
        startedAt,
        completedAt: now(),
        resources: [],
        error: sanitiseAwsError(message),
        summary: {},
      };
    }

    const summary = buildSummary(resources);
    return {
      accountId,
      provider: 'aws',
      status: 'completed',
      startedAt,
      completedAt: now(),
      resources,
      summary,
    };
  }

  // ── Per-service discovery helpers ────────────────────────────────────────

  private async _discoverVpcs(region: string): Promise<DiscoveredResource[]> {
    const ec2 = await this._makeEc2Client(region);
    const resp = await ec2.send(new DescribeVpcsCommand({}));
    return (resp.Vpcs ?? []).map((vpc) => ({
      providerResourceId: safeString(vpc.VpcId),
      resourceType: 'vpc' as const,
      provider: 'aws' as const,
      name: nameTag(vpc.Tags) || safeString(vpc.VpcId),
      region,
      status: safeString(vpc.State),
      configuration: {
        cidrBlock: vpc.CidrBlock ?? null,
        isDefault: vpc.IsDefault ?? false,
        dhcpOptionsId: vpc.DhcpOptionsId ?? null,
        instanceTenancy: vpc.InstanceTenancy ?? null,
      },
      metadata: {
        tags: vpc.Tags ?? [],
        ownerId: vpc.OwnerId ?? null,
      },
    }));
  }

  private async _discoverSubnets(region: string): Promise<DiscoveredResource[]> {
    const ec2 = await this._makeEc2Client(region);
    const resp = await ec2.send(new DescribeSubnetsCommand({}));
    return (resp.Subnets ?? []).map((subnet) => ({
      providerResourceId: safeString(subnet.SubnetId),
      resourceType: 'subnet' as const,
      provider: 'aws' as const,
      name: nameTag(subnet.Tags) || safeString(subnet.SubnetId),
      region,
      status: safeString(subnet.State),
      configuration: {
        cidrBlock: subnet.CidrBlock ?? null,
        vpcId: subnet.VpcId ?? null,
        availabilityZone: subnet.AvailabilityZone ?? null,
        availableIpAddressCount: subnet.AvailableIpAddressCount ?? null,
        mapPublicIpOnLaunch: subnet.MapPublicIpOnLaunch ?? false,
      },
      metadata: {
        tags: subnet.Tags ?? [],
        ownerId: subnet.OwnerId ?? null,
      },
    }));
  }

  private async _discoverEc2Instances(region: string): Promise<DiscoveredResource[]> {
    const ec2 = await this._makeEc2Client(region);
    const resp = await ec2.send(new DescribeInstancesCommand({}));
    const results: DiscoveredResource[] = [];
    for (const reservation of resp.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        results.push({
          providerResourceId: safeString(instance.InstanceId),
          resourceType: 'ec2-instance',
          provider: 'aws',
          name: nameTag(instance.Tags) || safeString(instance.InstanceId),
          region,
          status: instance.State?.Name ?? 'unknown',
          configuration: {
            instanceType: instance.InstanceType ?? null,
            imageId: instance.ImageId ?? null,
            vpcId: instance.VpcId ?? null,
            subnetId: instance.SubnetId ?? null,
            privateIpAddress: instance.PrivateIpAddress ?? null,
            publicIpAddress: instance.PublicIpAddress ?? null,
            architecture: instance.Architecture ?? null,
            platform: instance.Platform ?? null,
          },
          metadata: {
            tags: instance.Tags ?? [],
            securityGroups: (instance.SecurityGroups ?? []).map((sg) => ({
              id: sg.GroupId,
              name: sg.GroupName,
            })),
            launchTime: instance.LaunchTime?.toISOString() ?? null,
            keyName: instance.KeyName ?? null,
          },
        });
      }
    }
    return results;
  }

  private async _discoverS3(): Promise<DiscoveredResource[]> {
    const s3 = await this._makeS3Client();
    const resp = await s3.send(new ListBucketsCommand({}));
    const results: DiscoveredResource[] = [];

    for (const bucket of resp.Buckets ?? []) {
      if (!bucket.Name) continue;
      let bucketRegion = this._credentials.region;
      try {
        const locResp = await s3.send(new GetBucketLocationCommand({ Bucket: bucket.Name }));
        bucketRegion = locResp.LocationConstraint ?? 'us-east-1';
      } catch {
        // Non-fatal — use default region
      }
      results.push({
        providerResourceId: `arn:aws:s3:::${bucket.Name}`,
        resourceType: 's3-bucket',
        provider: 'aws',
        name: bucket.Name,
        region: bucketRegion,
        status: 'available',
        configuration: {
          bucketName: bucket.Name,
          region: bucketRegion,
        },
        metadata: {
          creationDate: bucket.CreationDate?.toISOString() ?? null,
        },
      });
    }
    return results;
  }

  private async _discoverRdsInstances(region: string): Promise<DiscoveredResource[]> {
    const rds = await this._makeRdsClient(region);
    const resp = await rds.send(new DescribeDBInstancesCommand({}));
    return (resp.DBInstances ?? []).map((db) => ({
      providerResourceId: safeString(db.DBInstanceArn),
      resourceType: 'rds-instance' as const,
      provider: 'aws' as const,
      name: db.DBInstanceIdentifier ?? 'unnamed-rds',
      region,
      status: db.DBInstanceStatus ?? 'unknown',
      configuration: {
        engine: db.Engine ?? null,
        engineVersion: db.EngineVersion ?? null,
        instanceClass: db.DBInstanceClass ?? null,
        multiAZ: db.MultiAZ ?? false,
        storageType: db.StorageType ?? null,
        allocatedStorage: db.AllocatedStorage ?? null,
        vpcId: db.DBSubnetGroup?.VpcId ?? null,
        endpoint: db.Endpoint?.Address ?? null,
        port: db.Endpoint?.Port ?? null,
      },
      metadata: {
        tags: db.TagList ?? [],
        backupRetentionPeriod: db.BackupRetentionPeriod ?? null,
        preferredBackupWindow: db.PreferredBackupWindow ?? null,
        publiclyAccessible: db.PubliclyAccessible ?? false,
      },
    }));
  }

  private async _discoverLoadBalancers(region: string): Promise<DiscoveredResource[]> {
    const elb = await this._makeElbClient(region);
    const resp = await elb.send(new DescribeLoadBalancersCommand({}));
    return (resp.LoadBalancers ?? []).map((lb) => ({
      providerResourceId: safeString(lb.LoadBalancerArn),
      resourceType: lb.Type === 'network' ? ('nlb' as const) : ('alb' as const),
      provider: 'aws' as const,
      name: lb.LoadBalancerName ?? 'unnamed-lb',
      region,
      status: lb.State?.Code ?? 'unknown',
      configuration: {
        scheme: lb.Scheme ?? null,
        type: lb.Type ?? null,
        vpcId: lb.VpcId ?? null,
        dnsName: lb.DNSName ?? null,
        ipAddressType: lb.IpAddressType ?? null,
      },
      metadata: {
        availabilityZones: (lb.AvailabilityZones ?? []).map((az) => az.ZoneName),
        createdTime: lb.CreatedTime?.toISOString() ?? null,
      },
    }));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    // Clear the cached STS session credentials from memory
    this._sessionCredentials = null;
  }
}

// ─── Summary builder ──────────────────────────────────────────────────────────

function buildSummary(resources: DiscoveredResource[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of resources) {
    counts[r.resourceType] = (counts[r.resourceType] ?? 0) + 1;
  }
  return counts;
}

// ─── Error sanitiser ──────────────────────────────────────────────────────────

/**
 * Strip AWS-specific metadata from error messages before returning them to the client.
 * AWS SDK errors may include:
 *   - Request IDs: "Request ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *   - ARNs: "arn:aws:iam::123456789012:role/…"
 *   - "(Service: STS, Status Code: 403, ...)" suffixes
 *
 * We retain the human-readable error code + short message only.
 */
function sanitiseAwsError(message: string): string {
  return message
    // Remove "(Service: X, Status Code: N, Request ID: uuid, Extended Request ID: ...)"
    .replace(/\s*\(Service:[^)]*\)/gi, '')
    // Remove standalone Request ID references
    .replace(/\s*Request ID:\s*[0-9a-f-]+/gi, '')
    // Remove ARNs
    .replace(/arn:[a-z0-9*-]+:[a-z0-9*-]+:[^:\s]*:[^:\s]*:[^\s,)]+/gi, '[arn]')
    .trim();
}
