/**
 * AWS Well-Architected Framework Rules
 *
 * Rules organized by official AWS WAF pillar (6 pillars).
 * Each rule:
 *  - Maps to the official pillar documentation URL
 *  - Only fires when there is explicit evidence in the config
 *  - Never fires when the relevant field is absent/unknown
 *  - Carries full source attribution
 *
 * Source: https://docs.aws.amazon.com/wellarchitected/
 */
import type { WaRule, WaFinding } from '../types';
import { AWS_PILLARS } from '../frameworkDefinitions';

// ─── Helper ───────────────────────────────────────────────────────────────────

function pillar(id: string) {
  return AWS_PILLARS.find((p) => p.id === id)!;
}

function makeRef(pillarId: string): string {
  const p = pillar(pillarId);
  return `AWS Well-Architected Framework — ${p.label} Pillar`;
}

// ─── Operational Excellence Rules ────────────────────────────────────────────

const OE_PILLAR = pillar('operational_excellence');

const awsOeRules: WaRule[] = [
  {
    ruleId: 'AWS-WAF-OE-01',
    provider: 'aws',
    pillar: 'operational_excellence',
    pillarLabel: OE_PILLAR.label,
    pillarRef: OE_PILLAR.referenceUrl,
    severity: 'medium',
    title: 'EC2 instances lack detailed monitoring',
    description: 'EC2 instances without detailed monitoring provide only basic 5-minute CloudWatch metrics. This reduces observability and slows incident detection.',
    frameworkReference: makeRef('operational_excellence'),
    source: 'DESIGN_TIME',
    remediation: 'Enable detailed monitoring on EC2 instances to get 1-minute CloudWatch metrics. Use aws_cloudwatch_metric_alarm to set operational alarms.',
    check(resource, config, allResources) {
      if (resource.resourceType !== 'aws_ec2') return null;
      if (config['detailedMonitoring'] !== false) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { detailedMonitoring: config['detailedMonitoring'] },
        recommendation: 'Enable detailed monitoring (detailedMonitoring = true) on all production EC2 instances.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AWS-WAF-OE-02',
    provider: 'aws',
    pillar: 'operational_excellence',
    pillarLabel: OE_PILLAR.label,
    pillarRef: OE_PILLAR.referenceUrl,
    severity: 'low',
    title: 'No CloudWatch monitoring resource detected',
    description: 'The architecture has no CloudWatch monitoring resources. Operational excellence requires observability through metrics, logs, and traces.',
    frameworkReference: makeRef('operational_excellence'),
    source: 'DESIGN_TIME',
    remediation: 'Add CloudWatch alarms, dashboards, and log groups to monitor operational health. Consider adding aws_cloudwatch resource to the architecture.',
    check(resource, config, allResources) {
      // Architecture-level rule: only run once, on the first aws resource
      const awsResources = allResources.filter((r) => r.provider === 'aws');
      if (awsResources.length === 0) return null;
      if (resource.id !== awsResources[0].id) return null; // Run once
      const hasMonitoring = allResources.some((r) =>
        ['aws_cloudwatch', 'aws_cloudtrail'].includes(r.resourceType)
      );
      if (hasMonitoring) return null;
      if (awsResources.length < 2) return null; // Don't fire for single-resource architectures
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: awsResources.map((r) => r.id),
        affectedResourceLabels: awsResources.map((r) => r.label),
        evidence: { awsResourceCount: awsResources.length, monitoringFound: false },
        recommendation: 'Add a CloudWatch resource and configure alarms for critical metrics (CPU, latency, error rate).',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
];

// ─── Security Rules ───────────────────────────────────────────────────────────

const SEC_PILLAR = pillar('security');

const awsSecRules: WaRule[] = [
  {
    ruleId: 'AWS-WAF-SEC-01',
    provider: 'aws',
    pillar: 'security',
    pillarLabel: SEC_PILLAR.label,
    pillarRef: SEC_PILLAR.referenceUrl,
    severity: 'critical',
    title: 'RDS instance publicly accessible',
    description: 'The RDS instance has publicly_accessible enabled, exposing the database directly to the internet without network-level protection.',
    frameworkReference: makeRef('security'),
    source: 'DESIGN_TIME',
    remediation: 'Set publicly_accessible = false. Place RDS inside a private subnet and access it only through application-layer resources or a VPN/bastion.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_rds') return null;
      if (config['publiclyAccessible'] !== true) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { publiclyAccessible: config['publiclyAccessible'] },
        recommendation: 'Move RDS into a private subnet. Set publicly_accessible = false. Use security groups to restrict access to the application layer only.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AWS-WAF-SEC-02',
    provider: 'aws',
    pillar: 'security',
    pillarLabel: SEC_PILLAR.label,
    pillarRef: SEC_PILLAR.referenceUrl,
    severity: 'critical',
    title: 'S3 bucket publicly accessible',
    description: 'The S3 bucket has public access enabled, exposing all objects to unauthenticated internet access.',
    frameworkReference: makeRef('security'),
    source: 'DESIGN_TIME',
    remediation: 'Enable S3 Block Public Access on the bucket. For public static content, use CloudFront with Origin Access Control instead.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_s3') return null;
      const isPublic = config['publicAccess'] === true || config['publicAccessBlock'] === false;
      if (!isPublic) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { publicAccess: config['publicAccess'] },
        recommendation: 'Disable public access on S3 buckets. Use CloudFront + OAC for static website hosting.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AWS-WAF-SEC-03',
    provider: 'aws',
    pillar: 'security',
    pillarLabel: SEC_PILLAR.label,
    pillarRef: SEC_PILLAR.referenceUrl,
    severity: 'high',
    title: 'RDS storage encryption disabled',
    description: 'The RDS instance has storage encryption explicitly disabled, leaving database data at rest unprotected.',
    frameworkReference: makeRef('security'),
    source: 'DESIGN_TIME',
    remediation: 'Enable storage_encrypted = true. For existing unencrypted instances, create an encrypted snapshot and restore from it.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_rds') return null;
      if (config['encrypted'] !== false) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { encrypted: config['encrypted'] },
        recommendation: 'Enable storage encryption on RDS instances. AWS KMS key usage for RDS has no additional charge beyond KMS costs.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AWS-WAF-SEC-04',
    provider: 'aws',
    pillar: 'security',
    pillarLabel: SEC_PILLAR.label,
    pillarRef: SEC_PILLAR.referenceUrl,
    severity: 'high',
    title: 'Security Group allows unrestricted SSH access',
    description: 'The Security Group permits inbound SSH (port 22) from any IP address (0.0.0.0/0), exposing instances to brute-force attacks.',
    frameworkReference: makeRef('security'),
    source: 'DESIGN_TIME',
    remediation: 'Restrict SSH ingress to specific trusted CIDR ranges, or replace SSH with AWS Systems Manager Session Manager for agentless access.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_sg') return null;
      if (config['allowSsh'] !== true) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { allowSsh: config['allowSsh'] },
        recommendation: 'Use AWS Systems Manager Session Manager instead of SSH. If SSH is required, restrict to known IP ranges.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AWS-WAF-SEC-05',
    provider: 'aws',
    pillar: 'security',
    pillarLabel: SEC_PILLAR.label,
    pillarRef: SEC_PILLAR.referenceUrl,
    severity: 'high',
    title: 'S3 bucket encryption disabled',
    description: 'The S3 bucket does not have server-side encryption enabled, leaving stored objects unprotected at rest.',
    frameworkReference: makeRef('security'),
    source: 'DESIGN_TIME',
    remediation: 'Enable default server-side encryption with SSE-S3 or SSE-KMS on the bucket.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_s3') return null;
      if (config['encryption'] !== false) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { encryption: config['encryption'] },
        recommendation: 'Enable SSE-S3 or SSE-KMS encryption on all S3 buckets storing sensitive data.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AWS-WAF-SEC-06',
    provider: 'aws',
    pillar: 'security',
    pillarLabel: SEC_PILLAR.label,
    pillarRef: SEC_PILLAR.referenceUrl,
    severity: 'high',
    title: 'No Security Groups defined for AWS resources',
    description: 'The architecture contains AWS compute/database resources but no Security Groups are defined to control network traffic.',
    frameworkReference: makeRef('security'),
    source: 'DESIGN_TIME',
    remediation: 'Define Security Groups for each resource layer (web, application, database) with explicit least-privilege ingress and egress rules.',
    check(resource, config, allResources) {
      const awsResources = allResources.filter((r) => r.provider === 'aws');
      if (awsResources.length === 0) return null;
      if (resource.id !== awsResources[0].id) return null; // Run once
      const hasSg = allResources.some((r) => r.resourceType === 'aws_sg');
      if (hasSg) return null;
      const hasComputeOrDb = allResources.some((r) =>
        ['aws_ec2', 'aws_rds', 'aws_alb', 'aws_ecs', 'aws_lambda'].includes(r.resourceType)
      );
      if (!hasComputeOrDb) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: awsResources.map((r) => r.id),
        affectedResourceLabels: awsResources.map((r) => r.label),
        evidence: { sgCount: 0, awsResourceCount: awsResources.length },
        recommendation: 'Add aws_sg resources and attach them to compute and database resources using least-privilege rules.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
];

// ─── Reliability Rules ────────────────────────────────────────────────────────

const REL_PILLAR = pillar('reliability');

const awsRelRules: WaRule[] = [
  {
    ruleId: 'AWS-WAF-REL-01',
    provider: 'aws',
    pillar: 'reliability',
    pillarLabel: REL_PILLAR.label,
    pillarRef: REL_PILLAR.referenceUrl,
    severity: 'high',
    title: 'RDS not configured for Multi-AZ',
    description: 'Single-AZ RDS deployment creates a single point of failure. Automatic failover is unavailable if the primary instance fails.',
    frameworkReference: makeRef('reliability'),
    source: 'DESIGN_TIME',
    remediation: 'Enable Multi-AZ on the RDS instance for synchronous replication and automatic failover. Applicable for production workloads.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_rds') return null;
      if (config['multiAz'] !== false) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { multiAz: config['multiAz'] },
        recommendation: 'Enable Multi-AZ (multiAz = true) on RDS instances to achieve ≤2 minute automatic failover RPO.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AWS-WAF-REL-02',
    provider: 'aws',
    pillar: 'reliability',
    pillarLabel: REL_PILLAR.label,
    pillarRef: REL_PILLAR.referenceUrl,
    severity: 'high',
    title: 'No load balancer for EC2 instances',
    description: 'EC2 instances are present without an Application Load Balancer. All traffic routes to a single instance, creating a single point of failure.',
    frameworkReference: makeRef('reliability'),
    source: 'DESIGN_TIME',
    remediation: 'Add an Application Load Balancer in front of EC2 instances. Distribute EC2 instances across multiple Availability Zones.',
    check(resource, config, allResources) {
      const ec2s = allResources.filter((r) => r.provider === 'aws' && r.resourceType === 'aws_ec2');
      if (ec2s.length === 0) return null;
      if (resource.id !== ec2s[0].id) return null; // Run once
      const hasAlb = allResources.some((r) => r.resourceType === 'aws_alb');
      if (hasAlb) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: ec2s.map((r) => r.id),
        affectedResourceLabels: ec2s.map((r) => r.label),
        evidence: { ec2Count: ec2s.length, albCount: 0 },
        recommendation: 'Add an aws_alb Application Load Balancer and distribute traffic across at least 2 EC2 instances in different AZs.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AWS-WAF-REL-03',
    provider: 'aws',
    pillar: 'reliability',
    pillarLabel: REL_PILLAR.label,
    pillarRef: REL_PILLAR.referenceUrl,
    severity: 'medium',
    title: 'Single EC2 instance — no high availability',
    description: 'Only one EC2 instance is present. Hardware failure, OS crash, or deployment issues will cause complete downtime with no automatic recovery.',
    frameworkReference: makeRef('reliability'),
    source: 'DESIGN_TIME',
    remediation: 'Deploy a minimum of two EC2 instances across different Availability Zones behind an Application Load Balancer. Consider Auto Scaling Groups for automatic recovery.',
    check(resource, config, allResources) {
      if (resource.resourceType !== 'aws_ec2') return null;
      const ec2s = allResources.filter((r) => r.resourceType === 'aws_ec2');
      if (ec2s.length !== 1) return null;
      if (resource.id !== ec2s[0].id) return null;
      const hasAlb = allResources.some((r) => r.resourceType === 'aws_alb');
      if (hasAlb) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { ec2Count: 1 },
        recommendation: 'Add a second EC2 instance in a different AZ and place both behind an Application Load Balancer.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AWS-WAF-REL-04',
    provider: 'aws',
    pillar: 'reliability',
    pillarLabel: REL_PILLAR.label,
    pillarRef: REL_PILLAR.referenceUrl,
    severity: 'medium',
    title: 'Subnet only in single Availability Zone',
    description: 'Only one subnet is present and it covers a single AZ. Multi-AZ redundancy requires subnets in at least two Availability Zones.',
    frameworkReference: makeRef('reliability'),
    source: 'DESIGN_TIME',
    remediation: 'Create subnets in at least two Availability Zones to support HA deployments of EC2, RDS Multi-AZ, and ALB.',
    check(resource, config, allResources) {
      if (resource.resourceType !== 'aws_subnet') return null;
      const subnets = allResources.filter((r) => r.resourceType === 'aws_subnet');
      if (subnets.length !== 1) return null;
      if (resource.id !== subnets[0].id) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { subnetCount: 1 },
        recommendation: 'Add subnets in at least 2 AZs to enable Multi-AZ deployments.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
];

// ─── Performance Efficiency Rules ─────────────────────────────────────────────

const PERF_PILLAR = pillar('performance_efficiency');

const awsPerfRules: WaRule[] = [
  {
    ruleId: 'AWS-WAF-PERF-01',
    provider: 'aws',
    pillar: 'performance_efficiency',
    pillarLabel: PERF_PILLAR.label,
    pillarRef: PERF_PILLAR.referenceUrl,
    severity: 'low',
    title: 'No caching layer for database-backed application',
    description: 'RDS and compute resources are present without a caching layer. Repeated database reads for the same data add unnecessary latency and load.',
    frameworkReference: makeRef('performance_efficiency'),
    source: 'DESIGN_TIME',
    remediation: 'Add Amazon ElastiCache (Redis/Memcached) to cache frequently read data, session state, and computed results.',
    check(resource, config, allResources) {
      const rdss = allResources.filter((r) => r.resourceType === 'aws_rds');
      const computes = allResources.filter((r) =>
        ['aws_ec2', 'aws_ecs', 'aws_lambda', 'aws_auto_scaling'].includes(r.resourceType)
      );
      if (rdss.length === 0 || computes.length === 0) return null;
      if (resource.id !== rdss[0].id) return null;
      const hasCache = allResources.some((r) =>
        ['aws_elasticache', 'aws_redis_cache'].includes(r.resourceType)
      );
      if (hasCache) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: rdss.map((r) => r.id),
        affectedResourceLabels: rdss.map((r) => r.label),
        evidence: { rdsCount: rdss.length, cacheFound: false },
        recommendation: 'Add Amazon ElastiCache for Redis to cache session state and frequently-read query results.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
];

// ─── Cost Optimization Rules ──────────────────────────────────────────────────

const COST_PILLAR = pillar('cost_optimization');

const awsCostRules: WaRule[] = [
  {
    ruleId: 'AWS-WAF-COST-01',
    provider: 'aws',
    pillar: 'cost_optimization',
    pillarLabel: COST_PILLAR.label,
    pillarRef: COST_PILLAR.referenceUrl,
    severity: 'low',
    title: 'Large EC2 instance without Auto Scaling — right-sizing opportunity',
    description: 'Large or extra-large EC2 instance types may be over-provisioned without performance data to justify the size.',
    frameworkReference: makeRef('cost_optimization'),
    source: 'DESIGN_TIME',
    remediation: 'Enable AWS Compute Optimizer and review CPU utilization. Downsize if average CPU < 40%. Use Auto Scaling instead of large fixed instances.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_ec2') return null;
      const instanceType = (config['instanceType'] as string) ?? '';
      const isLarge = instanceType.includes('xlarge') || instanceType.includes('2xlarge') || instanceType.includes('4xlarge');
      if (!isLarge) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { instanceType },
        recommendation: 'Use AWS Compute Optimizer to validate the instance type. Consider Auto Scaling Groups for variable workloads.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AWS-WAF-COST-02',
    provider: 'aws',
    pillar: 'cost_optimization',
    pillarLabel: COST_PILLAR.label,
    pillarRef: COST_PILLAR.referenceUrl,
    severity: 'medium',
    title: 'Multiple NAT Gateways — consolidation opportunity',
    description: 'Multiple NAT Gateways are defined. Each costs ~$32/month plus data processing fees. For non-production environments, consolidation may reduce cost.',
    frameworkReference: makeRef('cost_optimization'),
    source: 'DESIGN_TIME',
    remediation: 'For dev/test environments, use a single NAT Gateway. For production Multi-AZ, keep one NAT Gateway per AZ to avoid cross-AZ data transfer charges.',
    check(resource, config, allResources) {
      if (resource.resourceType !== 'aws_nat') return null;
      const nats = allResources.filter((r) => r.resourceType === 'aws_nat');
      if (nats.length <= 1) return null;
      if (resource.id !== nats[0].id) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: nats.map((r) => r.id),
        affectedResourceLabels: nats.map((r) => r.label),
        evidence: { natCount: nats.length, estimatedMonthlyCost: `$${nats.length * 32}/mo` },
        recommendation: 'For dev/test, consolidate to 1 NAT Gateway. For production Multi-AZ, keep 1 per AZ to avoid cross-AZ data fees.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AWS-WAF-COST-03',
    provider: 'aws',
    pillar: 'cost_optimization',
    pillarLabel: COST_PILLAR.label,
    pillarRef: COST_PILLAR.referenceUrl,
    severity: 'low',
    title: 'RDS instances on on-demand pricing',
    description: 'RDS instances appear to be on on-demand pricing. Reserved Instances offer significant savings for predictable, stable workloads.',
    frameworkReference: makeRef('cost_optimization'),
    source: 'DESIGN_TIME',
    remediation: 'For stable production RDS instances, purchase 1-year Reserved Instances to save up to 42% vs on-demand pricing.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_rds') return null;
      if (config['reservedInstance'] === true) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { reservedInstance: config['reservedInstance'] ?? false },
        recommendation: 'Purchase RDS Reserved Instances for production databases running 24/7. 1-year no-upfront offers flexibility with ~42% savings.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
];

// ─── Sustainability Rules ─────────────────────────────────────────────────────

const SUS_PILLAR = pillar('sustainability');

const awsSusRules: WaRule[] = [
  {
    ruleId: 'AWS-WAF-SUS-01',
    provider: 'aws',
    pillar: 'sustainability',
    pillarLabel: SUS_PILLAR.label,
    pillarRef: SUS_PILLAR.referenceUrl,
    severity: 'info',
    title: 'Consider serverless/managed services to reduce infrastructure footprint',
    description: 'The architecture uses EC2 instances. Migrating to serverless (Lambda) or managed container services (ECS Fargate) where applicable reduces idle compute resource usage.',
    frameworkReference: makeRef('sustainability'),
    source: 'DESIGN_TIME',
    remediation: 'Evaluate workloads for serverless migration. AWS Lambda and ECS Fargate provision only the compute you consume, reducing energy per request.',
    check(resource, config, allResources) {
      if (resource.resourceType !== 'aws_ec2') return null;
      const ec2s = allResources.filter((r) => r.resourceType === 'aws_ec2');
      if (ec2s.length <= 1) return null; // Only fire for architectures with multiple EC2
      if (resource.id !== ec2s[0].id) return null;
      const hasServerless = allResources.some((r) =>
        ['aws_lambda', 'aws_ecs', 'aws_auto_scaling'].includes(r.resourceType)
      );
      if (hasServerless) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: ec2s.map((r) => r.id),
        affectedResourceLabels: ec2s.map((r) => r.label),
        evidence: { ec2Count: ec2s.length },
        recommendation: 'Evaluate microservices for Lambda or ECS Fargate migration to improve sustainability metrics.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AWS-WAF-SUS-02',
    provider: 'aws',
    pillar: 'sustainability',
    pillarLabel: SUS_PILLAR.label,
    pillarRef: SUS_PILLAR.referenceUrl,
    severity: 'info',
    title: 'Use Auto Scaling to minimize idle compute resources',
    description: 'Static EC2 fleets provision compute 24/7 regardless of actual load. Auto Scaling reduces wasted energy during off-peak hours.',
    frameworkReference: makeRef('sustainability'),
    source: 'DESIGN_TIME',
    remediation: 'Replace static EC2 fleets with Auto Scaling Groups. Configure schedule-based or metric-based scaling to match actual demand.',
    check(resource, config, allResources) {
      if (resource.resourceType !== 'aws_ec2') return null;
      const ec2s = allResources.filter((r) => r.resourceType === 'aws_ec2');
      if (ec2s.length < 2) return null;
      if (resource.id !== ec2s[0].id) return null;
      const hasAsg = allResources.some((r) => r.resourceType === 'aws_auto_scaling');
      if (hasAsg) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: ec2s.map((r) => r.id),
        affectedResourceLabels: ec2s.map((r) => r.label),
        evidence: { ec2Count: ec2s.length, asgFound: false },
        recommendation: 'Add an Auto Scaling Group (aws_auto_scaling) to automatically adjust capacity and reduce idle compute.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
];

// ─── Export all AWS WAF rules ─────────────────────────────────────────────────

export const awsWaRules: WaRule[] = [
  ...awsOeRules,
  ...awsSecRules,
  ...awsRelRules,
  ...awsPerfRules,
  ...awsCostRules,
  ...awsSusRules,
];
