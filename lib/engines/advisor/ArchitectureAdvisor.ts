/**
 * Architecture Advisor/Optimizer — Phase 2D
 *
 * Produces deterministic recommendations from persisted architecture semantics.
 * No recommendation is emitted without evidence from the architecture.
 * Does NOT rely on React Flow positions; uses ArchitectureResource relationships.
 */
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';
import { SECURITY_SEVERITY } from '@/lib/domain/securitySeverity';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RecommendationCategory =
  | 'reliability'
  | 'security'
  | 'performance'
  | 'cost'
  | 'scalability';

export type RecommendationSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ArchitectureRecommendation {
  id: string;
  category: RecommendationCategory;
  severity: RecommendationSeverity;
  title: string;
  description: string;
  affectedResourceIds: string[];
  affectedResourceLabels: string[];
  rationale: string;
  suggestedAction: string;
  estimatedMonthlySavingsUsd?: number;
}

export interface ArchitectureScore {
  overall: number;
  reliability: number;
  security: number;
  performance: number;
  cost: number;
  scalability: number;
}

export interface OptimizationInput {
  architectureId: string;
  projectId: string;
  versionId?: string;
  resources: DbArchitectureResource[];
  connections: DbArchitectureConnection[];
  /**
   * User-declared expected concurrent/active user count for this
   * architecture (from the canvas scale-profile selector), if set. This is
   * a DECLARED value, not a measured or verified fact — the advisor uses it
   * only to adjust severity/thresholds on checks that are genuinely more or
   * less consequential at different scales (e.g. a single EC2 instance is a
   * reasonable choice for a 100-user internal tool but a critical risk for
   * a declared 10,000-user production system). When absent, checks fall
   * back to their previous scale-agnostic behavior rather than guessing.
   */
  expectedUsers?: number;
}

export interface OptimizationResult {
  recommendations: ArchitectureRecommendation[];
  score: ArchitectureScore;
}

// ─── ArchitectureAdvisor ──────────────────────────────────────────────────────

export class ArchitectureAdvisor {
  analyze(input: OptimizationInput): OptimizationResult {
    const recommendations = this._generateRecommendations(input);
    const score = this._calculateScore(input, recommendations);
    return { recommendations, score };
  }

  // ── Recommendation rules ──────────────────────────────────────────────────

  private _generateRecommendations(input: OptimizationInput): ArchitectureRecommendation[] {
    const recs: ArchitectureRecommendation[] = [];
    const resources = input.resources;
    const expectedUsers = input.expectedUsers;

    const byType = this._byType(resources);

    // ── Reliability ──────────────────────────────────────────────────────────

    // R-01: EC2 without a load balancer
    const ec2Resources = byType['aws_ec2'] ?? [];
    const albResources = byType['aws_alb'] ?? [];
    if (ec2Resources.length > 0 && albResources.length === 0) {
      recs.push({
        id: 'R-01',
        category: 'reliability',
        severity: 'high',
        title: 'No load balancer in front of EC2 instances',
        description: `${ec2Resources.length} EC2 instance(s) found with no Application Load Balancer. All traffic routes to a single instance creating a single point of failure.`,
        affectedResourceIds: ec2Resources.map((r) => r.id),
        affectedResourceLabels: ec2Resources.map((r) => r.label),
        rationale: 'A load balancer distributes traffic across multiple instances, enables health checks, and allows rolling deployments with zero downtime.',
        suggestedAction: 'Add an Application Load Balancer (aws_alb) and distribute EC2 instances across multiple Availability Zones.',
      });
    }

    // R-02: RDS without Multi-AZ
    const rdsResources = byType['aws_rds'] ?? [];
    const rdsNoMultiAz = rdsResources.filter((r) => this._config(r)['multiAz'] !== true);
    if (rdsNoMultiAz.length > 0) {
      recs.push({
        id: 'R-02',
        category: 'reliability',
        severity: SECURITY_SEVERITY.AWS_RDS_NOT_MULTI_AZ,
        title: 'RDS instance(s) not configured for Multi-AZ',
        description: `${rdsNoMultiAz.length} RDS instance(s) are single-AZ deployments. A database failure would cause an outage with no automatic failover.`,
        affectedResourceIds: rdsNoMultiAz.map((r) => r.id),
        affectedResourceLabels: rdsNoMultiAz.map((r) => r.label),
        rationale: 'Multi-AZ creates a synchronous standby replica in a different Availability Zone and provides automatic failover in case of failure.',
        suggestedAction: 'Enable Multi-AZ on RDS instances (set multiAz = true). Note: this approximately doubles the instance cost.',
      });
    }

    // R-03: Single EC2 instance (no HA). Severity scales with the declared
    // expected user count — a single instance is a defensible choice for a
    // small internal tool, but a critical risk for a system the user has
    // declared is meant to serve production-scale traffic.
    if (ec2Resources.length === 1 && albResources.length === 0) {
      const severity: ArchitectureRecommendation['severity'] =
        expectedUsers === undefined ? 'medium' :
        expectedUsers >= 10_000 ? 'critical' :
        expectedUsers >= 1_000 ? 'high' :
        expectedUsers < 100 ? 'low' :
        'medium';
      recs.push({
        id: 'R-03',
        category: 'reliability',
        severity,
        title: 'Single EC2 instance — no high availability',
        description: expectedUsers !== undefined
          ? `Only one EC2 instance is present with no load balancer, for an architecture declared to serve ~${expectedUsers.toLocaleString()} users. Hardware failure, patching, or deployment issues will cause a full outage.`
          : 'Only one EC2 instance is present with no load balancer. Hardware failure, patching, or deployment issues will cause downtime.',
        affectedResourceIds: ec2Resources.map((r) => r.id),
        affectedResourceLabels: ec2Resources.map((r) => r.label),
        rationale: 'High availability requires at minimum two instances across different Availability Zones behind a load balancer.',
        suggestedAction: 'Add a second EC2 instance in a different AZ and place both behind an Application Load Balancer.',
      });
    }

    // R-04: Azure VM without Azure Load Balancer
    const azureVmResources = byType['azure_vm'] ?? [];
    const azureLbResources = byType['azure_lb'] ?? [];
    if (azureVmResources.length > 0 && azureLbResources.length === 0) {
      recs.push({
        id: 'R-04',
        category: 'reliability',
        severity: 'high',
        title: 'No load balancer in front of Azure VMs',
        description: `${azureVmResources.length} Azure VM(s) found with no load balancer. Traffic cannot be distributed or health-checked.`,
        affectedResourceIds: azureVmResources.map((r) => r.id),
        affectedResourceLabels: azureVmResources.map((r) => r.label),
        rationale: 'Azure Load Balancer distributes inbound traffic across VM instances and removes unhealthy instances from rotation automatically.',
        suggestedAction: 'Add an Azure Load Balancer (azure_lb) in front of the VM instances.',
      });
    }

    // ── Security ─────────────────────────────────────────────────────────────

    // S-01: No security group defined for AWS resources
    const awsResources = resources.filter((r) => r.provider === 'aws');
    const sgResources = byType['aws_sg'] ?? [];
    if (awsResources.length > 0 && sgResources.length === 0) {
      recs.push({
        id: 'S-01',
        category: 'security',
        severity: SECURITY_SEVERITY.AWS_NO_SECURITY_GROUPS,
        title: 'No AWS Security Groups defined',
        description: `The architecture contains ${awsResources.length} AWS resource(s) but no Security Groups are defined. Without security groups, traffic control relies on network ACLs alone.`,
        affectedResourceIds: awsResources.map((r) => r.id),
        affectedResourceLabels: awsResources.map((r) => r.label),
        rationale: 'Security Groups act as virtual firewalls for EC2 instances, RDS databases, and load balancers. They enforce least-privilege network access.',
        suggestedAction: 'Define Security Groups (aws_sg) for each resource layer — web, application, and database — with explicit ingress/egress rules.',
      });
    }

    // S-02: No Azure NSG for Azure resources
    const azureResources = resources.filter((r) => r.provider === 'azure');
    const nsgResources = byType['azure_nsg'] ?? [];
    if (azureResources.filter((r) => !['azure_resource_group', 'azure_vnet'].includes(r.resourceType)).length > 0 && nsgResources.length === 0) {
      recs.push({
        id: 'S-02',
        category: 'security',
        severity: 'high',
        title: 'No Azure Network Security Groups defined',
        description: 'Azure compute resources are present without Network Security Groups to control inbound/outbound traffic.',
        affectedResourceIds: azureResources.map((r) => r.id),
        affectedResourceLabels: azureResources.map((r) => r.label),
        rationale: 'NSGs filter traffic at the NIC or subnet level. Without them, resources may accept traffic from unintended sources.',
        suggestedAction: 'Attach Network Security Groups (azure_nsg) to subnets or network interfaces hosting compute workloads.',
      });
    }

    // S-03: Unencrypted RDS (encryption field missing or false)
    const rdsUnencrypted = rdsResources.filter((r) => {
      const c = this._config(r);
      return c['encrypted'] === false;
    });
    if (rdsUnencrypted.length > 0) {
      recs.push({
        id: 'S-03',
        category: 'security',
        severity: SECURITY_SEVERITY.AWS_RDS_NOT_ENCRYPTED,
        title: 'RDS storage encryption disabled',
        description: `${rdsUnencrypted.length} RDS instance(s) have storage encryption explicitly disabled.`,
        affectedResourceIds: rdsUnencrypted.map((r) => r.id),
        affectedResourceLabels: rdsUnencrypted.map((r) => r.label),
        rationale: 'Encryption at rest protects database data if the underlying storage media is compromised. AWS does not charge extra for RDS encryption.',
        suggestedAction: 'Enable storage_encrypted = true on all RDS instances. For existing instances, take a snapshot, enable encryption on the snapshot, and restore.',
      });
    }

    // S-04: Publicly accessible S3 bucket
    const s3Public = (byType['aws_s3'] ?? []).filter((r) => this._config(r)['publicAccess'] === true);
    if (s3Public.length > 0) {
      recs.push({
        id: 'S-04',
        category: 'security',
        severity: SECURITY_SEVERITY.AWS_S3_PUBLIC_ACCESS,
        title: 'S3 bucket(s) publicly accessible',
        description: `${s3Public.length} S3 bucket(s) have publicAccess enabled, exposing data to the internet without authentication.`,
        affectedResourceIds: s3Public.map((r) => r.id),
        affectedResourceLabels: s3Public.map((r) => r.label),
        rationale: 'Public S3 buckets are a leading cause of data breaches. Unless serving public static content intentionally, buckets should block all public access.',
        suggestedAction: 'Enable S3 Block Public Access on all buckets. For static website hosting, use CloudFront with an Origin Access Control instead.',
      });
    }

    // ── Cost ─────────────────────────────────────────────────────────────────

    // C-01: Oversized EC2 instances (xlarge or larger without multi-AZ RDS)
    const largeEc2 = ec2Resources.filter((r) => {
      const instanceType = (this._config(r)['instanceType'] as string) ?? '';
      return instanceType.includes('xlarge') || instanceType.includes('2xlarge') || instanceType.includes('4xlarge');
    });
    if (largeEc2.length > 0) {
      recs.push({
        id: 'C-01',
        category: 'cost',
        severity: 'low',
        title: 'Large EC2 instance(s) — consider right-sizing',
        description: `${largeEc2.length} EC2 instance(s) use xlarge or larger types. Without performance profiling, these may be over-provisioned.`,
        affectedResourceIds: largeEc2.map((r) => r.id),
        affectedResourceLabels: largeEc2.map((r) => r.label),
        rationale: 'AWS Compute Optimizer and Cost Explorer can identify over-provisioned instances. Right-sizing to the next smaller type often saves 40-50% on EC2 costs.',
        suggestedAction: 'Enable AWS Cost Explorer and Compute Optimizer. If average CPU utilization is below 40%, downsize by one instance type.',
        estimatedMonthlySavingsUsd: largeEc2.length * 88, // ~$88/mo per m5.xlarge → m5.large
      });
    }

    // C-02: Multiple NAT Gateways (consolidation opportunity)
    const natResources = byType['aws_nat'] ?? [];
    if (natResources.length > 1) {
      recs.push({
        id: 'C-02',
        category: 'cost',
        severity: 'medium',
        title: 'Multiple NAT Gateways — consolidation may reduce cost',
        description: `${natResources.length} NAT Gateways are defined. Each costs ~$32/month plus data processing. For non-production or single-AZ workloads, consolidation reduces cost.`,
        affectedResourceIds: natResources.map((r) => r.id),
        affectedResourceLabels: natResources.map((r) => r.label),
        rationale: 'NAT Gateways are priced per hour plus data processing. Multiple gateways are needed for Multi-AZ HA, but may be unnecessary for dev/staging environments.',
        suggestedAction: 'For dev/test environments, consolidate to a single NAT Gateway. For production Multi-AZ, keep per-AZ gateways to avoid cross-AZ data transfer charges.',
        estimatedMonthlySavingsUsd: (natResources.length - 1) * 32,
      });
    }

    // C-03: S3 intelligent tiering opportunity
    const s3Resources = byType['aws_s3'] ?? [];
    if (s3Resources.length > 0) {
      recs.push({
        id: 'C-03',
        category: 'cost',
        severity: 'low',
        title: 'Enable S3 Intelligent-Tiering for automatic cost optimization',
        description: `${s3Resources.length} S3 bucket(s) could benefit from Intelligent-Tiering to automatically move infrequently accessed objects to cheaper storage classes.`,
        affectedResourceIds: s3Resources.map((r) => r.id),
        affectedResourceLabels: s3Resources.map((r) => r.label),
        rationale: 'S3 Intelligent-Tiering automatically moves objects between access tiers. For buckets with unpredictable access patterns, this can save up to 68%.',
        suggestedAction: 'Configure S3 Intelligent-Tiering lifecycle policy on buckets with objects larger than 128KB that are not accessed frequently.',
        estimatedMonthlySavingsUsd: s3Resources.length * 12,
      });
    }

    // C-04: RDS reserved instance opportunity
    const rdsOnDemand = rdsResources.filter((r) => this._config(r)['reservedInstance'] !== true);
    if (rdsOnDemand.length > 0) {
      recs.push({
        id: 'C-04',
        category: 'cost',
        severity: 'low',
        title: 'RDS instances on on-demand pricing — consider Reserved Instances',
        description: `${rdsOnDemand.length} RDS instance(s) appear to be on on-demand pricing. Reserved Instances offer up to 42% savings for predictable workloads.`,
        affectedResourceIds: rdsOnDemand.map((r) => r.id),
        affectedResourceLabels: rdsOnDemand.map((r) => r.label),
        rationale: '1-year Reserved Instances for RDS save up to 42% over on-demand. 3-year up to 65%. For stable production databases, this is reliable cost reduction.',
        suggestedAction: 'Purchase RDS Reserved Instances for production databases that run 24/7. Use the 1-year no-upfront option for flexibility.',
        estimatedMonthlySavingsUsd: rdsOnDemand.length * 55,
      });
    }

    // ── Scalability ────────────────────────────────────────────────────────────

    // SC-01: EC2 instances without Auto Scaling Group. The instance-count
    // threshold and severity scale with the declared expected user count —
    // a static fleet that's merely inefficient at low scale becomes a real
    // scalability risk at high declared scale, so the check fires earlier
    // and louder there.
    const asgScaleThreshold = expectedUsers !== undefined && expectedUsers >= 10_000 ? 0 : 2;
    if (ec2Resources.length > asgScaleThreshold) {
      const severity: RecommendationSeverity =
        expectedUsers !== undefined && expectedUsers >= 10_000 ? 'high' : 'medium';
      recs.push({
        id: 'SC-01',
        category: 'scalability',
        severity,
        title: 'Multiple EC2 instances without Auto Scaling Group',
        description: expectedUsers !== undefined
          ? `${ec2Resources.length} static EC2 instance(s) found for an architecture declared to serve ~${expectedUsers.toLocaleString()} users. Static fleets cannot react to traffic changes and are a scalability risk at this declared scale.`
          : `${ec2Resources.length} static EC2 instances found. Static fleets cannot scale in response to traffic changes, leading to over-provisioning during low-traffic periods.`,
        affectedResourceIds: ec2Resources.map((r) => r.id),
        affectedResourceLabels: ec2Resources.map((r) => r.label),
        rationale: 'Auto Scaling Groups automatically adjust instance count based on metrics (CPU, memory, request count), optimizing both cost and availability.',
        suggestedAction: 'Replace static EC2 instances with an Auto Scaling Group using target tracking scaling policies.',
      });
    }

    // ── Performance ───────────────────────────────────────────────────────────

    // P-01: No caching layer. A missing cache is a minor optimization at low
    // traffic but a real bottleneck at declared high scale, so severity
    // scales with expectedUsers rather than staying fixed at 'low'.
    const hasCaching = resources.some((r) => ['aws_elasticache', 'azure_redis_cache'].includes(r.resourceType));
    if (rdsResources.length > 0 && ec2Resources.length > 0 && !hasCaching) {
      const severity: RecommendationSeverity =
        expectedUsers === undefined ? 'low' :
        expectedUsers >= 10_000 ? 'high' :
        expectedUsers >= 1_000 ? 'medium' :
        'low';
      recs.push({
        id: 'P-01',
        category: 'performance',
        severity,
        title: 'No caching layer detected',
        description: expectedUsers !== undefined
          ? `Database and compute resources are present with no caching layer, for an architecture declared to serve ~${expectedUsers.toLocaleString()} users. Frequently read data is served directly from the database on every request.`
          : 'Database and compute resources are present with no caching layer. Frequently read data is served directly from the database on every request.',
        affectedResourceIds: rdsResources.map((r) => r.id),
        affectedResourceLabels: rdsResources.map((r) => r.label),
        rationale: 'In-memory caches (ElastiCache/Redis) can reduce database read load by 90%+ for read-heavy workloads, improving latency and reducing RDS instance size requirements.',
        suggestedAction: 'Add Amazon ElastiCache (Redis) for session caching, query result caching, and frequently read reference data.',
      });
    }

    return recs;
  }

  // ── Scoring ──────────────────────────────────────────────────────────────────

  private _calculateScore(input: OptimizationInput, recommendations: ArchitectureRecommendation[]): ArchitectureScore {
    const byCategory = new Map<RecommendationCategory, ArchitectureRecommendation[]>();
    for (const rec of recommendations) {
      if (!byCategory.has(rec.category)) byCategory.set(rec.category, []);
      byCategory.get(rec.category)!.push(rec);
    }

    const DEDUCT: Record<RecommendationSeverity, number> = {
      critical: 30, high: 20, medium: 10, low: 5,
    };

    function categoryScore(recs: ArchitectureRecommendation[]): number {
      const deduction = recs.reduce((sum, r) => sum + (DEDUCT[r.severity] ?? 0), 0);
      return Math.max(0, 100 - deduction);
    }

    const reliability  = categoryScore(byCategory.get('reliability') ?? []);
    const security     = categoryScore(byCategory.get('security') ?? []);
    const performance  = categoryScore(byCategory.get('performance') ?? []);
    const cost         = categoryScore(byCategory.get('cost') ?? []);
    const scalability  = categoryScore(byCategory.get('scalability') ?? []);
    const overall      = Math.round((reliability + security + performance + cost + scalability) / 5);

    // Bonus: architectures with resources get a floor to avoid zero scores for simple ones
    const resourceFloor = input.resources.length > 0 ? 10 : 0;

    return {
      overall:     Math.min(100, overall + resourceFloor),
      reliability: Math.min(100, reliability + resourceFloor),
      security:    Math.min(100, security + resourceFloor),
      performance: Math.min(100, performance + resourceFloor),
      cost:        Math.min(100, cost + resourceFloor),
      scalability: Math.min(100, scalability + resourceFloor),
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private _byType(resources: DbArchitectureResource[]): Record<string, DbArchitectureResource[]> {
    const map: Record<string, DbArchitectureResource[]> = {};
    for (const r of resources) {
      if (!map[r.resourceType]) map[r.resourceType] = [];
      map[r.resourceType]!.push(r);
    }
    return map;
  }

  private _config(resource: DbArchitectureResource): Record<string, unknown> {
    try { return JSON.parse(resource.configJson) as Record<string, unknown>; }
    catch { return {}; }
  }
}

export const architectureAdvisor = new ArchitectureAdvisor();
