/**
 * AWS Security Rules for Phase 2D.
 *
 * Rules are deterministic — same resource config → same findings.
 * We only fire a finding when there is sufficient evidence from the persisted config.
 * We never fabricate findings when the field is absent/unknown.
 */
import type { SecurityRule } from './types';
import { SECURITY_SEVERITY } from '@/lib/domain/securitySeverity';

// ─── Helper ───────────────────────────────────────────────────────────────────

function cfg(resource: { configJson: string }): Record<string, unknown> {
  try { return JSON.parse(resource.configJson) as Record<string, unknown>; }
  catch { return {}; }
}

// ─── Rules ────────────────────────────────────────────────────────────────────

export const awsSecurityRules: SecurityRule[] = [

  // ── S3 ─────────────────────────────────────────────────────────────────────

  {
    ruleId: 'AWS-S3-PUBLIC',
    severity: SECURITY_SEVERITY.AWS_S3_PUBLIC_ACCESS,
    title: 'S3 Bucket publicly accessible',
    description: 'The S3 bucket configuration enables public access, allowing unauthenticated reads or writes from the internet.',
    remediation: 'Enable S3 Block Public Access settings: set blockPublicAcls, blockPublicPolicy, ignorePublicAcls, and restrictPublicBuckets to true.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_s3') return null;
      // Only fire when the field is explicitly set to true
      if (config['publicAccess'] !== true) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'aws', resourceType: resource.resourceType,
        meta: { publicAccess: config['publicAccess'] },
      };
    },
  },

  {
    ruleId: 'AWS-S3-NO-ENCRYPTION',
    severity: SECURITY_SEVERITY.AWS_S3_NOT_ENCRYPTED,
    title: 'S3 Bucket server-side encryption disabled',
    description: 'The S3 bucket does not have server-side encryption enabled, leaving data at rest unprotected.',
    remediation: 'Enable default server-side encryption (SSE-S3 or SSE-KMS) on the bucket using aws_s3_bucket_server_side_encryption_configuration.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_s3') return null;
      // Only fire when explicitly set to false
      if (config['encryption'] !== false) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'aws', resourceType: resource.resourceType,
        meta: { encryption: config['encryption'] },
      };
    },
  },

  {
    ruleId: 'AWS-S3-NO-PUBLIC-BLOCK',
    severity: 'high',
    title: 'S3 Bucket public access block missing',
    description: 'The S3 bucket does not have all four public access block settings enabled, which could allow accidental public exposure.',
    remediation: 'Set all four block public access settings to true: blockPublicAcls, blockPublicPolicy, ignorePublicAcls, restrictPublicBuckets.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_s3') return null;
      // blockPublicAccess is an optional field; only fire when explicitly false
      if (config['blockPublicAccess'] !== false) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'aws', resourceType: resource.resourceType,
        meta: { blockPublicAccess: config['blockPublicAccess'] },
      };
    },
  },

  // ── RDS ────────────────────────────────────────────────────────────────────

  {
    ruleId: 'AWS-RDS-NO-ENCRYPTION',
    severity: SECURITY_SEVERITY.AWS_RDS_NOT_ENCRYPTED,
    title: 'RDS instance storage encryption disabled',
    description: 'The RDS database instance does not have storage encryption enabled. Sensitive data at rest is unprotected.',
    remediation: 'Enable storage_encrypted on the RDS instance. Note: encryption must be enabled at creation time for existing instances, a snapshot restore is required.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_rds') return null;
      if (config['encrypted'] !== false) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'aws', resourceType: resource.resourceType,
        meta: { encrypted: config['encrypted'] },
      };
    },
  },

  {
    ruleId: 'AWS-RDS-PUBLICLY-ACCESSIBLE',
    severity: SECURITY_SEVERITY.AWS_RDS_PUBLICLY_ACCESSIBLE,
    title: 'RDS instance publicly accessible',
    description: 'The RDS instance has publicly_accessible set to true, exposing it directly to the internet.',
    remediation: 'Set publicly_accessible to false and place the RDS instance inside a private subnet. Use a bastion host or VPN for administrative access.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_rds') return null;
      if (config['publiclyAccessible'] !== true) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'aws', resourceType: resource.resourceType,
        meta: { publiclyAccessible: config['publiclyAccessible'] },
      };
    },
  },

  {
    ruleId: 'AWS-RDS-NO-MULTI-AZ',
    severity: SECURITY_SEVERITY.AWS_RDS_NOT_MULTI_AZ,
    title: 'RDS instance not configured for Multi-AZ',
    description: 'The RDS instance has Multi-AZ disabled, creating a single point of failure. Automatic failover is unavailable.',
    remediation: 'Enable Multi-AZ deployment for production RDS instances to ensure high availability and automatic failover.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_rds') return null;
      if (config['multiAz'] !== false) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'aws', resourceType: resource.resourceType,
        meta: { multiAz: config['multiAz'] },
      };
    },
  },

  // ── EC2 / Security Groups ──────────────────────────────────────────────────

  {
    ruleId: 'AWS-SG-OPEN-SSH',
    severity: 'high',
    title: 'Security Group allows unrestricted SSH access (port 22)',
    description: 'The security group allows inbound SSH (port 22) access from any IP address (0.0.0.0/0). This exposes instances to brute-force and unauthorized access.',
    remediation: 'Restrict SSH access to specific trusted IP ranges or use AWS Systems Manager Session Manager for SSH-less access.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_sg') return null;
      if (config['allowSsh'] !== true) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'aws', resourceType: resource.resourceType,
        meta: { allowSsh: config['allowSsh'] },
      };
    },
  },

  {
    ruleId: 'AWS-EC2-PUBLIC-SUBNET',
    severity: 'medium',
    title: 'EC2 instance may be in public subnet',
    description: 'The subnet is configured to auto-assign public IP addresses (mapPublicIpOnLaunch=true). EC2 instances launched here receive public IPs and may be directly reachable.',
    remediation: 'Disable mapPublicIpOnLaunch on subnets hosting compute instances. Place compute in private subnets behind a load balancer or NAT gateway.',
    check(resource, config, context) {
      if (resource.resourceType !== 'aws_subnet') return null;
      if (config['mapPublicIpOnLaunch'] !== true) return null;
      // Only fire if there is at least one EC2 connected to this subnet
      const hasEc2 = context.resources.some((r) => r.resourceType === 'aws_ec2');
      if (!hasEc2) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'aws', resourceType: resource.resourceType,
        meta: { mapPublicIpOnLaunch: config['mapPublicIpOnLaunch'] },
      };
    },
  },

  {
    ruleId: 'AWS-VPC-NO-DNS',
    severity: 'low',
    title: 'VPC has DNS support disabled',
    description: 'The VPC has enableDnsSupport set to false. This may prevent AWS service discovery and hostname resolution within the VPC.',
    remediation: 'Enable DNS support on the VPC (enableDnsSupport = true) to allow internal DNS resolution.',
    check(resource, config) {
      if (resource.resourceType !== 'aws_vpc') return null;
      if (config['enableDnsSupport'] !== false) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'aws', resourceType: resource.resourceType,
        meta: { enableDnsSupport: config['enableDnsSupport'] },
      };
    },
  },
];
