/**
 * AWS provider-native assessment rules.
 *
 * Every rule reads the SAME configuration keys the resource definitions
 * (lib/resources/aws.ts) and the Terraform generator use, so a finding, its
 * Auto-Fix and the generated HCL always refer to the same fact.
 *
 * Severity starts from the official AWS Security Hub (FSBP) severity where one
 * exists and is adjusted only with a documented reason in `rationale`.
 */
import type { AssessResource, RuleDefinition } from '../types';
import {
  REVIEWED, configEvaluator, ev, notModelled, rule, PUBLIC_CIDRS, directlyInternetLinked, fmt,
} from '../ruleHelpers';

const V = '1.0.0';
const deployed = (r: AssessResource) => ['imported', 'cloudcraft-managed', 'modified'].includes(String(r.importState ?? ''));
const TF = 'TF-AWS';

const WA = {
  sec: (practice: string) => ({ pillar: 'security' as const, practice }),
  rel: (practice: string) => ({ pillar: 'reliability' as const, practice }),
  ops: (practice: string) => ({ pillar: 'operational_excellence' as const, practice }),
  perf: (practice: string) => ({ pillar: 'performance_efficiency' as const, practice }),
  cost: (practice: string) => ({ pillar: 'cost_optimization' as const, practice }),
  sus: (practice: string) => ({ pillar: 'sustainability' as const, practice }),
};

const common = { version: V, lastReviewed: REVIEWED, provider: 'aws' as const };

export const awsRules: RuleDefinition[] = [
  // ════════════════════════════════════════════════════════════════════════
  // S3
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AWS-S3-001', service: 'Amazon S3', scope: 'resource', resourceTypes: ['aws_s3'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'CRITICAL', priority: 'REQUIRED_REMEDIATION',
    title: 'S3 bucket Block Public Access is not fully enforced',
    description: 'The bucket is configured to allow public access, so the generated Terraform does not enforce all four S3 Block Public Access settings.',
    rationale: 'Security Hub rates public read/write exposure of S3 buckets as critical (S3.2/S3.3) and requires bucket-level Block Public Access (S3.8). Severity is reduced to HIGH when public ACLs and public policies are both still blocked.',
    risk: 'Objects can be exposed to anonymous internet users through a bucket policy or ACL.',
    impact: 'Data disclosure, data tampering, and unexpected data-transfer charges.',
    wellArchitected: WA.sec('SEC 8 — Protect data at rest (access controls)'),
    references: ['AWS-FSBP-S3.8', 'AWS-FSBP-S3.2', 'AWS-FSBP-S3.3', 'AWS-WA-security', TF],
    soc1: ['SOC1-LA-01', 'SOC1-DP-01'],
    remediation: {
      recommendation: 'Keep S3 Block Public Access enabled at the bucket level. Serve public content through CloudFront with origin access control instead of a public bucket.',
      manualSteps: ['Confirm no consumer relies on anonymous bucket access.', 'Set Public Access to disabled and enable Block Public ACLs / Block Public Policy.', 'If content must be public, front the bucket with CloudFront (origin access control).'],
      terraform: 'aws_s3_bucket_public_access_block: block_public_acls, block_public_policy, ignore_public_acls, restrict_public_buckets = true',
    },
    autoFix: {
      safety: 'REVIEW_REQUIRED',
      safetyReason: 'Blocking public access breaks any website or consumer that intentionally reads the bucket anonymously.',
      description: 'Disable public access and enable all Block Public Access settings.',
      patch: () => ({ publicAccess: false, blockPublicAcls: true, blockPublicPolicy: true }),
      architectureImpact: 'Anonymous access to the bucket stops. Authenticated IAM and CloudFront (OAC) access are unaffected.',
      costImpact: 'NONE',
      terraformExpect: /restrict_public_buckets\s*=\s*true/,
    },
    evaluate: configEvaluator(['publicAccess'], { publicAccess: 'Disabled / No' }, (c) => {
      if (c.publicAccess !== true) {
        return { status: 'PASS', observation: 'Public access is disabled; the generated Terraform enforces all four Block Public Access settings.' };
      }
      const acls = c.blockPublicAcls === true;
      const policy = c.blockPublicPolicy === true;
      return {
        status: 'FAIL',
        severity: acls && policy ? 'HIGH' : 'CRITICAL',
        observation: `Public access is enabled. Effective Block Public Access: block public ACLs=${acls ? 'on' : 'off'}, block public policy=${policy ? 'on' : 'off'}, restrict public buckets=off.`,
      };
    }, ['blockPublicAcls', 'blockPublicPolicy']),
  }),
  rule({
    ...common,
    id: 'AWS-S3-002', service: 'Amazon S3', scope: 'resource', resourceTypes: ['aws_s3'],
    domain: 'SECURITY', category: 'Encryption at rest', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'S3 bucket has no explicit default encryption configuration',
    description: 'The bucket design does not declare a default server-side encryption configuration.',
    rationale: 'Since January 2023 Amazon S3 applies SSE-S3 to all new objects by default, so objects are still encrypted at rest. Declaring the configuration explicitly (or using SSE-KMS) documents intent and enables key-level access control. Security Hub retired its generic S3 SSE control for this reason; this is a LOW, evidence-of-intent finding, not a statement that data is unencrypted.',
    risk: 'Encryption depends on the platform default rather than on declared configuration; KMS-based access control and key auditing are not in place.',
    impact: 'Weaker audit evidence for encryption and no customer-controlled key separation.',
    wellArchitected: WA.sec('SEC 8 — Protect data at rest'),
    references: ['AWS-WA-security', TF],
    soc1: ['SOC1-DP-01'],
    remediation: {
      recommendation: 'Declare default encryption (SSE-S3, or SSE-KMS with a customer managed key for sensitive data).',
      manualSteps: ['Enable Default Encryption on the bucket.', 'For regulated data, choose aws:kms and a customer managed KMS key.'],
      terraform: 'aws_s3_bucket_server_side_encryption_configuration with apply_server_side_encryption_by_default',
    },
    autoFix: {
      safety: 'SAFE_AUTOFIX',
      safetyReason: 'Declaring SSE-S3 matches what S3 already applies by default; no data path changes.',
      description: 'Declare SSE-S3 (AES256) default encryption.',
      patch: (c) => ({ encryption: true, encryptionType: c.encryptionType || 'AES256' }),
      architectureImpact: 'None — documents the encryption configuration explicitly.',
      costImpact: 'NONE',
      terraformExpect: /aws_s3_bucket_server_side_encryption_configuration/,
    },
    evaluate: configEvaluator(['encryption'], { encryption: 'Enabled / Yes' }, (c) => c.encryption === false
      ? { status: 'WARNING', observation: 'Default encryption is not declared. S3 still applies SSE-S3 to new objects by default, but the design does not state it.' }
      : { status: 'PASS', observation: `Default encryption is declared (${fmt(c.encryptionType ?? 'AES256')}).` }, ['encryptionType']),
  }),
  rule({
    ...common,
    id: 'AWS-S3-003', service: 'Amazon S3', scope: 'resource', resourceTypes: ['aws_s3'],
    domain: 'SECURITY', category: 'Logging & audit', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'S3 server access logging is disabled',
    description: 'Server access logging is not enabled for the bucket.',
    rationale: 'Security Hub S3.9 (medium). Rated LOW here because CloudTrail data events can provide equivalent object-level audit evidence; CloudCraft cannot see whether they are enabled.',
    risk: 'Requests to the bucket cannot be reconstructed during an investigation.',
    impact: 'Reduced ability to investigate data access and support audit trails.',
    wellArchitected: WA.sec('SEC 4 — Detect and investigate security events'),
    references: ['AWS-FSBP-S3.9', 'AWS-WA-security'],
    soc1: ['SOC1-OP-01'],
    remediation: {
      recommendation: 'Enable server access logging to a dedicated, access-restricted log bucket, or enable CloudTrail S3 data events.',
      manualSteps: ['Create or select a log bucket in the same Region.', 'Enable server access logging targeting that bucket.', 'Restrict and retain the log bucket per your retention policy.'],
      terraform: 'aws_s3_bucket_logging (target_bucket, target_prefix)',
    },
    autoFix: {
      safety: 'MANUAL_ONLY',
      safetyReason: 'Requires choosing a target log bucket; the CloudCraft Terraform generator does not yet emit aws_s3_bucket_logging, so a config-only change would not reach Terraform.',
      description: 'Manual: configure a log destination bucket.',
      patch: () => ({}),
      architectureImpact: 'Adds a log bucket and log delivery.',
      costImpact: 'POSSIBLE_INCREASE',
    },
    evaluate: configEvaluator(['loggingEnabled'], { loggingEnabled: 'Enabled / Yes' }, (c) => c.loggingEnabled === true
      ? { status: 'PASS', observation: 'Server access logging is enabled.' }
      : { status: 'FAIL', observation: 'Server access logging is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-S3-004', service: 'Amazon S3', scope: 'resource', resourceTypes: ['aws_s3'],
    domain: 'SECURITY', category: 'Identity & access', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'S3 bucket permits access control lists (ACLs)',
    description: 'Object Ownership is not set to "Bucket owner enforced", so ACLs remain active for this bucket.',
    rationale: 'Security Hub S3.12 (medium): ACLs should not be used to manage user access; IAM and bucket policies give auditable, centralized access control.',
    risk: 'Access can be granted through object-level ACLs that bypass the bucket policy review process.',
    impact: 'Unintended cross-account or public object access that is hard to audit.',
    wellArchitected: WA.sec('SEC 3 — Manage permissions'),
    references: ['AWS-FSBP-S3.12', 'AWS-WA-security', TF],
    soc1: ['SOC1-LA-02'],
    remediation: {
      recommendation: 'Set Object Ownership to "Bucket owner enforced" to disable ACLs.',
      manualSteps: ['Confirm no workload writes objects with ACLs other than bucket-owner-full-control.', 'Set Object Ownership to BucketOwnerEnforced.'],
      terraform: 'aws_s3_bucket_ownership_controls rule { object_ownership = "BucketOwnerEnforced" }',
    },
    autoFix: {
      safety: 'REVIEW_REQUIRED',
      safetyReason: 'Workloads that rely on object ACLs (e.g. cross-account log delivery with ACLs) would lose access.',
      description: 'Set Object Ownership to BucketOwnerEnforced (disables ACLs).',
      patch: () => ({ objectOwnership: 'BucketOwnerEnforced' }),
      architectureImpact: 'ACL-based grants stop applying; access is governed by IAM and bucket policy only.',
      costImpact: 'NONE',
      terraformExpect: /object_ownership\s*=\s*"BucketOwnerEnforced"/,
    },
    evaluate: configEvaluator(['objectOwnership'], { objectOwnership: 'BucketOwnerEnforced' }, (c) => c.objectOwnership === 'BucketOwnerEnforced'
      ? { status: 'PASS', observation: 'ACLs are disabled (Bucket owner enforced).' }
      : { status: 'FAIL', observation: `Object Ownership is "${fmt(c.objectOwnership)}", so ACLs are still honored.` }),
  }),
  rule({
    ...common,
    id: 'AWS-S3-005', service: 'Amazon S3', scope: 'resource', resourceTypes: ['aws_s3'],
    domain: 'RELIABILITY', category: 'Data protection', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'S3 bucket versioning is disabled',
    description: 'Versioning is suspended, so overwritten or deleted objects cannot be recovered.',
    rationale: 'Security Hub S3.14 (low). Versioning protects against accidental deletion and overwrite.',
    risk: 'Accidental or malicious deletion/overwrite is unrecoverable.',
    impact: 'Permanent data loss.',
    wellArchitected: WA.rel('REL 9 — Back up data'),
    references: ['AWS-FSBP-S3.14', 'AWS-WA-reliability', TF],
    soc1: ['SOC1-OP-03'],
    remediation: {
      recommendation: 'Enable versioning; pair it with a lifecycle rule that expires noncurrent versions to control cost.',
      manualSteps: ['Enable bucket versioning.', 'Add a noncurrent-version expiration lifecycle rule.'],
      terraform: 'aws_s3_bucket_versioning versioning_configuration { status = "Enabled" }',
    },
    autoFix: {
      safety: 'SAFE_AUTOFIX',
      safetyReason: 'Additive: previous object versions are retained; reads and writes are unchanged.',
      description: 'Enable bucket versioning.',
      patch: () => ({ versioning: true }),
      architectureImpact: 'Previous versions of objects are retained.',
      costImpact: 'POSSIBLE_INCREASE',
      terraformExpect: /status\s*=\s*"Enabled"/,
    },
    evaluate: configEvaluator(['versioning'], { versioning: 'Enabled / Yes' }, (c) => c.versioning === true
      ? { status: 'PASS', observation: 'Versioning is enabled.' }
      : { status: 'FAIL', observation: 'Versioning is suspended.' }),
  }),
  rule({
    ...common,
    id: 'AWS-S3-006', service: 'Amazon S3', scope: 'resource', resourceTypes: ['aws_s3'],
    domain: 'COST_OPTIMIZATION', category: 'Cost', severity: 'LOW', priority: 'OPTIONAL_OPTIMIZATION',
    title: 'S3 bucket has no lifecycle policy',
    description: 'Neither a storage-class transition nor an expiration is configured.',
    rationale: 'Security Hub S3.13 (low). Lifecycle rules move infrequently accessed data to cheaper storage classes and expire data past retention.',
    risk: 'Data accumulates in S3 Standard indefinitely.',
    impact: 'Avoidable storage cost; data retained beyond its retention period.',
    wellArchitected: WA.cost('Manage demand and supply resources — data lifecycle'),
    references: ['AWS-FSBP-S3.13', 'AWS-WA-cost_optimization'],
    soc1: [],
    remediation: {
      recommendation: 'Define transition and expiration days based on the data retention policy.',
      manualSteps: ['Agree the retention period with the data owner.', 'Configure transition (e.g. STANDARD_IA) and expiration days.'],
      terraform: 'aws_s3_bucket_lifecycle_configuration',
    },
    autoFix: {
      safety: 'MANUAL_ONLY', safetyReason: 'Retention periods are a business decision; CloudCraft will not pick expiration days.',
      description: 'Manual: choose retention.', patch: () => ({}), architectureImpact: 'Objects transition/expire per policy.', costImpact: 'POSSIBLE_DECREASE',
    },
    evaluate: configEvaluator(['lifecycleTransitionDays', 'lifecycleExpirationDays'], {}, (c) =>
      Number(c.lifecycleTransitionDays) > 0 || Number(c.lifecycleExpirationDays) > 0
        ? { status: 'PASS', observation: 'A lifecycle transition or expiration is configured.' }
        : { status: 'WARNING', observation: 'No lifecycle transition or expiration is configured.' }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // RDS
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AWS-RDS-001', service: 'Amazon RDS', scope: 'resource', resourceTypes: ['aws_rds'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'CRITICAL', priority: 'REQUIRED_REMEDIATION',
    title: 'RDS database instance is publicly accessible',
    description: 'The instance is configured with Publicly Accessible = true, so it receives a public DNS endpoint reachable from outside the VPC (subject to security groups).',
    rationale: 'Security Hub RDS.2 (critical). Databases should only be reachable from application tiers inside private networks.',
    risk: 'The database endpoint is exposed to internet scanning, credential stuffing and exploitation of engine vulnerabilities.',
    impact: 'Unauthorized access to, or exfiltration of, application data.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-FSBP-RDS.2', 'AWS-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: {
      recommendation: 'Disable public accessibility and place the instance in private subnets; administer it through a bastion, SSM port forwarding, or VPN.',
      manualSteps: ['Confirm no client connects over the public endpoint.', 'Set Publicly Accessible to No.', 'Ensure the DB subnet group only contains private subnets.'],
      terraform: 'aws_db_instance.publicly_accessible = false',
    },
    autoFix: {
      safety: 'REVIEW_REQUIRED',
      safetyReason: 'Changes production connectivity: clients connecting over the public endpoint will lose access.',
      description: 'Set Publicly Accessible to false.',
      patch: () => ({ publiclyAccessible: false }),
      architectureImpact: 'The database becomes reachable only from inside the VPC (and peered/connected networks).',
      costImpact: 'NONE',
      terraformExpect: /publicly_accessible\s*=\s*false/,
    },
    evaluate: configEvaluator(['publiclyAccessible'], { publiclyAccessible: 'Disabled / No' }, (c, r, ctx) => {
      if (c.publiclyAccessible !== true) return { status: 'PASS', observation: 'The instance is not publicly accessible.' };
      const linked = directlyInternetLinked(r, ctx);
      return {
        status: 'FAIL',
        observation: `Publicly Accessible is enabled${linked ? ' and the diagram connects the database directly to an internet entry point' : ''}.`,
        extraEvidence: linked ? [{ label: 'Diagram relationship', observed: 'Direct connection from Internet / Internet Gateway', basis: 'RELATIONSHIP' }] : [],
      };
    }),
  }),
  rule({
    ...common,
    id: 'AWS-RDS-002', service: 'Amazon RDS', scope: 'resource', resourceTypes: ['aws_rds'],
    domain: 'SECURITY', category: 'Encryption at rest', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'RDS storage encryption is disabled',
    description: 'Storage encryption is off, so the DB instance storage, automated backups, read replicas and snapshots are not encrypted.',
    rationale: 'Security Hub RDS.3 is rated medium; CloudCraft rates it HIGH because a relational database is the primary store of application data and encryption cannot be enabled in place later.',
    risk: 'Data at rest (including snapshots and backups) is not protected by KMS.',
    impact: 'Exposure of data if storage media or snapshots are accessed; non-conformance with data-protection policies.',
    wellArchitected: WA.sec('SEC 8 — Protect data at rest'),
    references: ['AWS-FSBP-RDS.3', 'AWS-WA-security', TF],
    soc1: ['SOC1-DP-01'],
    remediation: {
      recommendation: 'Enable storage encryption (optionally with a customer managed KMS key).',
      manualSteps: ['For a new instance: enable Storage Encrypted before creation.', 'For an existing instance: snapshot → copy snapshot with encryption → restore → cut over.'],
      terraform: 'aws_db_instance.storage_encrypted = true (forces replacement of an existing instance)',
    },
    autoFix: {
      safety: (r) => (deployed(r) ? 'REVIEW_REQUIRED' : 'SAFE_AUTOFIX'),
      safetyReason: (r) => deployed(r)
        ? 'This instance already exists: enabling encryption forces Terraform to replace the database (snapshot/restore cut-over required).'
        : 'The instance has not been deployed yet, so encryption is set at creation time with no data migration.',
      description: 'Enable storage encryption.',
      patch: () => ({ encrypted: true }),
      architectureImpact: 'For planned instances: none. For deployed instances: database replacement.',
      costImpact: 'NONE',
      terraformExpect: /storage_encrypted\s*=\s*true/,
    },
    evaluate: configEvaluator(['encrypted'], { encrypted: 'Enabled / Yes' }, (c) => c.encrypted === false
      ? { status: 'FAIL', observation: 'Storage encryption is disabled.' }
      : { status: 'PASS', observation: `Storage encryption is enabled${c.kmsKeyId ? ' with a customer managed KMS key' : ' (AWS managed key)'}.` }, ['kmsKeyId']),
  }),
  rule({
    ...common,
    id: 'AWS-RDS-003', service: 'Amazon RDS', scope: 'resource', resourceTypes: ['aws_rds'],
    domain: 'SECURITY', category: 'Identity & access', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'RDS IAM database authentication is disabled',
    description: 'The instance accepts only native database credentials.',
    rationale: 'Security Hub RDS.10 (medium). Rated LOW because native credentials stored in Secrets Manager with rotation are an accepted alternative CloudCraft cannot observe.',
    risk: 'Long-lived database passwords must be distributed and rotated separately from IAM.',
    impact: 'Credential sprawl and weaker access revocation.',
    wellArchitected: WA.sec('SEC 2 — Manage authentication'),
    references: ['AWS-FSBP-RDS.10', 'AWS-WA-security', TF],
    soc1: ['SOC1-LA-03'],
    remediation: {
      recommendation: 'Enable IAM database authentication for application roles, or store native credentials in Secrets Manager with rotation.',
      manualSteps: ['Enable IAM DB authentication.', 'Create database users mapped to IAM (rds_iam role).', 'Update application connection logic to use auth tokens.'],
      terraform: 'aws_db_instance.iam_database_authentication_enabled = true',
    },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Enabling the flag is harmless, but applications must be changed to use IAM tokens for it to have effect.',
      description: 'Enable IAM database authentication.', patch: () => ({ iamDatabaseAuthenticationEnabled: true }),
      architectureImpact: 'IAM tokens become an accepted authentication method; existing passwords keep working.', costImpact: 'NONE',
      terraformExpect: /iam_database_authentication_enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['iamDatabaseAuthenticationEnabled'], { iamDatabaseAuthenticationEnabled: 'Enabled / Yes' }, (c) => c.iamDatabaseAuthenticationEnabled === true
      ? { status: 'PASS', observation: 'IAM database authentication is enabled.' }
      : { status: 'FAIL', observation: 'IAM database authentication is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-RDS-004', service: 'Amazon RDS', scope: 'resource', resourceTypes: ['aws_rds'],
    domain: 'SECURITY', category: 'Logging & audit', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'RDS database logs are not exported to CloudWatch Logs',
    description: 'No database log types are published to CloudWatch Logs.',
    rationale: 'Security Hub RDS.9 (medium). Rated LOW at design time because the relevant log types depend on the engine and audit requirements.',
    risk: 'Database errors, connections and audit events are not retained centrally.',
    impact: 'Limited ability to investigate database access and changes.',
    wellArchitected: WA.sec('SEC 4 — Detect and investigate security events'),
    references: ['AWS-FSBP-RDS.9', 'AWS-WA-security', TF],
    soc1: ['SOC1-OP-01'],
    remediation: {
      recommendation: 'Export the engine\'s relevant logs (e.g. postgresql, or audit/error/general/slowquery for MySQL) to CloudWatch Logs with a retention policy.',
      manualSteps: ['Select the log types appropriate for the engine.', 'Enable CloudWatch Logs exports.', 'Set log group retention.'],
      terraform: 'aws_db_instance.enabled_cloudwatch_logs_exports = [...]',
    },
    autoFix: {
      safety: 'MANUAL_ONLY', safetyReason: 'Valid log types differ per engine and audit logging may require parameter group changes.',
      description: 'Manual: choose engine log types.', patch: () => ({}), architectureImpact: 'Adds CloudWatch log groups.', costImpact: 'POSSIBLE_INCREASE',
    },
    evaluate: configEvaluator(['enableCloudwatchLogsExports'], {}, (c) =>
      Array.isArray(c.enableCloudwatchLogsExports) && c.enableCloudwatchLogsExports.length > 0
        ? { status: 'PASS', observation: `Exported log types: ${fmt(c.enableCloudwatchLogsExports)}.` }
        : { status: 'FAIL', observation: 'No log types are exported to CloudWatch Logs.' }),
  }),
  rule({
    ...common,
    id: 'AWS-RDS-005', service: 'Amazon RDS', scope: 'resource', resourceTypes: ['aws_rds'],
    domain: 'SECURITY', category: 'Workload hardening', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'RDS automatic minor version upgrade is disabled',
    description: 'Minor engine versions (which include security patches) will not be applied automatically.',
    rationale: 'Security Hub RDS.13 (rated high by the standard). Rated MEDIUM because patching may be handled by a documented manual process CloudCraft cannot observe.',
    risk: 'Known engine vulnerabilities remain unpatched.',
    impact: 'Exploitable database engine flaws.',
    wellArchitected: WA.sec('SEC 6 — Protect compute resources (patching)'),
    references: ['AWS-FSBP-RDS.13', 'AWS-WA-security', TF],
    soc1: ['SOC1-CM-02'],
    remediation: {
      recommendation: 'Enable automatic minor version upgrades during the maintenance window.',
      manualSteps: ['Confirm the maintenance window.', 'Enable Auto Minor Version Upgrade.'],
      terraform: 'aws_db_instance.auto_minor_version_upgrade = true',
    },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Upgrades only occur in the configured maintenance window; no immediate change is applied.',
      description: 'Enable automatic minor version upgrades.', patch: () => ({ autoMinorVersionUpgrade: true }),
      architectureImpact: 'Minor upgrades (brief restart) happen during the maintenance window.', costImpact: 'NONE',
      terraformExpect: /auto_minor_version_upgrade\s*=\s*true/,
    },
    evaluate: configEvaluator(['autoMinorVersionUpgrade'], { autoMinorVersionUpgrade: 'Enabled / Yes' }, (c) => c.autoMinorVersionUpgrade === false
      ? { status: 'FAIL', observation: 'Automatic minor version upgrade is disabled.' }
      : { status: 'PASS', observation: 'Automatic minor version upgrade is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-RDS-006', service: 'Amazon RDS', scope: 'resource', resourceTypes: ['aws_rds'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'RDS instance is not deployed across multiple Availability Zones',
    description: 'Multi-AZ is disabled, so there is no synchronous standby and no automatic failover.',
    rationale: 'Security Hub RDS.5 (medium); Reliability pillar fault-isolation guidance. Aurora engines replicate storage across AZs but still need a replica for compute failover.',
    risk: 'An AZ or instance failure makes the database unavailable until recovery.',
    impact: 'Application downtime; manual recovery from backups.',
    wellArchitected: WA.rel('REL 10 — Use fault isolation to protect your workload'),
    references: ['AWS-FSBP-RDS.5', 'AWS-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: {
      recommendation: 'Enable Multi-AZ for production databases.',
      manualSteps: ['Confirm the availability requirement justifies the cost.', 'Enable Multi-AZ (applied during the maintenance window or immediately).'],
      terraform: 'aws_db_instance.multi_az = true',
    },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Roughly doubles the instance cost; the change on a running instance triggers a standby build.',
      description: 'Enable Multi-AZ.', patch: () => ({ multiAz: true }),
      architectureImpact: 'Adds a synchronous standby in another AZ with automatic failover.', costImpact: 'POSSIBLE_INCREASE',
      terraformExpect: /multi_az\s*=\s*true/,
    },
    evaluate: configEvaluator(['multiAz'], { multiAz: 'Enabled / Yes' }, (c) => c.multiAz === true
      ? { status: 'PASS', observation: 'Multi-AZ is enabled.' }
      : { status: 'FAIL', observation: 'Multi-AZ is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-RDS-007', service: 'Amazon RDS', scope: 'resource', resourceTypes: ['aws_rds'],
    domain: 'RELIABILITY', category: 'Data protection', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'RDS automated backups are disabled or retained for less than 7 days',
    description: 'The backup retention period is below the 7-day minimum used by Security Hub RDS.11.',
    rationale: 'Security Hub RDS.11 (medium, default minimum 7 days). A retention of 0 disables automated backups and point-in-time recovery entirely and is rated HIGH; 1–6 days is rated LOW.',
    risk: 'Data cannot be restored to a point in time after corruption or deletion.',
    impact: 'Permanent data loss.',
    wellArchitected: WA.rel('REL 9 — Back up data'),
    references: ['AWS-FSBP-RDS.11', 'AWS-WA-reliability', TF],
    soc1: ['SOC1-OP-03'],
    remediation: {
      recommendation: 'Retain automated backups for at least 7 days (longer if required by your recovery objectives).',
      manualSteps: ['Set Backup Retention Period to 7 days or more.', 'Confirm the backup window.'],
      terraform: 'aws_db_instance.backup_retention_period >= 7',
    },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Additive data protection; backups run in the backup window without downtime for Multi-AZ, brief I/O suspension for Single-AZ.',
      description: 'Set backup retention to 7 days.', patch: () => ({ backupRetentionPeriod: 7 }),
      architectureImpact: 'Automated backups and point-in-time recovery for 7 days.', costImpact: 'POSSIBLE_INCREASE',
      terraformExpect: /backup_retention_period\s*=\s*7/,
    },
    evaluate: configEvaluator(['backupRetentionPeriod'], { backupRetentionPeriod: '7 or more days' }, (c) => {
      const d = Number(c.backupRetentionPeriod);
      if (d <= 0) return { status: 'FAIL', severity: 'HIGH', observation: 'Automated backups are disabled (retention 0 days).' };
      if (d < 7) return { status: 'FAIL', severity: 'LOW', observation: `Backups are retained for ${d} day(s), below the 7-day minimum.` };
      return { status: 'PASS', observation: `Backups are retained for ${d} days.` };
    }),
  }),
  rule({
    ...common,
    id: 'AWS-RDS-008', service: 'Amazon RDS', scope: 'resource', resourceTypes: ['aws_rds'],
    domain: 'RELIABILITY', category: 'Data protection', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'RDS deletion protection is disabled',
    description: 'The instance can be deleted without first disabling deletion protection.',
    rationale: 'Security Hub RDS.8 (low).',
    risk: 'Accidental deletion by a person or automation.',
    impact: 'Outage and potential data loss.',
    wellArchitected: WA.rel('REL 9 — Back up data'),
    references: ['AWS-FSBP-RDS.8', 'AWS-WA-reliability', TF],
    soc1: ['SOC1-CM-01'],
    remediation: { recommendation: 'Enable deletion protection.', manualSteps: ['Enable Deletion Protection.'], terraform: 'aws_db_instance.deletion_protection = true' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Metadata-only change; blocks deletion until explicitly disabled.',
      description: 'Enable deletion protection.', patch: () => ({ deletionProtection: true }),
      architectureImpact: 'Delete operations are refused until protection is removed.', costImpact: 'NONE',
      terraformExpect: /deletion_protection\s*=\s*true/,
    },
    evaluate: configEvaluator(['deletionProtection'], { deletionProtection: 'Enabled / Yes' }, (c) => c.deletionProtection === true
      ? { status: 'PASS', observation: 'Deletion protection is enabled.' }
      : { status: 'FAIL', observation: 'Deletion protection is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-RDS-009', service: 'Amazon RDS', scope: 'resource', resourceTypes: ['aws_rds'],
    domain: 'OPERATIONAL_EXCELLENCE', category: 'Monitoring', severity: 'LOW', priority: 'OPTIONAL_OPTIMIZATION',
    title: 'RDS Enhanced Monitoring is disabled',
    description: 'OS-level metrics are not collected for the DB instance.',
    rationale: 'Security Hub RDS.6 (low).',
    risk: 'Operating-system level resource exhaustion is harder to diagnose.',
    impact: 'Longer incident resolution.',
    wellArchitected: WA.ops('Implement observability'),
    references: ['AWS-FSBP-RDS.6', 'AWS-WA-operational_excellence', TF],
    soc1: ['SOC1-OP-02'],
    remediation: { recommendation: 'Enable Enhanced Monitoring (e.g. 60-second granularity).', manualSteps: ['Set the monitoring interval.', 'Allow CloudCraft to create the monitoring IAM role.'], terraform: 'aws_db_instance.monitoring_interval + monitoring_role_arn' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Creates an IAM role for RDS monitoring and adds CloudWatch Logs charges.',
      description: 'Enable Enhanced Monitoring at 60-second granularity.', patch: () => ({ monitoringInterval: 60 }),
      architectureImpact: 'Adds an IAM role for RDS Enhanced Monitoring.', costImpact: 'POSSIBLE_INCREASE',
      terraformExpect: /monitoring_interval\s*=\s*60/,
    },
    evaluate: configEvaluator(['monitoringInterval'], { monitoringInterval: '1–60 seconds' }, (c) => Number(c.monitoringInterval) > 0
      ? { status: 'PASS', observation: `Enhanced Monitoring interval is ${c.monitoringInterval} seconds.` }
      : { status: 'FAIL', observation: 'Enhanced Monitoring is disabled (interval 0).' }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // EC2 / EBS / VPC / networking
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AWS-EC2-001', service: 'Amazon EC2', scope: 'resource', resourceTypes: ['aws_ec2'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'EC2 instance is assigned a public IP address',
    description: 'The instance receives a public IPv4 address at launch.',
    rationale: 'Security Hub EC2.9 is rated high; CloudCraft rates it MEDIUM because inbound reachability also depends on security group rules evaluated separately (AWS-SG-001/002). Raised to HIGH if the diagram links the instance directly to an internet entry point.',
    risk: 'The instance is directly addressable from the internet.',
    impact: 'Larger attack surface; bypass of load balancer and WAF controls.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-FSBP-EC2.9', 'AWS-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Place instances in private subnets behind a load balancer; use NAT for egress and SSM Session Manager for administration.', manualSteps: ['Move the instance to a private subnet.', 'Disable public IP assignment.', 'Route inbound traffic through a load balancer.'], terraform: 'aws_instance.associate_public_ip_address = false' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Removes direct internet reachability; egress requires a NAT gateway and admins need an alternate access path.',
      description: 'Disable public IP assignment.', patch: () => ({ associatePublicIpAddress: false }),
      architectureImpact: 'Instance is no longer directly reachable; outbound internet needs NAT.', costImpact: 'NONE',
      terraformExpect: /associate_public_ip_address\s*=\s*false/,
    },
    evaluate: configEvaluator(['associatePublicIpAddress'], { associatePublicIpAddress: 'Disabled / No' }, (c, r, ctx) => {
      if (c.associatePublicIpAddress !== true) return { status: 'PASS', observation: 'No public IP address is assigned.' };
      const linked = directlyInternetLinked(r, ctx);
      return { status: 'FAIL', severity: linked ? 'HIGH' : 'MEDIUM', observation: `A public IP address is assigned at launch${linked ? ' and the diagram connects the instance directly to an internet entry point' : ''}.` };
    }),
  }),
  rule({
    ...common,
    id: 'AWS-EC2-002', service: 'Amazon EC2', scope: 'resource', resourceTypes: ['aws_ec2'],
    domain: 'SECURITY', category: 'Encryption at rest', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'EC2 root volume is not encrypted',
    description: 'The root EBS volume is created without encryption.',
    rationale: 'Security Hub EC2.3 (medium).',
    risk: 'Instance data and snapshots are not protected by KMS.',
    impact: 'Data exposure through snapshots or volume access.',
    wellArchitected: WA.sec('SEC 8 — Protect data at rest'),
    references: ['AWS-FSBP-EC2.3', 'AWS-WA-security', TF],
    soc1: ['SOC1-DP-01'],
    remediation: { recommendation: 'Encrypt the root volume (and enable EBS encryption by default in the account).', manualSteps: ['Enable root volume encryption.', 'For a running instance: create an encrypted AMI/volume and replace.'], terraform: 'aws_instance.root_block_device.encrypted = true' },
    autoFix: {
      safety: (r) => (deployed(r) ? 'REVIEW_REQUIRED' : 'SAFE_AUTOFIX'),
      safetyReason: (r) => deployed(r) ? 'Changing root volume encryption on an existing instance forces replacement.' : 'Not yet deployed: encryption is applied at creation.',
      description: 'Encrypt the root volume.', patch: () => ({ encrypted: true }),
      architectureImpact: 'Planned: none. Deployed: instance replacement.', costImpact: 'NONE',
      terraformExpect: /encrypted\s*=\s*true/,
    },
    evaluate: configEvaluator(['encrypted'], { encrypted: 'Enabled / Yes' }, (c) => c.encrypted === false
      ? { status: 'FAIL', observation: 'Root volume encryption is disabled.' }
      : { status: 'PASS', observation: 'Root volume encryption is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-EC2-003', service: 'Amazon EC2', scope: 'resource', resourceTypes: ['aws_ec2'],
    domain: 'SECURITY', category: 'Workload hardening', severity: 'HIGH', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'EC2 instance metadata service version (IMDSv2) not modelled',
    description: 'Security Hub EC2.8 requires IMDSv2 (HttpTokens = required). CloudCraft does not model instance metadata options.',
    rationale: 'Security Hub EC2.8 (high). Reported as NOT EVALUATED — CloudCraft never assumes IMDSv2 is enforced.',
    risk: 'IMDSv1 allows SSRF-based credential theft.',
    impact: 'Theft of instance role credentials.',
    wellArchitected: WA.sec('SEC 6 — Protect compute resources'),
    references: ['AWS-FSBP-EC2.8', 'AWS-WA-security'],
    soc1: ['SOC1-LA-02'],
    remediation: { recommendation: 'Require IMDSv2 on all instances and launch templates.', manualSteps: ['Set metadata_options.http_tokens = "required".'], terraform: 'aws_instance.metadata_options { http_tokens = "required" }' },
    evaluate: (r) => notModelled('Instance metadata options (IMDSv2)', 'Live discovery of MetadataOptions.HttpTokens, or a CloudCraft configuration field for metadata options.', [r.id]),
  }),
  rule({
    ...common,
    id: 'AWS-EBS-001', service: 'Amazon EBS', scope: 'resource', resourceTypes: ['aws_ebs'],
    domain: 'SECURITY', category: 'Encryption at rest', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'EBS volume is not encrypted',
    description: 'The volume is created without encryption.',
    rationale: 'Security Hub EC2.3 (medium).',
    risk: 'Volume data and its snapshots are not protected by KMS.',
    impact: 'Data exposure through snapshots or volume access.',
    wellArchitected: WA.sec('SEC 8 — Protect data at rest'),
    references: ['AWS-FSBP-EC2.3', 'AWS-WA-security', TF],
    soc1: ['SOC1-DP-01'],
    remediation: { recommendation: 'Encrypt the volume.', manualSteps: ['Enable encryption (existing volumes: snapshot → encrypted copy → new volume).'], terraform: 'aws_ebs_volume.encrypted = true' },
    autoFix: {
      safety: (r) => (deployed(r) ? 'REVIEW_REQUIRED' : 'SAFE_AUTOFIX'),
      safetyReason: (r) => deployed(r) ? 'Encrypting an existing volume forces replacement.' : 'Not yet deployed: encryption is applied at creation.',
      description: 'Encrypt the volume.', patch: () => ({ encrypted: true }), architectureImpact: 'Planned: none. Deployed: volume replacement.', costImpact: 'NONE',
      terraformExpect: /encrypted\s*=\s*true/,
    },
    evaluate: configEvaluator(['encrypted'], { encrypted: 'Enabled / Yes' }, (c) => c.encrypted === false
      ? { status: 'FAIL', observation: 'Volume encryption is disabled.' }
      : { status: 'PASS', observation: 'Volume encryption is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-EBS-002', service: 'Amazon EBS', scope: 'resource', resourceTypes: ['aws_ebs'],
    domain: 'RELIABILITY', category: 'Data protection', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'EBS volume has no snapshot schedule',
    description: 'No automated snapshot schedule is configured for the volume.',
    rationale: 'Reliability pillar backup guidance (REL 9).',
    risk: 'Volume data cannot be restored after loss or corruption.',
    impact: 'Data loss.',
    wellArchitected: WA.rel('REL 9 — Back up data'),
    references: ['AWS-WA-reliability'],
    soc1: ['SOC1-OP-03'],
    remediation: { recommendation: 'Protect the volume with AWS Backup or Data Lifecycle Manager.', manualSteps: ['Create an AWS Backup plan or DLM policy targeting the volume.'] },
    autoFix: {
      safety: 'MANUAL_ONLY', safetyReason: 'The CloudCraft Terraform generator does not emit AWS Backup/DLM resources, so a config change would not reach Terraform.',
      description: 'Manual: add AWS Backup or DLM policy.', patch: () => ({}), architectureImpact: 'Adds backup policy.', costImpact: 'POSSIBLE_INCREASE',
    },
    evaluate: configEvaluator(['snapshotSchedule'], {}, (c) => (c.snapshotSchedule && c.snapshotSchedule !== 'none')
      ? { status: 'PASS', observation: `Snapshot schedule: ${fmt(c.snapshotSchedule)}.` }
      : { status: 'FAIL', observation: 'No snapshot schedule is configured.' }),
  }),
  rule({
    ...common,
    id: 'AWS-VPC-001', service: 'Amazon VPC', scope: 'resource', resourceTypes: ['aws_subnet'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Subnet automatically assigns public IP addresses',
    description: 'Instances launched in this subnet receive a public IPv4 address by default.',
    rationale: 'Security Hub EC2.15 (medium).',
    risk: 'Workloads can become internet-addressable without an explicit decision.',
    impact: 'Unintended internet exposure of compute.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-FSBP-EC2.15', 'AWS-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Disable auto-assign public IP; request public IPs explicitly only where required (e.g. NAT gateways, bastions).', manualSteps: ['Disable Map Public IP on Launch.', 'Assign Elastic IPs explicitly where needed.'], terraform: 'aws_subnet.map_public_ip_on_launch = false' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Instances in public subnets that rely on automatic public IPs (e.g. bastions) would lose internet reachability.',
      description: 'Disable automatic public IP assignment.', patch: () => ({ mapPublicIpOnLaunch: false }),
      architectureImpact: 'New instances in the subnet get only private IPs unless requested explicitly.', costImpact: 'NONE',
      terraformExpect: /map_public_ip_on_launch\s*=\s*false/,
    },
    evaluate: configEvaluator(['mapPublicIpOnLaunch'], { mapPublicIpOnLaunch: 'Disabled / No' }, (c) => c.mapPublicIpOnLaunch === true
      ? { status: 'FAIL', observation: 'Map Public IP on Launch is enabled.' }
      : { status: 'PASS', observation: 'Map Public IP on Launch is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-VPC-002', service: 'Amazon VPC', scope: 'resource', resourceTypes: ['aws_vpc'],
    domain: 'SECURITY', category: 'Logging & audit', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'VPC flow logging not modelled',
    description: 'Security Hub EC2.6 requires VPC Flow Logs. CloudCraft does not model flow logs.',
    rationale: 'Reported NOT EVALUATED — flow logging is never assumed.',
    risk: 'Network traffic cannot be investigated.', impact: 'Reduced incident investigation capability.',
    wellArchitected: WA.sec('SEC 4 — Detect and investigate security events'),
    references: ['AWS-FSBP-EC2.6', 'AWS-WA-security'],
    soc1: ['SOC1-OP-01'],
    remediation: { recommendation: 'Enable VPC Flow Logs (at least REJECT traffic) to CloudWatch Logs or S3.', manualSteps: ['Create aws_flow_log for the VPC.'], terraform: 'aws_flow_log (vpc_id, traffic_type, log_destination)' },
    evaluate: (r) => notModelled('VPC Flow Logs', 'Live discovery of flow logs for this VPC, or a CloudCraft flow-log resource.', [r.id]),
  }),
  rule({
    ...common,
    id: 'AWS-VPC-003', service: 'Amazon VPC', scope: 'resource', resourceTypes: ['aws_vpc'],
    domain: 'OPERATIONAL_EXCELLENCE', category: 'Operations', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'VPC DNS resolution is disabled',
    description: 'enableDnsSupport is false, so the Amazon-provided DNS resolver is unavailable in the VPC.',
    rationale: 'Interface VPC endpoints with private DNS, EKS and many managed services require DNS support. This is an operational defect, not a security control.',
    risk: 'Service discovery and private endpoints fail to resolve.', impact: 'Application failures after deployment.',
    wellArchitected: WA.ops('Design for operations'),
    references: ['AWS-WA-operational_excellence', TF],
    soc1: [],
    remediation: { recommendation: 'Enable DNS support on the VPC.', manualSteps: ['Enable DNS resolution.'], terraform: 'aws_vpc.enable_dns_support = true' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Enables the Amazon-provided resolver; does not change routing or exposure.',
      description: 'Enable DNS support.', patch: () => ({ enableDnsSupport: true }), architectureImpact: 'Amazon DNS resolver available in the VPC.', costImpact: 'NONE',
      terraformExpect: /enable_dns_support\s*=\s*true/,
    },
    evaluate: configEvaluator(['enableDnsSupport'], { enableDnsSupport: 'Enabled / Yes' }, (c) => c.enableDnsSupport === false
      ? { status: 'FAIL', observation: 'DNS support is disabled.' }
      : { status: 'PASS', observation: 'DNS support is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-SG-001', service: 'Amazon EC2 security groups', scope: 'resource', resourceTypes: ['aws_sg'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'Security group allows SSH (22) from the entire internet',
    description: 'An inbound rule allows TCP 22 from 0.0.0.0/0 or ::/0.',
    rationale: 'Security Hub EC2.13 (high).',
    risk: 'Administrative access is exposed to brute force and exploitation.',
    impact: 'Compromise of instances associated with this security group.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-FSBP-EC2.13', 'AWS-WA-security', TF],
    soc1: ['SOC1-LA-01', 'SOC1-LA-02'],
    remediation: { recommendation: 'Remove internet-wide SSH. Use SSM Session Manager, or restrict the source to known administrator CIDRs.', manualSteps: ['Identify who needs SSH access.', 'Replace 0.0.0.0/0 with specific CIDRs, or remove the rule and use Session Manager.'], terraform: 'aws_security_group ingress: remove from_port 22 with cidr_blocks 0.0.0.0/0' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Removing SSH can lock administrators out unless an alternative (Session Manager/VPN) exists.',
      description: 'Remove the SSH ingress rule.', patch: () => ({ allowSsh: false }),
      architectureImpact: 'SSH ingress is removed from this security group.', costImpact: 'NONE',
    },
    evaluate: configEvaluator(['allowSsh'], { allowSsh: 'Disabled, or restricted source CIDR' }, (c, r) => {
      if (c.allowSsh !== true) return { status: 'PASS', observation: 'No SSH ingress rule.' };
      if (c.sourceCidr === undefined || c.sourceCidr === null || c.sourceCidr === '') {
        return { status: 'WARNING', observation: 'SSH ingress is allowed but the source CIDR is not specified; the generated Terraform defaults to 0.0.0.0/0.', extraEvidence: [ev(r, 'sourceCidr')] };
      }
      return PUBLIC_CIDRS.has(String(c.sourceCidr))
        ? { status: 'FAIL', observation: `SSH (22) is open to ${c.sourceCidr}.`, extraEvidence: [ev(r, 'sourceCidr', 'Specific trusted CIDR')] }
        : { status: 'PASS', observation: `SSH is restricted to ${c.sourceCidr}.`, extraEvidence: [ev(r, 'sourceCidr')] };
    }),
  }),
  rule({
    ...common,
    id: 'AWS-SG-002', service: 'Amazon EC2 security groups', scope: 'resource', resourceTypes: ['aws_sg'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'Security group allows RDP (3389) from the entire internet',
    description: 'An inbound rule allows TCP 3389 from 0.0.0.0/0 or ::/0.',
    rationale: 'Security Hub EC2.14 (high).',
    risk: 'Remote desktop is exposed to brute force and exploitation.',
    impact: 'Compromise of Windows instances associated with this security group.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-FSBP-EC2.14', 'AWS-WA-security', TF],
    soc1: ['SOC1-LA-01', 'SOC1-LA-02'],
    remediation: { recommendation: 'Remove internet-wide RDP. Use Fleet Manager / Session Manager port forwarding, or restrict to known CIDRs.', manualSteps: ['Restrict or remove the 3389 ingress rule.'], terraform: 'aws_security_group ingress: remove from_port 3389 with cidr_blocks 0.0.0.0/0' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Removing RDP can lock administrators out unless an alternative access path exists.',
      description: 'Remove the RDP ingress rule.', patch: () => ({ allowRdp: false }),
      architectureImpact: 'RDP ingress is removed from this security group.', costImpact: 'NONE',
    },
    evaluate: configEvaluator(['allowRdp'], { allowRdp: 'Disabled, or restricted source CIDR' }, (c, r) => {
      if (c.allowRdp !== true) return { status: 'PASS', observation: 'No RDP ingress rule.' };
      if (c.sourceCidr === undefined || c.sourceCidr === null || c.sourceCidr === '') {
        return { status: 'WARNING', observation: 'RDP ingress is allowed but the source CIDR is not specified; the generated Terraform defaults to 0.0.0.0/0.', extraEvidence: [ev(r, 'sourceCidr')] };
      }
      return PUBLIC_CIDRS.has(String(c.sourceCidr))
        ? { status: 'FAIL', observation: `RDP (3389) is open to ${c.sourceCidr}.`, extraEvidence: [ev(r, 'sourceCidr', 'Specific trusted CIDR')] }
        : { status: 'PASS', observation: `RDP is restricted to ${c.sourceCidr}.`, extraEvidence: [ev(r, 'sourceCidr')] };
    }),
  }),
  rule({
    ...common,
    id: 'AWS-SG-003', service: 'Amazon EC2 security groups', scope: 'architecture',
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Network access rules for compute and databases are not modelled',
    description: 'The architecture contains compute or database resources but no security groups.',
    rationale: 'AWS always associates a security group (the VPC default group if none is specified), so the absence of security groups in the diagram does NOT mean traffic is unrestricted — it means the rules cannot be assessed.',
    risk: 'Ingress rules cannot be reviewed at design time.', impact: 'Exposure cannot be ruled out.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-WA-security'],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Model a least-privilege security group per tier (load balancer, application, database).', manualSteps: ['Add security groups for each tier.', 'Reference security groups instead of CIDRs between tiers.'] },
    evaluateArchitecture: (ctx) => {
      const workloads = ctx.ofType('aws_ec2', 'aws_rds', 'aws_ecs', 'aws_eks', 'aws_elasticache', 'aws_alb');
      if (workloads.length === 0) return [{ status: 'NOT_APPLICABLE', observation: 'No VPC-attached compute or database resources.', evidence: [] }];
      if (ctx.ofType('aws_sg').length > 0) return [{ status: 'NOT_APPLICABLE', observation: 'Security groups are modelled and evaluated by AWS-SG-001/002.', evidence: [], resourceIds: [] }];
      return [{
        ...notModelled('Security group rules', 'Add security groups to the architecture, or import them from the AWS account.', workloads.map((w) => w.id)),
        evidence: [{ label: 'VPC-attached workloads', observed: String(workloads.length), basis: 'TOPOLOGY' }, { label: 'Security groups in architecture', observed: '0', basis: 'TOPOLOGY' }],
      }];
    },
  }),
  rule({
    ...common,
    id: 'AWS-NACL-001', service: 'Amazon VPC network ACLs', scope: 'resource', resourceTypes: ['aws_nacl'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Network ACL allows internet ingress to administrative ports',
    description: 'An inbound NACL entry from 0.0.0.0/0 covers port 22 or 3389 (including allow-all entries).',
    rationale: 'Security Hub EC2.21 (medium).',
    risk: 'The subnet-level network control does not restrict administrative ports.', impact: 'Reduced defense in depth.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-FSBP-EC2.21', 'AWS-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Restrict NACL inbound entries to required ports and sources.', manualSteps: ['Replace allow-all inbound with explicit port ranges.'], terraform: 'aws_network_acl ingress rules' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'NACLs are stateless; narrowing inbound rules can break return traffic and other flows.',
      description: 'Disable the allow-all inbound entry.', patch: () => ({ allowAllInbound: false }),
      architectureImpact: 'Only the explicit inbound port range is allowed.', costImpact: 'NONE',
    },
    evaluate: configEvaluator(['allowAllInbound', 'inboundCidr'], { inboundCidr: 'Not 0.0.0.0/0 for admin ports' }, (c) => {
      const publicSrc = PUBLIC_CIDRS.has(String(c.inboundCidr));
      if (!publicSrc) return { status: 'PASS', observation: `Inbound source is restricted to ${c.inboundCidr}.` };
      if (c.allowAllInbound === true) return { status: 'FAIL', observation: `All inbound traffic is allowed from ${c.inboundCidr}.` };
      const from = Number(c.inboundPortFrom); const to = Number(c.inboundPortTo);
      const covers = (p: number) => Number.isFinite(from) && Number.isFinite(to) && from <= p && p <= to;
      if (c.inboundProtocol === 'all' || covers(22) || covers(3389)) {
        return { status: 'FAIL', observation: `Inbound ports ${fmt(c.inboundPortFrom)}–${fmt(c.inboundPortTo)} (${fmt(c.inboundProtocol)}) from ${c.inboundCidr} include an administrative port.` };
      }
      return { status: 'PASS', observation: `Internet ingress is limited to ports ${fmt(c.inboundPortFrom)}–${fmt(c.inboundPortTo)}.` };
    }, ['inboundProtocol', 'inboundPortFrom', 'inboundPortTo']),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Load balancing & edge
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AWS-ELB-001', service: 'Elastic Load Balancing', scope: 'resource', resourceTypes: ['aws_alb'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'HTTPS listener has no certificate',
    description: 'The listener protocol is HTTPS but no ACM certificate ARN is configured.',
    rationale: 'An HTTPS/TLS listener cannot be created without a certificate; the generated Terraform will fail to apply.',
    risk: 'Deployment failure, or a fallback to plaintext HTTP.', impact: 'Unencrypted client traffic or failed release.',
    wellArchitected: WA.sec('SEC 9 — Protect data in transit'),
    references: ['AWS-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Provision an ACM certificate for the domain and attach it to the listener.', manualSteps: ['Request/import an ACM certificate.', 'Set the certificate ARN on the listener.'], terraform: 'aws_lb_listener.certificate_arn' },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Requires a real certificate for your domain.', description: 'Manual: attach an ACM certificate.', patch: () => ({}), architectureImpact: 'None.', costImpact: 'NONE' },
    evaluate: configEvaluator(['listenerProtocol'], {}, (c, r) => {
      if (c.listenerProtocol !== 'HTTPS' && c.listenerProtocol !== 'TLS') return { status: 'NOT_APPLICABLE', observation: `Listener protocol is ${fmt(c.listenerProtocol)}.` };
      return c.certificateArn ? { status: 'PASS', observation: 'A certificate is attached to the listener.', extraEvidence: [ev(r, 'certificateArn')] }
        : { status: 'FAIL', observation: `The ${c.listenerProtocol} listener has no certificate ARN.`, extraEvidence: [ev(r, 'certificateArn', 'ACM certificate ARN')] };
    }),
  }),
  rule({
    ...common,
    id: 'AWS-ELB-002', service: 'Elastic Load Balancing', scope: 'resource', resourceTypes: ['aws_alb'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Internet-facing load balancer serves plaintext HTTP',
    description: 'The internet-facing listener uses HTTP without HTTPS termination.',
    rationale: 'Security Hub ELB.1 (medium) requires HTTP listeners to redirect to HTTPS.',
    risk: 'Credentials and session data transit the internet unencrypted.', impact: 'Interception or modification of traffic.',
    wellArchitected: WA.sec('SEC 9 — Protect data in transit'),
    references: ['AWS-FSBP-ELB.1', 'AWS-WA-security'],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Terminate TLS on an HTTPS listener with an ACM certificate and redirect HTTP to HTTPS.', manualSteps: ['Add an HTTPS listener with a certificate.', 'Change the HTTP listener default action to redirect to HTTPS.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Requires a certificate for your domain; switching the protocol alone would create an invalid listener.', description: 'Manual: add HTTPS listener.', patch: () => ({}), architectureImpact: 'Clients must use HTTPS.', costImpact: 'NONE' },
    evaluate: configEvaluator(['scheme', 'listenerProtocol'], {}, (c) => {
      if (c.scheme !== 'internet-facing') return { status: 'NOT_APPLICABLE', observation: 'The load balancer is internal.' };
      if (c.lbType && c.lbType !== 'application') return { status: 'NOT_APPLICABLE', observation: `Not an Application Load Balancer (${fmt(c.lbType)}).` };
      return c.listenerProtocol === 'HTTP'
        ? { status: 'FAIL', observation: 'The internet-facing listener uses HTTP.' }
        : { status: 'PASS', observation: `Listener protocol is ${fmt(c.listenerProtocol)}.` };
    }, ['lbType']),
  }),
  rule({
    ...common,
    id: 'AWS-ELB-003', service: 'Elastic Load Balancing', scope: 'resource', resourceTypes: ['aws_alb'],
    domain: 'SECURITY', category: 'Edge protection', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Internet-facing Application Load Balancer has no AWS WAF web ACL',
    description: 'No AWS WAF web ACL is connected to the internet-facing ALB in the architecture.',
    rationale: 'Security Hub ELB.16 (medium). Evidence is the absence of a relationship to an aws_waf resource in the diagram.',
    risk: 'Common web exploits (SQLi, XSS, bad bots) reach the application unfiltered.', impact: 'Application compromise or abuse.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-FSBP-ELB.16', 'AWS-WA-security'],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Associate a regional AWS WAF web ACL with AWS managed rule groups.', manualSteps: ['Add an AWS WAF (REGIONAL) web ACL.', 'Connect it to the ALB.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Adds a new billable resource and rules that must be tuned for the application.', description: 'Manual: add a WAF web ACL.', patch: () => ({}), architectureImpact: 'Adds AWS WAF.', costImpact: 'POSSIBLE_INCREASE' },
    evaluate: configEvaluator(['scheme'], {}, (c, r, ctx) => {
      if (c.scheme !== 'internet-facing') return { status: 'NOT_APPLICABLE', observation: 'The load balancer is internal.' };
      if (c.lbType && c.lbType !== 'application') return { status: 'NOT_APPLICABLE', observation: 'AWS WAF applies to Application Load Balancers only.' };
      const waf = ctx.neighbors(r.id).find((n) => n.resourceType === 'aws_waf');
      return waf
        ? { status: 'PASS', observation: `Connected to AWS WAF web ACL "${waf.label}".`, extraEvidence: [{ label: 'Diagram relationship', observed: `Connected to ${waf.label}`, basis: 'RELATIONSHIP' }] }
        : { status: 'FAIL', observation: 'No AWS WAF web ACL is connected to this load balancer in the architecture.', extraEvidence: [{ label: 'Diagram relationship', observed: 'No connection to an AWS WAF web ACL', basis: 'RELATIONSHIP' }] };
    }, ['lbType']),
  }),
  rule({
    ...common,
    id: 'AWS-ELB-004', service: 'Elastic Load Balancing', scope: 'resource', resourceTypes: ['aws_alb'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Load balancer deletion protection is disabled',
    description: 'The load balancer can be deleted without first disabling protection.',
    rationale: 'Security Hub ELB.6 (medium). Rated LOW: an accidental deletion is recoverable by re-applying Terraform, with an outage.',
    risk: 'Accidental deletion.', impact: 'Outage for all traffic through the load balancer.',
    wellArchitected: WA.rel('REL 11 — Design your workload to withstand component failures'),
    references: ['AWS-FSBP-ELB.6', 'AWS-WA-reliability', TF],
    soc1: ['SOC1-CM-01'],
    remediation: { recommendation: 'Enable deletion protection for production load balancers.', manualSteps: ['Enable deletion protection.'], terraform: 'aws_lb.enable_deletion_protection = true' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Metadata-only change.', description: 'Enable deletion protection.', patch: () => ({ deletionProtection: true }),
      architectureImpact: 'Delete operations are refused until protection is removed.', costImpact: 'NONE',
      terraformExpect: /enable_deletion_protection\s*=\s*true/,
    },
    evaluate: configEvaluator(['deletionProtection'], { deletionProtection: 'Enabled / Yes' }, (c) => c.deletionProtection === true
      ? { status: 'PASS', observation: 'Deletion protection is enabled.' }
      : { status: 'FAIL', observation: 'Deletion protection is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-CF-001', service: 'Amazon CloudFront', scope: 'resource', resourceTypes: ['aws_cloudfront'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'CloudFront allows unencrypted HTTP to viewers',
    description: 'The viewer protocol policy is "allow-all".',
    rationale: 'Security Hub CloudFront.3 (medium).',
    risk: 'Viewer traffic can be intercepted or modified.', impact: 'Session hijacking, content injection.',
    wellArchitected: WA.sec('SEC 9 — Protect data in transit'),
    references: ['AWS-FSBP-CloudFront.3', 'AWS-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Use "redirect-to-https" (or "https-only").', manualSteps: ['Set the viewer protocol policy to redirect-to-https.'], terraform: 'default_cache_behavior.viewer_protocol_policy = "redirect-to-https"' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'HTTP requests are redirected rather than rejected, so existing links keep working.',
      description: 'Redirect HTTP to HTTPS.', patch: () => ({ viewerProtocolPolicy: 'redirect-to-https' }),
      architectureImpact: 'HTTP viewers are redirected to HTTPS.', costImpact: 'NONE',
      terraformExpect: /viewer_protocol_policy\s*=\s*"redirect-to-https"/,
    },
    evaluate: configEvaluator(['viewerProtocolPolicy'], { viewerProtocolPolicy: 'redirect-to-https or https-only' }, (c) => c.viewerProtocolPolicy === 'allow-all'
      ? { status: 'FAIL', observation: 'Viewer protocol policy allows HTTP.' }
      : { status: 'PASS', observation: `Viewer protocol policy is ${fmt(c.viewerProtocolPolicy)}.` }),
  }),
  rule({
    ...common,
    id: 'AWS-CF-002', service: 'Amazon CloudFront', scope: 'resource', resourceTypes: ['aws_cloudfront'],
    domain: 'SECURITY', category: 'Edge protection', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'CloudFront distribution has no AWS WAF web ACL',
    description: 'Neither a web ACL ID nor a connected AWS WAF (CLOUDFRONT scope) resource is present.',
    rationale: 'Security Hub CloudFront.6 (medium).',
    risk: 'Web exploits and abusive traffic reach the origin unfiltered.', impact: 'Application compromise or abuse.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-FSBP-CloudFront.6', 'AWS-WA-security'],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Associate a global (CLOUDFRONT scope) AWS WAF web ACL.', manualSteps: ['Create a CLOUDFRONT-scope web ACL in us-east-1.', 'Associate it with the distribution.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Adds a new billable resource whose rules must be tuned.', description: 'Manual: add WAF.', patch: () => ({}), architectureImpact: 'Adds AWS WAF.', costImpact: 'POSSIBLE_INCREASE' },
    evaluate: configEvaluator([], {}, (c, r, ctx) => {
      const waf = ctx.neighbors(r.id).find((n) => n.resourceType === 'aws_waf');
      if (c.webAclId) return { status: 'PASS', observation: 'A web ACL ID is configured.', extraEvidence: [ev(r, 'webAclId')] };
      if (waf) return { status: 'PASS', observation: `Connected to AWS WAF web ACL "${waf.label}".`, extraEvidence: [{ label: 'Diagram relationship', observed: `Connected to ${waf.label}`, basis: 'RELATIONSHIP' }] };
      return { status: 'FAIL', observation: 'No web ACL is configured or connected.', extraEvidence: [ev(r, 'webAclId', 'Web ACL ARN'), { label: 'Diagram relationship', observed: 'No connection to an AWS WAF web ACL', basis: 'RELATIONSHIP' }] };
    }),
  }),
  rule({
    ...common,
    id: 'AWS-WAF-001', service: 'AWS WAF', scope: 'resource', resourceTypes: ['aws_waf'],
    domain: 'SECURITY', category: 'Edge protection', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'AWS WAF web ACL has no rules',
    description: 'The web ACL has no managed rule groups and no rate-based rule.',
    rationale: 'Security Hub WAF.10 (medium). A default action of ALLOW is normal when block rules exist, so it is not flagged on its own.',
    risk: 'The web ACL inspects nothing and allows all traffic.', impact: 'False sense of protection.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-FSBP-WAF.10', 'AWS-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Add AWS managed rule groups (e.g. Core rule set, Known bad inputs) and a rate-based rule.', manualSteps: ['Add managed rule groups in count mode.', 'Review sampled requests, then switch to block.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Managed rules can block legitimate requests; they should be tuned in count mode first.',
      description: 'Add the AWS Core rule set managed rule group.', patch: () => ({ managedRuleGroups: ['AWSManagedRulesCommonRuleSet'] }),
      architectureImpact: 'Requests matching the core rule set are blocked.', costImpact: 'POSSIBLE_INCREASE',
      terraformExpect: /AWSManagedRulesCommonRuleSet/,
    },
    evaluate: configEvaluator(['managedRuleGroups'], {}, (c) => {
      const groups = Array.isArray(c.managedRuleGroups) ? c.managedRuleGroups : [];
      if (groups.length > 0) return { status: 'PASS', observation: `Managed rule groups: ${groups.join(', ')}.` };
      if (c.rateLimitEnabled === true) return { status: 'PASS', observation: 'A rate-based rule is configured.' };
      return { status: 'FAIL', observation: 'No managed rule groups or rate-based rule are configured.' };
    }, ['rateLimitEnabled']),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Containers, serverless, identity, keys, caches, queues, NoSQL
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AWS-EKS-001', service: 'Amazon EKS', scope: 'resource', resourceTypes: ['aws_eks'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'EKS API endpoint is publicly accessible',
    description: 'The Kubernetes API server endpoint accepts connections from the internet.',
    rationale: 'Security Hub EKS.1 (high). HIGH when open to 0.0.0.0/0; LOW when public access is restricted to specific CIDRs.',
    risk: 'The cluster control plane is exposed to internet scanning and credential attacks.', impact: 'Cluster compromise.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-FSBP-EKS.1', 'AWS-WA-security', TF],
    soc1: ['SOC1-LA-01', 'SOC1-LA-02'],
    remediation: { recommendation: 'Enable private endpoint access and disable public access, or restrict public access CIDRs to administrator networks.', manualSteps: ['Enable private endpoint access.', 'Restrict or disable public endpoint access.'], terraform: 'aws_eks_cluster.vpc_config { endpoint_private_access = true, public_access_cidrs = [...] }' },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'CloudCraft cannot know administrator CIDRs, and disabling public access requires private connectivity for kubectl/CI.', description: 'Manual: restrict endpoint access.', patch: () => ({}), architectureImpact: 'Changes how kubectl and CI reach the cluster.', costImpact: 'NONE' },
    evaluate: configEvaluator(['endpointPublicAccess'], { endpointPublicAccess: 'Disabled / No' }, (c, r) => {
      if (c.endpointPublicAccess !== true) return { status: 'PASS', observation: 'Public endpoint access is disabled.' };
      const cidrs = String(c.publicAccessCidrs ?? '0.0.0.0/0');
      const open = cidrs.split(',').map((s) => s.trim()).some((s) => PUBLIC_CIDRS.has(s));
      return open
        ? { status: 'FAIL', observation: `The API endpoint is public and open to ${cidrs}.`, extraEvidence: [ev(r, 'publicAccessCidrs', 'Administrator CIDRs only')] }
        : { status: 'FAIL', severity: 'LOW', observation: `The API endpoint is public but restricted to ${cidrs}.`, extraEvidence: [ev(r, 'publicAccessCidrs')] };
    }),
  }),
  rule({
    ...common,
    id: 'AWS-EKS-002', service: 'Amazon EKS', scope: 'resource', resourceTypes: ['aws_eks'],
    domain: 'SECURITY', category: 'Encryption at rest', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'EKS Kubernetes secrets are not envelope-encrypted with KMS',
    description: 'Secrets encryption with a KMS key is disabled.',
    rationale: 'Security Hub EKS.3 (medium).',
    risk: 'Kubernetes Secrets rely only on default etcd storage encryption without customer-controlled keys.', impact: 'Weaker protection and auditability of secrets.',
    wellArchitected: WA.sec('SEC 8 — Protect data at rest'),
    references: ['AWS-FSBP-EKS.3', 'AWS-WA-security', TF],
    soc1: ['SOC1-DP-01'],
    remediation: { recommendation: 'Enable envelope encryption of Kubernetes secrets with a KMS key.', manualSteps: ['Enable secrets encryption with a customer managed KMS key.'], terraform: 'aws_eks_cluster.encryption_config { resources = ["secrets"] }' },
    autoFix: {
      safety: (r) => (deployed(r) ? 'REVIEW_REQUIRED' : 'SAFE_AUTOFIX'),
      safetyReason: (r) => deployed(r) ? 'Enabling encryption on an existing cluster is irreversible and re-encrypts all secrets.' : 'Not yet deployed: configured at cluster creation.',
      description: 'Enable KMS envelope encryption for secrets.', patch: () => ({ secretsEncryption: true }),
      architectureImpact: 'Adds a KMS key used for secrets envelope encryption.', costImpact: 'POSSIBLE_INCREASE',
      terraformExpect: /encryption_config/,
    },
    evaluate: configEvaluator(['secretsEncryption'], { secretsEncryption: 'Enabled / Yes' }, (c) => c.secretsEncryption === false
      ? { status: 'FAIL', observation: 'Secrets envelope encryption is disabled.' }
      : { status: 'PASS', observation: 'Secrets envelope encryption is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-EKS-003', service: 'Amazon EKS', scope: 'resource', resourceTypes: ['aws_eks'],
    domain: 'SECURITY', category: 'Logging & audit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'EKS control plane audit logging is disabled',
    description: 'The "audit" log type is not enabled for the cluster control plane.',
    rationale: 'Security Hub EKS.8 (medium).',
    risk: 'Kubernetes API activity (who changed what) is not recorded.', impact: 'No audit trail for cluster changes.',
    wellArchitected: WA.sec('SEC 4 — Detect and investigate security events'),
    references: ['AWS-FSBP-EKS.8', 'AWS-WA-security', TF],
    soc1: ['SOC1-OP-01', 'SOC1-CM-01'],
    remediation: { recommendation: 'Enable the audit control plane log type (and api/authenticator as needed).', manualSteps: ['Add "audit" to the enabled cluster log types.'], terraform: 'aws_eks_cluster.enabled_cluster_log_types includes "audit"' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Adds log delivery only; no effect on workloads.',
      description: 'Add "audit" to the control plane log types.',
      patch: (c) => ({ clusterLogTypes: Array.from(new Set([...(Array.isArray(c.clusterLogTypes) ? c.clusterLogTypes as string[] : []), 'audit'])) }),
      architectureImpact: 'Audit logs are delivered to CloudWatch Logs.', costImpact: 'POSSIBLE_INCREASE',
      terraformExpect: /enabled_cluster_log_types\s*=\s*\[[^\]]*"audit"/,
    },
    evaluate: configEvaluator(['clusterLogTypes'], { clusterLogTypes: 'includes audit' }, (c) => Array.isArray(c.clusterLogTypes) && (c.clusterLogTypes as unknown[]).includes('audit')
      ? { status: 'PASS', observation: 'Audit logging is enabled.' }
      : { status: 'FAIL', observation: `Audit logging is not enabled (log types: ${fmt(c.clusterLogTypes)}).` }),
  }),
  rule({
    ...common,
    id: 'AWS-ECS-001', service: 'Amazon ECS', scope: 'resource', resourceTypes: ['aws_ecs'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'ECS service automatically assigns public IP addresses',
    description: 'Tasks receive public IP addresses (AssignPublicIp = ENABLED).',
    rationale: 'Security Hub ECS.2 (high).',
    risk: 'Tasks are directly internet-addressable.', impact: 'Exposure of container ports.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-FSBP-ECS.2', 'AWS-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Run tasks in private subnets; use a NAT gateway or VPC endpoints for image pulls and a load balancer for inbound traffic.', manualSteps: ['Disable public IP assignment.', 'Provide NAT or VPC endpoints for ECR/CloudWatch.'], terraform: 'aws_ecs_service.network_configuration.assign_public_ip = false' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Tasks in public subnets without NAT/VPC endpoints will fail to pull images.',
      description: 'Disable public IP assignment.', patch: () => ({ assignPublicIp: false }),
      architectureImpact: 'Tasks need NAT or VPC endpoints for outbound access.', costImpact: 'NONE',
      terraformExpect: /assign_public_ip\s*=\s*false/,
    },
    evaluate: configEvaluator(['assignPublicIp'], { assignPublicIp: 'Disabled / No' }, (c) => c.assignPublicIp === true
      ? { status: 'FAIL', observation: 'Tasks are assigned public IP addresses.' }
      : { status: 'PASS', observation: 'Tasks are not assigned public IP addresses.' }),
  }),
  rule({
    ...common,
    id: 'AWS-IAM-001', service: 'AWS IAM', scope: 'resource', resourceTypes: ['aws_iam'],
    domain: 'SECURITY', category: 'Identity & access', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'IAM role has full administrative privileges',
    description: 'The AWS managed AdministratorAccess policy (Action "*" on Resource "*") is attached to the role.',
    rationale: 'Related to Security Hub IAM.1 (high), which targets customer managed policies granting "*:*"; the same privilege level attached to a workload role violates least privilege.',
    risk: 'Any compromise of the workload grants full control of the AWS account.', impact: 'Account takeover, data destruction.',
    wellArchitected: WA.sec('SEC 3 — Manage permissions'),
    references: ['AWS-FSBP-IAM.1', 'AWS-WA-security'],
    soc1: ['SOC1-LA-02'],
    remediation: { recommendation: 'Replace AdministratorAccess with a least-privilege policy scoped to the actions and resources the workload uses.', manualSteps: ['Use IAM Access Analyzer policy generation from CloudTrail activity.', 'Attach the generated least-privilege policy.', 'Detach AdministratorAccess.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'The required permissions depend on the workload; removing admin access blindly would break it.', description: 'Manual: design least-privilege policy.', patch: () => ({}), architectureImpact: 'Workload permissions change.', costImpact: 'NONE' },
    evaluate: configEvaluator(['managedPolicyArns'], {}, (c) => {
      const arns = Array.isArray(c.managedPolicyArns) ? c.managedPolicyArns.map(String) : [];
      const admin = arns.filter((a) => /:policy\/AdministratorAccess$/.test(a) || a === 'AdministratorAccess');
      return admin.length > 0 ? { status: 'FAIL', observation: `AdministratorAccess is attached (${admin.join(', ')}).` }
        : { status: 'PASS', observation: arns.length ? `Attached policies: ${arns.join(', ')}.` : 'No managed policies are attached.' };
    }),
  }),
  rule({
    ...common,
    id: 'AWS-KMS-001', service: 'AWS KMS', scope: 'resource', resourceTypes: ['aws_kms'],
    domain: 'SECURITY', category: 'Key management', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'KMS key automatic rotation is disabled',
    description: 'Automatic key material rotation is off for a symmetric encryption key.',
    rationale: 'Security Hub KMS.4 (medium). Not applicable to asymmetric or signing keys, which do not support automatic rotation.',
    risk: 'Key material is used indefinitely.', impact: 'Larger blast radius if key material is compromised.',
    wellArchitected: WA.sec('SEC 8 — Protect data at rest (key management)'),
    references: ['AWS-FSBP-KMS.4', 'AWS-WA-security', TF],
    soc1: ['SOC1-DP-01'],
    remediation: { recommendation: 'Enable automatic key rotation.', manualSteps: ['Enable key rotation.'], terraform: 'aws_kms_key.enable_key_rotation = true' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Rotation is transparent: previous key material remains available for decryption.',
      description: 'Enable automatic key rotation.', patch: () => ({ enableKeyRotation: true }),
      architectureImpact: 'None — rotation is transparent to callers.', costImpact: 'POSSIBLE_INCREASE',
      terraformExpect: /enable_key_rotation\s*=\s*true/,
    },
    evaluate: configEvaluator(['enableKeyRotation'], { enableKeyRotation: 'Enabled / Yes' }, (c) => {
      if (c.keyUsage === 'SIGN_VERIFY' || (c.keySpec && c.keySpec !== 'SYMMETRIC_DEFAULT')) {
        return { status: 'NOT_APPLICABLE', observation: `Automatic rotation is not supported for ${fmt(c.keySpec)} / ${fmt(c.keyUsage)} keys.` };
      }
      return c.enableKeyRotation === true ? { status: 'PASS', observation: 'Automatic rotation is enabled.' } : { status: 'FAIL', observation: 'Automatic rotation is disabled.' };
    }, ['keyUsage', 'keySpec']),
  }),
  rule({
    ...common,
    id: 'AWS-ELC-001', service: 'Amazon ElastiCache', scope: 'resource', resourceTypes: ['aws_elasticache'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'ElastiCache in-transit encryption is disabled',
    description: 'Clients connect to the cache without TLS.',
    rationale: 'Security Hub ElastiCache.5 (medium).',
    risk: 'Cached data and AUTH tokens transit the VPC in plaintext.', impact: 'Interception of cached data.',
    wellArchitected: WA.sec('SEC 9 — Protect data in transit'),
    references: ['AWS-FSBP-ElastiCache.5', 'AWS-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Enable in-transit encryption and update clients to use TLS.', manualSteps: ['Enable transit encryption.', 'Update client libraries to connect with TLS.'], terraform: 'aws_elasticache_replication_group.transit_encryption_enabled = true' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Clients not configured for TLS will fail to connect.',
      description: 'Enable in-transit encryption.', patch: () => ({ transitEncryption: true }),
      architectureImpact: 'Clients must use TLS.', costImpact: 'NONE',
      terraformExpect: /transit_encryption_enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['transitEncryption'], { transitEncryption: 'Enabled / Yes' }, (c) => c.transitEncryption === false
      ? { status: 'FAIL', observation: 'In-transit encryption is disabled.' }
      : { status: 'PASS', observation: 'In-transit encryption is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-ELC-002', service: 'Amazon ElastiCache', scope: 'resource', resourceTypes: ['aws_elasticache'],
    domain: 'SECURITY', category: 'Encryption at rest', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'ElastiCache at-rest encryption is disabled',
    description: 'Cache data, backups and swap are not encrypted at rest.',
    rationale: 'Security Hub ElastiCache.4 (medium).',
    risk: 'Snapshots and on-disk data are not protected by KMS.', impact: 'Data exposure through backups.',
    wellArchitected: WA.sec('SEC 8 — Protect data at rest'),
    references: ['AWS-FSBP-ElastiCache.4', 'AWS-WA-security', TF],
    soc1: ['SOC1-DP-01'],
    remediation: { recommendation: 'Enable at-rest encryption (set at creation).', manualSteps: ['Create the replication group with at-rest encryption; migrate existing clusters via backup/restore.'], terraform: 'aws_elasticache_replication_group.at_rest_encryption_enabled = true' },
    autoFix: {
      safety: (r) => (deployed(r) ? 'REVIEW_REQUIRED' : 'SAFE_AUTOFIX'),
      safetyReason: (r) => deployed(r) ? 'At-rest encryption on an existing replication group forces replacement.' : 'Not yet deployed: set at creation.',
      description: 'Enable at-rest encryption.', patch: () => ({ atRestEncryption: true }), architectureImpact: 'Planned: none. Deployed: replacement.', costImpact: 'NONE',
      terraformExpect: /at_rest_encryption_enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['atRestEncryption'], { atRestEncryption: 'Enabled / Yes' }, (c) => c.atRestEncryption === false
      ? { status: 'FAIL', observation: 'At-rest encryption is disabled.' }
      : { status: 'PASS', observation: 'At-rest encryption is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-ELC-003', service: 'Amazon ElastiCache', scope: 'resource', resourceTypes: ['aws_elasticache'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'ElastiCache has no automatic failover',
    description: 'The cache has no replica with automatic failover.',
    rationale: 'Security Hub ElastiCache.3 (medium). A single-node cache is reported LOW because failover requires at least one replica.',
    risk: 'Primary node failure makes the cache unavailable.', impact: 'Increased database load and latency; possible outage.',
    wellArchitected: WA.rel('REL 11 — Withstand component failures'),
    references: ['AWS-FSBP-ElastiCache.3', 'AWS-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Use at least one replica with automatic failover and Multi-AZ.', manualSteps: ['Add a replica node.', 'Enable automatic failover and Multi-AZ.'], terraform: 'aws_elasticache_replication_group.automatic_failover_enabled = true' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'A single-node cache also needs a replica (additional cost) for failover to work.',
      description: 'Enable automatic failover (adds a replica when the cache has one node).',
      patch: (c) => ({ automaticFailoverEnabled: true, numNodes: Math.max(2, Number(c.numNodes) || 1) }),
      architectureImpact: 'A replica takes over automatically if the primary fails.', costImpact: 'POSSIBLE_INCREASE',
      terraformExpect: /automatic_failover_enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['numNodes', 'automaticFailoverEnabled'], {}, (c) => {
      const n = Number(c.numNodes);
      if (n <= 1) return { status: 'FAIL', severity: 'LOW', observation: 'The cache has a single node, so automatic failover is not possible.' };
      return c.automaticFailoverEnabled === false ? { status: 'FAIL', observation: `${n} nodes without automatic failover.` } : { status: 'PASS', observation: `${n} nodes with automatic failover.` };
    }),
  }),
  rule({
    ...common,
    id: 'AWS-ELC-004', service: 'Amazon ElastiCache', scope: 'resource', resourceTypes: ['aws_elasticache'],
    domain: 'RELIABILITY', category: 'Data protection', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'ElastiCache automatic backups are disabled',
    description: 'Snapshot retention is 0 days.',
    rationale: 'Security Hub ElastiCache.1 (high). Rated MEDIUM because cache contents are often reconstructable from the system of record.',
    risk: 'Cache state cannot be restored.', impact: 'Longer recovery and cold-cache load spikes.',
    wellArchitected: WA.rel('REL 9 — Back up data'),
    references: ['AWS-FSBP-ElastiCache.1', 'AWS-WA-reliability', TF],
    soc1: ['SOC1-OP-03'],
    remediation: { recommendation: 'Retain automatic snapshots for at least 1 day.', manualSteps: ['Set snapshot retention to 1 or more days.'], terraform: 'snapshot_retention_limit >= 1' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Additive backup configuration.', description: 'Retain snapshots for 1 day.', patch: () => ({ snapshotRetentionLimit: 1 }),
      architectureImpact: 'Daily snapshot retained.', costImpact: 'POSSIBLE_INCREASE', terraformExpect: /snapshot_retention_limit\s*=\s*1\b/,
    },
    evaluate: configEvaluator(['snapshotRetentionLimit'], { snapshotRetentionLimit: '1 or more' }, (c) => Number(c.snapshotRetentionLimit) > 0
      ? { status: 'PASS', observation: `Snapshots retained for ${c.snapshotRetentionLimit} day(s).` }
      : { status: 'FAIL', observation: 'Automatic backups are disabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-DDB-001', service: 'Amazon DynamoDB', scope: 'resource', resourceTypes: ['aws_dynamodb'],
    domain: 'SECURITY', category: 'Encryption at rest', severity: 'INFORMATIONAL', priority: 'OPTIONAL_OPTIMIZATION',
    title: 'DynamoDB encryption at rest',
    description: 'DynamoDB encrypts all tables at rest; the configuration selects the key type.',
    rationale: 'DynamoDB encryption at rest cannot be disabled. "Server-side encryption = off" in CloudCraft means the AWS owned key is used; "on" means an AWS managed KMS key. The previous rule that reported "encryption disabled" was incorrect and has been replaced by this evidence check.',
    risk: 'None for confidentiality; AWS owned keys provide no key-level audit trail in the customer account.', impact: 'Informational.',
    wellArchitected: WA.sec('SEC 8 — Protect data at rest'),
    references: ['AWS-WA-security', TF],
    soc1: ['SOC1-DP-01'],
    remediation: { recommendation: 'Use a customer managed KMS key when you need key-level access control and CloudTrail evidence of key use.', manualSteps: ['Enable server-side encryption with a KMS key.'] },
    evaluate: (r) => ({
      status: 'PASS',
      observation: r.config.serverSideEncryption === true ? 'Encrypted at rest with an AWS managed KMS key.' : 'Encrypted at rest with the AWS owned key (DynamoDB default).',
      evidence: [ev(r, 'serverSideEncryption')],
    }),
  }),
  rule({
    ...common,
    id: 'AWS-DDB-002', service: 'Amazon DynamoDB', scope: 'resource', resourceTypes: ['aws_dynamodb'],
    domain: 'RELIABILITY', category: 'Data protection', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'DynamoDB point-in-time recovery is disabled',
    description: 'Continuous backups are not enabled for the table.',
    rationale: 'Security Hub DynamoDB.2 (medium).',
    risk: 'Accidental writes/deletes cannot be rolled back.', impact: 'Data loss.',
    wellArchitected: WA.rel('REL 9 — Back up data'),
    references: ['AWS-FSBP-DynamoDB.2', 'AWS-WA-reliability', TF],
    soc1: ['SOC1-OP-03'],
    remediation: { recommendation: 'Enable point-in-time recovery.', manualSteps: ['Enable PITR.'], terraform: 'aws_dynamodb_table.point_in_time_recovery { enabled = true }' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Additive; no impact on table performance.', description: 'Enable PITR.', patch: () => ({ pointInTimeRecovery: true }),
      architectureImpact: 'Continuous backups for 35 days.', costImpact: 'POSSIBLE_INCREASE', terraformExpect: /enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['pointInTimeRecovery'], { pointInTimeRecovery: 'Enabled / Yes' }, (c) => c.pointInTimeRecovery === false
      ? { status: 'FAIL', observation: 'Point-in-time recovery is disabled.' }
      : { status: 'PASS', observation: 'Point-in-time recovery is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-DDB-003', service: 'Amazon DynamoDB', scope: 'resource', resourceTypes: ['aws_dynamodb'],
    domain: 'RELIABILITY', category: 'Data protection', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'DynamoDB deletion protection is disabled',
    description: 'The table can be deleted without first disabling deletion protection.',
    rationale: 'Security Hub DynamoDB.6 (medium). Rated LOW when point-in-time recovery is enabled, because deleting a PITR-enabled table leaves a restorable system backup; MEDIUM otherwise.',
    risk: 'Accidental table deletion.', impact: 'Outage and data loss.',
    wellArchitected: WA.rel('REL 9 — Back up data'),
    references: ['AWS-FSBP-DynamoDB.6', 'AWS-WA-reliability', TF],
    soc1: ['SOC1-CM-01'],
    remediation: { recommendation: 'Enable deletion protection.', manualSteps: ['Enable deletion protection.'], terraform: 'aws_dynamodb_table.deletion_protection_enabled = true' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Metadata-only change.', description: 'Enable deletion protection.', patch: () => ({ deletionProtection: true }),
      architectureImpact: 'Delete operations are refused until protection is removed.', costImpact: 'NONE', terraformExpect: /deletion_protection_enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['deletionProtection'], { deletionProtection: 'Enabled / Yes' }, (c) => c.deletionProtection === true
      ? { status: 'PASS', observation: 'Deletion protection is enabled.' }
      : { status: 'FAIL', severity: c.pointInTimeRecovery === false ? 'MEDIUM' : 'LOW', observation: 'Deletion protection is disabled.' }, ['pointInTimeRecovery']),
  }),
  rule({
    ...common,
    id: 'AWS-SQS-001', service: 'Amazon SQS', scope: 'resource', resourceTypes: ['aws_sqs'],
    domain: 'SECURITY', category: 'Encryption at rest', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'SQS queue server-side encryption is disabled',
    description: 'The queue is explicitly configured without SSE (the generated Terraform sets sqs_managed_sse_enabled = false).',
    rationale: 'Security Hub SQS.1 (medium).',
    risk: 'Messages are stored unencrypted.', impact: 'Exposure of message payloads.',
    wellArchitected: WA.sec('SEC 8 — Protect data at rest'),
    references: ['AWS-FSBP-SQS.1', 'AWS-WA-security', TF],
    soc1: ['SOC1-DP-01'],
    remediation: { recommendation: 'Enable SSE-SQS or SSE-KMS.', manualSteps: ['Enable server-side encryption.'], terraform: 'aws_sqs_queue.sqs_managed_sse_enabled = true (or kms_master_key_id)' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'SSE-SQS is transparent to producers and consumers.', description: 'Enable SSE-SQS.', patch: () => ({ encryption: true }),
      architectureImpact: 'None.', costImpact: 'NONE', terraformExpect: /sqs_managed_sse_enabled\s*=\s*true|kms_master_key_id/,
    },
    evaluate: configEvaluator(['encryption'], { encryption: 'Enabled / Yes' }, (c) => c.encryption === false
      ? { status: 'FAIL', observation: 'Server-side encryption is disabled.' }
      : { status: 'PASS', observation: c.kmsMasterKeyId ? 'Encrypted with a KMS key.' : 'Encrypted with SSE-SQS.' }, ['kmsMasterKeyId']),
  }),
  rule({
    ...common,
    id: 'AWS-SQS-002', service: 'Amazon SQS', scope: 'resource', resourceTypes: ['aws_sqs'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'SQS queue has no dead-letter queue',
    description: 'No redrive policy sends repeatedly failing messages to a dead-letter queue.',
    rationale: 'Reliability pillar guidance on handling poison messages.',
    risk: 'Poison messages are retried until retention expires and then lost.', impact: 'Silent message loss and consumer churn.',
    wellArchitected: WA.rel('REL 5 — Design interactions to mitigate or withstand failures'),
    references: ['AWS-WA-reliability'],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Create a dead-letter queue and set a redrive policy with a sensible max receive count; alarm on DLQ depth.', manualSteps: ['Create a DLQ.', 'Set the redrive policy.', 'Add a CloudWatch alarm on DLQ messages.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Requires creating a separate queue and choosing a max receive count.', description: 'Manual: add DLQ.', patch: () => ({}), architectureImpact: 'Adds a queue.', costImpact: 'POSSIBLE_INCREASE' },
    evaluate: configEvaluator([], {}, (c, r) => c.deadLetterTargetArn
      ? { status: 'PASS', observation: 'A dead-letter queue is configured.', extraEvidence: [ev(r, 'deadLetterTargetArn')] }
      : { status: 'FAIL', observation: 'No dead-letter queue is configured.', extraEvidence: [ev(r, 'deadLetterTargetArn', 'DLQ ARN')] }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Architecture-level (topology) — Reliability / Operations / Performance
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AWS-ARCH-001', service: 'Amazon EC2', scope: 'architecture',
    domain: 'RELIABILITY', category: 'Resilience', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'EC2 compute has no load balancer or Auto Scaling group',
    description: 'EC2 instances are present without an Application/Network Load Balancer or Auto Scaling group in the architecture.',
    rationale: 'Reliability pillar: distribute load across redundant instances and replace unhealthy ones automatically.',
    risk: 'Each instance is a single point of failure.', impact: 'Outage when an instance or AZ fails.',
    wellArchitected: WA.rel('REL 10/11 — Fault isolation and withstanding component failures'),
    references: ['AWS-WA-reliability'],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Run the tier in an Auto Scaling group across at least two AZs behind a load balancer.', manualSteps: ['Create a launch template from the instance configuration.', 'Create an Auto Scaling group spanning two or more AZs.', 'Place an ALB in front.'] },
    evaluateArchitecture: (ctx) => {
      const ec2s = ctx.ofType('aws_ec2');
      if (ec2s.length === 0) return [{ status: 'NOT_APPLICABLE', observation: 'No EC2 instances.', evidence: [] }];
      const lbs = ctx.ofType('aws_alb'); const asgs = ctx.ofType('aws_auto_scaling');
      const evidence = [
        { label: 'EC2 instances', observed: String(ec2s.length), basis: 'TOPOLOGY' as const },
        { label: 'Load balancers', observed: String(lbs.length), basis: 'TOPOLOGY' as const },
        { label: 'Auto Scaling groups', observed: String(asgs.length), basis: 'TOPOLOGY' as const },
      ];
      if (lbs.length > 0 || asgs.length > 0) return [{ status: 'PASS', observation: 'Compute is fronted by a load balancer and/or Auto Scaling group.', evidence, resourceIds: ec2s.map((e) => e.id) }];
      return [{ status: 'FAIL', observation: `${ec2s.length} EC2 instance(s) with no load balancer or Auto Scaling group.`, evidence, resourceIds: ec2s.map((e) => e.id), severity: ec2s.length === 1 ? 'MEDIUM' : 'LOW' }];
    },
  }),
  rule({
    ...common,
    id: 'AWS-ARCH-002', service: 'Amazon VPC', scope: 'architecture',
    domain: 'RELIABILITY', category: 'Resilience', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'All subnets are in a single Availability Zone',
    description: 'Every subnet in the architecture is placed in the same Availability Zone.',
    rationale: 'Reliability pillar fault isolation: deploy across multiple AZs. Evaluated from the subnets\' Availability Zone settings.',
    risk: 'An AZ impairment takes down the whole workload.', impact: 'Full outage during AZ events.',
    wellArchitected: WA.rel('REL 10 — Use fault isolation to protect your workload'),
    references: ['AWS-WA-reliability'],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Create subnets for each tier in at least two Availability Zones.', manualSteps: ['Add a second subnet per tier in another AZ.', 'Spread instances/ASGs and DB subnet groups across them.'] },
    evaluateArchitecture: (ctx) => {
      const subnets = ctx.ofType('aws_subnet');
      if (subnets.length === 0) return [{ status: 'NOT_APPLICABLE', observation: 'No subnets are modelled.', evidence: [] }];
      const missing = subnets.filter((s) => !s.config.availabilityZone);
      if (missing.length > 0) return [{ status: 'INSUFFICIENT_DATA', observation: `${missing.length} subnet(s) have no Availability Zone.`, evidence: [], requiredData: 'Set the Availability Zone on every subnet.', resourceIds: missing.map((s) => s.id) }];
      const azs = Array.from(new Set(subnets.map((s) => String(s.config.availabilityZone))));
      const evidence = [{ label: 'Availability Zones used', observed: azs.join(', '), expected: 'Two or more', basis: 'TOPOLOGY' as const }, { label: 'Subnets', observed: String(subnets.length), basis: 'TOPOLOGY' as const }];
      return azs.length >= 2
        ? [{ status: 'PASS', observation: `Subnets span ${azs.length} Availability Zones.`, evidence, resourceIds: subnets.map((s) => s.id) }]
        : [{ status: 'FAIL', observation: `All ${subnets.length} subnet(s) are in ${azs[0]}.`, evidence, resourceIds: subnets.map((s) => s.id) }];
    },
  }),
  rule({
    ...common,
    id: 'AWS-ASG-001', service: 'Amazon EC2 Auto Scaling', scope: 'resource', resourceTypes: ['aws_auto_scaling'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Auto Scaling group behind a load balancer uses EC2 health checks',
    description: 'The group is connected to a load balancer but replaces instances only on EC2 status checks.',
    rationale: 'Security Hub AutoScaling.1 (low). Evaluated from the diagram relationship to a load balancer.',
    risk: 'Instances failing application health checks keep receiving traffic.', impact: 'Partial outages that do not self-heal.',
    wellArchitected: WA.rel('REL 11 — Withstand component failures'),
    references: ['AWS-FSBP-AutoScaling.1', 'AWS-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Use ELB health checks with an appropriate grace period.', manualSteps: ['Set health check type to ELB.'], terraform: 'aws_autoscaling_group.health_check_type = "ELB"' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Instances failing the load balancer health check are replaced; the grace period prevents churn at boot.',
      description: 'Use ELB health checks.', patch: () => ({ healthCheckType: 'ELB' }),
      architectureImpact: 'Unhealthy instances (per load balancer) are replaced.', costImpact: 'NONE', terraformExpect: /health_check_type\s*=\s*"ELB"/,
    },
    evaluate: configEvaluator(['healthCheckType'], {}, (c, r, ctx) => {
      const lb = ctx.neighbors(r.id).find((n) => n.resourceType === 'aws_alb');
      if (!lb) return { status: 'NOT_APPLICABLE', observation: 'The group is not connected to a load balancer in the diagram.' };
      return c.healthCheckType === 'ELB'
        ? { status: 'PASS', observation: `Uses ELB health checks from "${lb.label}".` }
        : { status: 'FAIL', observation: `Connected to "${lb.label}" but uses ${fmt(c.healthCheckType)} health checks.`, extraEvidence: [{ label: 'Diagram relationship', observed: `Connected to ${lb.label}`, basis: 'RELATIONSHIP' }] };
    }),
  }),
  rule({
    ...common,
    id: 'AWS-EC2-010', service: 'Amazon EC2', scope: 'resource', resourceTypes: ['aws_ec2'],
    domain: 'OPERATIONAL_EXCELLENCE', category: 'Monitoring', severity: 'LOW', priority: 'OPTIONAL_OPTIMIZATION',
    title: 'EC2 detailed monitoring is disabled',
    description: 'Only 5-minute basic CloudWatch metrics are collected.',
    rationale: 'Operational Excellence observability guidance; 1-minute metrics shorten detection time for scaling and alarms.',
    risk: 'Slower detection of performance problems.', impact: 'Longer incidents.',
    wellArchitected: WA.ops('Implement observability'),
    references: ['AWS-WA-operational_excellence', TF],
    soc1: ['SOC1-OP-02'],
    remediation: { recommendation: 'Enable detailed monitoring for production instances.', manualSteps: ['Enable detailed monitoring.'], terraform: 'aws_instance.monitoring = true' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Metrics-only change.', description: 'Enable detailed monitoring.', patch: () => ({ detailedMonitoring: true }),
      architectureImpact: '1-minute CloudWatch metrics.', costImpact: 'POSSIBLE_INCREASE', terraformExpect: /monitoring\s*=\s*true/,
    },
    evaluate: configEvaluator(['detailedMonitoring'], { detailedMonitoring: 'Enabled / Yes' }, (c) => c.detailedMonitoring === true
      ? { status: 'PASS', observation: 'Detailed monitoring is enabled.' }
      : { status: 'FAIL', observation: 'Detailed monitoring is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AWS-ARCH-003', service: 'Amazon CloudWatch', scope: 'architecture',
    domain: 'OPERATIONAL_EXCELLENCE', category: 'Monitoring', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'No CloudWatch alarms are modelled',
    description: 'The AWS architecture has workload resources but no CloudWatch alarm resources.',
    rationale: 'Operational Excellence: define alarms on the metrics that indicate workload health.',
    risk: 'Failures may not be detected or escalated.', impact: 'Delayed incident response.',
    wellArchitected: WA.ops('Implement observability'),
    references: ['AWS-WA-operational_excellence'],
    soc1: ['SOC1-OP-02'],
    remediation: { recommendation: 'Add CloudWatch alarms for the key health metrics of each tier and route them to an on-call channel.', manualSteps: ['Add alarms (e.g. ALB 5xx, target health, RDS CPU/storage).', 'Route alarms to SNS/on-call.'] },
    evaluateArchitecture: (ctx) => {
      const workloads = ctx.resources.filter((r) => r.provider === 'aws' && ['aws_ec2', 'aws_rds', 'aws_alb', 'aws_ecs', 'aws_eks', 'aws_lambda', 'aws_dynamodb', 'aws_elasticache', 'aws_sqs', 'aws_auto_scaling'].includes(r.resourceType));
      if (workloads.length < 2) return [{ status: 'NOT_APPLICABLE', observation: 'Fewer than two AWS workload resources.', evidence: [] }];
      const alarms = ctx.ofType('aws_cloudwatch');
      const evidence = [{ label: 'Workload resources', observed: String(workloads.length), basis: 'TOPOLOGY' as const }, { label: 'CloudWatch alarms', observed: String(alarms.length), basis: 'TOPOLOGY' as const }];
      return alarms.length > 0
        ? [{ status: 'PASS', observation: `${alarms.length} CloudWatch alarm(s) modelled.`, evidence, resourceIds: alarms.map((a) => a.id) }]
        : [{ status: 'WARNING', observation: 'No CloudWatch alarms are modelled.', evidence, resourceIds: workloads.map((w) => w.id) }];
    },
  }),
  rule({
    ...common,
    id: 'AWS-LAMBDA-001', service: 'AWS Lambda', scope: 'resource', resourceTypes: ['aws_lambda'],
    domain: 'OPERATIONAL_EXCELLENCE', category: 'Monitoring', severity: 'LOW', priority: 'OPTIONAL_OPTIMIZATION',
    title: 'Lambda active tracing (X-Ray) is disabled',
    description: 'Tracing mode is PassThrough.',
    rationale: 'Operational Excellence observability guidance for distributed tracing.',
    risk: 'Latency and errors across services are hard to trace.', impact: 'Longer troubleshooting.',
    wellArchitected: WA.ops('Implement observability'),
    references: ['AWS-WA-operational_excellence', TF],
    soc1: ['SOC1-OP-02'],
    remediation: { recommendation: 'Enable active tracing where end-to-end latency matters.', manualSteps: ['Set tracing mode to Active.'], terraform: 'aws_lambda_function.tracing_config { mode = "Active" }' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Observability-only; adds X-Ray trace charges.', description: 'Enable active tracing.', patch: () => ({ tracingMode: 'Active' }),
      architectureImpact: 'Traces are sent to AWS X-Ray.', costImpact: 'POSSIBLE_INCREASE', terraformExpect: /mode\s*=\s*"Active"/,
    },
    evaluate: configEvaluator(['tracingMode'], { tracingMode: 'Active' }, (c) => c.tracingMode === 'Active'
      ? { status: 'PASS', observation: 'Active tracing is enabled.' }
      : { status: 'FAIL', observation: `Tracing mode is ${fmt(c.tracingMode)}.` }),
  }),
  rule({
    ...common,
    id: 'AWS-ARCH-004', service: 'Amazon ElastiCache', scope: 'architecture',
    domain: 'PERFORMANCE_EFFICIENCY', category: 'Performance', severity: 'INFORMATIONAL', priority: 'OPTIONAL_OPTIMIZATION',
    title: 'Database-backed compute has no caching layer',
    description: 'RDS and compute resources are present but no ElastiCache cluster is modelled.',
    rationale: 'Performance Efficiency: caching reduces repeated reads. Whether it helps depends on the read pattern, so this is informational.',
    risk: 'Read-heavy workloads place all load on the database.', impact: 'Higher latency and database cost at scale.',
    wellArchitected: WA.perf('Data management — use caching where appropriate'),
    references: ['AWS-WA-performance_efficiency'],
    soc1: [],
    remediation: { recommendation: 'If the workload is read-heavy, add ElastiCache (Redis/Valkey) for hot data and sessions.', manualSteps: ['Profile read patterns.', 'Add a cache for hot keys.'] },
    evaluateArchitecture: (ctx) => {
      const dbs = ctx.ofType('aws_rds');
      const compute = ctx.ofType('aws_ec2', 'aws_ecs', 'aws_lambda', 'aws_auto_scaling', 'aws_eks');
      if (dbs.length === 0 || compute.length === 0) return [{ status: 'NOT_APPLICABLE', observation: 'No RDS + compute combination.', evidence: [] }];
      const caches = ctx.ofType('aws_elasticache');
      const evidence = [{ label: 'RDS instances', observed: String(dbs.length), basis: 'TOPOLOGY' as const }, { label: 'Caches', observed: String(caches.length), basis: 'TOPOLOGY' as const }];
      return caches.length > 0
        ? [{ status: 'PASS', observation: 'A caching layer is modelled.', evidence, resourceIds: caches.map((c) => c.id) }]
        : [{ status: 'WARNING', observation: 'No caching layer is modelled in front of the database.', evidence, resourceIds: dbs.map((d) => d.id) }];
    },
  }),
  rule({
    ...common,
    id: 'AWS-COST-001', service: 'Amazon EBS', scope: 'resource', resourceTypes: ['aws_ebs', 'aws_ec2', 'aws_rds'],
    domain: 'COST_OPTIMIZATION', category: 'Cost', severity: 'LOW', priority: 'OPTIONAL_OPTIMIZATION',
    title: 'Previous-generation gp2 storage is used',
    description: 'The volume/storage type is gp2; gp3 provides a baseline of 3,000 IOPS and 125 MiB/s independent of size at a lower price per GB.',
    rationale: 'Cost Optimization: select the most cost-effective resource type.',
    risk: 'Paying more for equal or lower baseline performance.', impact: 'Avoidable storage cost.',
    wellArchitected: WA.cost('Select the correct resource type'),
    references: ['AWS-WA-cost_optimization', TF],
    soc1: [],
    remediation: { recommendation: 'Migrate gp2 volumes to gp3 (online modification).', manualSteps: ['Modify the volume type to gp3.', 'Set IOPS/throughput if the workload needs more than the baseline.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Online modification, but large gp2 volumes may rely on size-based burst IOPS above the gp3 baseline.',
      description: 'Change storage type to gp3.',
      patch: (c, r) => (r.resourceType === 'aws_ebs' ? { volumeType: 'gp3' } : { storageType: 'gp3' }),
      architectureImpact: 'Storage type changes to gp3 (online).', costImpact: 'POSSIBLE_DECREASE', terraformExpect: /"gp3"/,
    },
    evaluate: (r) => {
      const field = r.resourceType === 'aws_ebs' ? 'volumeType' : 'storageType';
      const v = r.config[field];
      const evidence = [ev(r, field, 'gp3')];
      if (v === undefined || v === null) return { status: 'INSUFFICIENT_DATA', observation: 'Storage type is not specified.', evidence, requiredData: 'Storage type.' };
      if (v === 'gp2') return { status: 'WARNING', observation: 'Storage type is gp2.', evidence };
      return { status: 'PASS', observation: `Storage type is ${fmt(v)}.`, evidence };
    },
  }),
  rule({
    ...common,
    id: 'AWS-SUS-001', service: 'AWS Lambda', scope: 'resource', resourceTypes: ['aws_lambda'],
    domain: 'SUSTAINABILITY', category: 'Sustainability', severity: 'INFORMATIONAL', priority: 'OPTIONAL_OPTIMIZATION',
    title: 'Lambda function runs on x86_64 instead of Graviton (arm64)',
    description: 'The function architecture is x86_64.',
    rationale: 'Sustainability and Cost pillars recommend energy-efficient instance types such as AWS Graviton where the code supports it.',
    risk: 'Higher energy use and cost per invocation.', impact: 'Optimization opportunity only.',
    wellArchitected: WA.sus('Hardware and services — use efficient hardware'),
    references: ['AWS-WA-sustainability', TF],
    soc1: [],
    remediation: { recommendation: 'Switch to arm64 after confirming native dependencies are available for arm64.', manualSteps: ['Test the function and its layers on arm64.', 'Change the architecture to arm64.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Native dependencies and layers must support arm64.', description: 'Switch to arm64.', patch: () => ({ architecture: 'arm64' }),
      architectureImpact: 'Function runs on Graviton.', costImpact: 'POSSIBLE_DECREASE', terraformExpect: /architectures\s*=\s*\["arm64"\]/,
    },
    evaluate: configEvaluator(['architecture'], { architecture: 'arm64' }, (c) => c.architecture === 'arm64'
      ? { status: 'PASS', observation: 'The function runs on arm64 (Graviton).' }
      : { status: 'WARNING', observation: `The function runs on ${fmt(c.architecture)}.` }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Account-level controls — never assumed; always NOT_EVALUATED at design time
  // ════════════════════════════════════════════════════════════════════════
  ...([
    ['AWS-ACCT-001', 'AWS CloudTrail', 'CloudTrail multi-Region trail', 'AWS-FSBP-CloudTrail.1', 'Logging & audit', 'HIGH', ['SOC1-OP-01', 'SOC1-CM-01'], 'Account API activity may not be recorded.', 'Enable an organization or multi-Region CloudTrail trail with log file validation, delivered to a protected S3 bucket.', 'SEC 4 — Detect and investigate security events'],
    ['AWS-ACCT-002', 'Amazon GuardDuty', 'GuardDuty threat detection', 'AWS-FSBP-GuardDuty.1', 'Threat detection', 'HIGH', ['SOC1-OP-02'], 'Malicious activity may go undetected.', 'Enable GuardDuty in all Regions used by the workload (delegated administrator in AWS Organizations).', 'SEC 4 — Detect and investigate security events'],
    ['AWS-ACCT-003', 'AWS IAM', 'Root user MFA', 'AWS-FSBP-IAM.9', 'Identity & access', 'CRITICAL', ['SOC1-LA-03'], 'Root credentials without MFA give full account control to anyone with the password.', 'Enable (hardware) MFA on the root user and avoid root usage.', 'SEC 2 — Manage authentication'],
    ['AWS-ACCT-004', 'AWS Config', 'AWS Config recording', 'AWS-FSBP-Config.1', 'Logging & audit', 'MEDIUM', ['SOC1-CM-02'], 'Configuration changes are not recorded for audit and drift detection.', 'Enable AWS Config recording for all resources in each Region used.', 'SEC 4 — Detect and investigate security events'],
  ] as const).map(([id, service, what, ref, category, severity, soc1, risk, rec, practice]) => rule({
    ...common,
    id, service, scope: 'account', domain: 'SECURITY', category, severity, priority: 'REQUIRED_REMEDIATION',
    title: `${what} — account-level control`,
    description: `${what} is an AWS account/Region setting that is not part of an architecture diagram.`,
    rationale: 'Reported NOT EVALUATED at design time. CloudCraft never assumes account-level controls are enabled.',
    risk, impact: 'Reduced detection, audit or account protection.',
    wellArchitected: WA.sec(practice),
    references: [ref, 'AWS-WA-security'],
    soc1: [...soc1],
    remediation: { recommendation: rec, manualSteps: [rec] },
    evaluateArchitecture: (ctx) => ctx.providers.includes('aws')
      ? [notModelled(what, 'Evidence from the AWS account (e.g. Security Hub findings or a connected AWS account discovery that reads this setting).')]
      : [{ status: 'NOT_APPLICABLE', observation: 'No AWS resources.', evidence: [] }],
  })),
];
