/**
 * Official reference catalog.
 *
 * Stores reference METADATA only (organization, identifier, title, URL) plus a
 * short CloudBuilder interpretation in the rules themselves — never copied
 * documentation text.
 *
 * Verification (see ReferenceVerification in ./types). Re-run on 2026-09-24: the build
 * environment's egress policy blocks docs.aws.amazon.com, learn.microsoft.com, aka.ms,
 * azure.microsoft.com, aicpa-cima.com and github.com (HTTP 403 at the proxy); only
 * raw.githubusercontent.com is reachable, so only machine-readable sources hosted there
 * could be checked.
 *  - AWS Security Hub (AWS Foundational Security Best Practices) control IDs,
 *    titles and official severities were cross-checked on 2026-09-24 against a
 *    maintained machine-readable mapping of the FSBP standard
 *    (prowler-cloud/prowler: compliance/aws/aws_foundational_security_best_practices_aws.json).
 *    docs.aws.amazon.com was not reachable from the build environment, so these are
 *    CROSS_CHECKED_SECONDARY, not VERIFIED_OFFICIAL_SOURCE.
 *  - Microsoft cloud security benchmark (MCSB) control IDs and the Azure Policy
 *    built-in definition GUIDs were verified against Microsoft's official
 *    "Microsoft cloud security benchmark" initiative (Azure/azure-policy,
 *    built-in-policies/policySetDefinitions/Security Center/AzureSecurityCenter.json,
 *    initiative version 57.58.0). learn.microsoft.com was not reachable, so control
 *    titles/URLs are recorded from the benchmark's published naming and flagged.
 *  - HashiCorp provider attribute names were verified against the official
 *    provider documentation sources (hashicorp/terraform-provider-aws, -azurerm).
 */
import type { SourceReference } from './types';

const SH_PAGE = (svc: string) => `https://docs.aws.amazon.com/securityhub/latest/userguide/${svc}-controls.html`;
const SH_NOTE = 'Control ID, title and official severity re-checked on 2026-09-24 against the machine-readable FSBP mapping in prowler-cloud/prowler (all 49 CloudBuilder controls match). docs.aws.amazon.com is blocked by the build environment\'s network policy, so the AWS Security Hub user guide itself was not consulted — primary reference verification is still required.';

/** AWS Foundational Security Best Practices controls used by CloudBuilder rules. */
const AWS_FSBP: Array<[string, string, string, string]> = [
  // [controlId, service page slug, title, officialSeverity]
  ['S3.2', 's3', 'S3 buckets should prohibit public read access', 'critical'],
  ['S3.3', 's3', 'S3 buckets should prohibit public write access', 'critical'],
  ['S3.8', 's3', 'S3 Block Public Access setting should be enabled at the bucket level', 'high'],
  ['S3.9', 's3', 'S3 bucket server access logging should be enabled', 'medium'],
  ['S3.12', 's3', 'S3 access control lists (ACLs) should not be used to manage user access to buckets', 'medium'],
  ['S3.13', 's3', 'S3 buckets should have lifecycle policies configured', 'low'],
  ['S3.14', 's3', 'S3 general purpose buckets should have versioning enabled', 'low'],
  ['RDS.2', 'rds', 'RDS DB instances should prohibit public access, determined by the PubliclyAccessible configuration', 'critical'],
  ['RDS.3', 'rds', 'RDS DB instances should have encryption at-rest enabled', 'medium'],
  ['RDS.5', 'rds', 'RDS DB instances should be configured with multiple Availability Zones', 'medium'],
  ['RDS.6', 'rds', 'Enhanced monitoring should be configured for RDS DB instances and clusters', 'low'],
  ['RDS.8', 'rds', 'RDS DB instances should have deletion protection enabled', 'low'],
  ['RDS.9', 'rds', 'RDS DB instances should publish logs to CloudWatch Logs', 'medium'],
  ['RDS.10', 'rds', 'IAM authentication should be configured for RDS instances', 'medium'],
  ['RDS.11', 'rds', 'RDS instances should have automatic backups enabled', 'medium'],
  ['RDS.13', 'rds', 'RDS automatic minor version upgrades should be enabled', 'high'],
  ['EC2.3', 'ec2', 'Attached EBS volumes should be encrypted at rest', 'medium'],
  ['EC2.6', 'ec2', 'VPC flow logging should be enabled in all VPCs', 'medium'],
  ['EC2.8', 'ec2', 'EC2 instances should use IMDSv2', 'high'],
  ['EC2.9', 'ec2', 'EC2 instances should not have a public IP address', 'high'],
  ['EC2.13', 'ec2', 'Security groups should not allow ingress from 0.0.0.0/0 or ::/0 to port 22', 'high'],
  ['EC2.14', 'ec2', 'Security groups should not allow ingress from 0.0.0.0/0 or ::/0 to port 3389', 'high'],
  ['EC2.15', 'ec2', 'EC2 subnets should not automatically assign public IP addresses', 'medium'],
  ['EC2.21', 'ec2', 'Network ACLs should not allow ingress from 0.0.0.0/0 to port 22 or port 3389', 'medium'],
  ['ECS.2', 'ecs', 'Amazon ECS services should not have public IP addresses assigned to them automatically', 'high'],
  ['EKS.1', 'eks', 'EKS cluster endpoints should not be publicly accessible', 'high'],
  ['EKS.3', 'eks', 'EKS clusters should use encrypted Kubernetes secrets', 'medium'],
  ['EKS.8', 'eks', 'EKS clusters should have audit logging enabled', 'medium'],
  ['ELB.1', 'elb', 'Application Load Balancer should be configured to redirect all HTTP requests to HTTPS', 'medium'],
  ['ELB.6', 'elb', 'Application Load Balancer deletion protection should be enabled', 'medium'],
  ['ELB.16', 'elb', 'Application Load Balancers should be associated with an AWS WAF web ACL', 'medium'],
  ['CloudFront.3', 'cloudfront', 'CloudFront distributions should require encryption in transit', 'medium'],
  ['CloudFront.6', 'cloudfront', 'CloudFront distributions should have AWS WAF enabled', 'medium'],
  ['ElastiCache.1', 'elasticache', 'ElastiCache for Redis clusters should have automatic backups scheduled', 'high'],
  ['ElastiCache.3', 'elasticache', 'ElastiCache for Redis replication groups should have automatic failover enabled', 'medium'],
  ['ElastiCache.4', 'elasticache', 'ElastiCache for Redis replication groups should be encrypted at rest', 'medium'],
  ['ElastiCache.5', 'elasticache', 'ElastiCache for Redis replication groups should be encrypted in transit', 'medium'],
  ['DynamoDB.2', 'dynamodb', 'DynamoDB tables should have point-in-time recovery enabled', 'medium'],
  ['DynamoDB.6', 'dynamodb', 'DynamoDB tables should have deletion protection enabled', 'medium'],
  ['IAM.1', 'iam', "IAM policies should not allow full '*' administrative privileges", 'high'],
  ['IAM.9', 'iam', 'MFA should be enabled for the root user', 'critical'],
  ['KMS.4', 'kms', 'AWS KMS key rotation should be enabled', 'medium'],
  ['SQS.1', 'sqs', 'Amazon SQS queues should be encrypted at rest', 'medium'],
  ['WAF.10', 'waf', 'AWS WAF web ACLs should have at least one rule or rule group', 'medium'],
  ['CloudTrail.1', 'cloudtrail', 'CloudTrail should be enabled and configured with at least one multi-Region trail', 'high'],
  ['GuardDuty.1', 'guardduty', 'GuardDuty should be enabled', 'high'],
  ['Config.1', 'config', 'AWS Config should be enabled', 'medium'],
  ['SSM.1', 'ssm', 'EC2 instances should be managed by AWS Systems Manager', 'medium'],
  ['AutoScaling.1', 'autoscaling', 'Auto Scaling groups associated with a load balancer should use load balancer health checks', 'low'],
];

const MCSB_PAGES: Record<string, string> = {
  NS: 'https://learn.microsoft.com/security/benchmark/azure/mcsb-network-security',
  DP: 'https://learn.microsoft.com/security/benchmark/azure/mcsb-data-protection',
  IM: 'https://learn.microsoft.com/security/benchmark/azure/mcsb-identity-management',
  PA: 'https://learn.microsoft.com/security/benchmark/azure/mcsb-privileged-access',
  LT: 'https://learn.microsoft.com/security/benchmark/azure/mcsb-logging-threat-detection',
  BR: 'https://learn.microsoft.com/security/benchmark/azure/mcsb-backup-recovery',
  PV: 'https://learn.microsoft.com/security/benchmark/azure/mcsb-posture-vulnerability-management',
};
const MCSB_NOTE = 'Control ID and Azure Policy definition mapping re-verified on 2026-09-24 in Microsoft\'s built-in "Microsoft cloud security benchmark" initiative (Azure/azure-policy, v57.58.0; all 41 CloudBuilder MCSB/Policy references present). The Microsoft Learn page (learn.microsoft.com) is blocked by the build environment\'s network policy, so the control title and URL were not checked against it.';

/** [MCSB control, title, Azure Policy definition GUID (from the MCSB initiative), policy reference id] */
const AZURE_MCSB: Array<[string, string, string?, string?]> = [
  ['NS-1', 'Establish network segmentation boundaries', 'e71308d3-144b-4262-b144-efdc3cc90517', 'networkSecurityGroupsOnSubnetsMonitoring'],
  ['NS-2', 'Secure cloud native services with network controls'],
  ['NS-3', 'Deploy firewall at the edge of enterprise network', '22730e10-96f6-4aac-ad84-9383d35b5917', 'restrictAccessToManagementPortsMonitoring'],
  ['NS-6', 'Deploy web application firewall'],
  ['DP-3', 'Encrypt sensitive data in transit'],
  ['DP-4', 'Enable data at rest encryption by default'],
  ['DP-8', 'Ensure security of key and certificate repository'],
  ['IM-1', 'Use centralized identity and authentication system'],
  ['IM-6', 'Use strong authentication controls'],
  ['PA-7', 'Follow just enough administration (least privilege) principle'],
  ['LT-1', 'Enable threat detection capabilities'],
  ['LT-3', 'Enable logging for security investigation'],
  ['BR-1', 'Ensure regular automated backups', '013e242c-8828-4970-87b3-ab247555486d', 'azureBackupShouldBeEnabledForVirtualMachinesMonitoringEffect'],
];

/** Azure Policy built-in definitions (GUIDs from the MCSB initiative) used as control evidence. */
const AZURE_POLICIES: Array<[string, string, string, string]> = [
  // [key suffix, MCSB control, definition GUID, initiative policyDefinitionReferenceId]
  ['storage-secure-transfer', 'DP-3', '404c3081-a854-4457-ae30-26a93ef643f9', 'secureTransferToStorageAccountMonitoring'],
  ['storage-public-access', 'NS-2', '4fa4b6c0-31ca-4c0d-b10d-24b96f62a751', 'StorageDisallowPublicAccess'],
  ['storage-network-restrict', 'NS-2', '34c877ad-507e-4c82-993e-3452a6e0ad3c', 'disableUnrestrictedNetworkToStorageAccountMonitoring'],
  ['sql-public-access', 'NS-2', '1b8ca024-1d5c-4dec-8995-b1a932b41780', 'publicNetworkAccessOnAzureSQLDatabaseShouldBeDisabledMonitoringEffect'],
  ['sql-tde', 'DP-4', '17k78e20-9358-41c9-923c-fb736d382a12', 'sqlDbEncryptionMonitoring'],
  ['sql-auditing', 'LT-3', 'a6fb4358-5bf4-4ad7-ba82-2cd2f41ce5e9', 'sqlServerAuditingMonitoring'],
  ['sql-defender', 'LT-1', 'abfb4388-5bf4-4ad7-ba82-2cd2f41ceae9', 'sqlServerAdvancedDataSecurityMonitoring'],
  ['sql-tls', 'DP-3', '32e6bbec-16b6-44c2-be37-c5b672d103cf', 'azureSQLDatabaseShouldBeRunningTLSVersion12OrNewer'],
  ['cosmos-public-access', 'NS-2', '797b37f7-06b8-444c-b1ad-fc62867f335a', 'azureCosmosDBShouldDisablePublicNetworkAccess'],
  ['mgmt-ports', 'NS-3', '22730e10-96f6-4aac-ad84-9383d35b5917', 'restrictAccessToManagementPortsMonitoring'],
  ['nsg-subnets', 'NS-1', 'e71308d3-144b-4262-b144-efdc3cc90517', 'networkSecurityGroupsOnSubnetsMonitoring'],
  ['ip-forwarding', 'NS-3', 'bd352bd5-2853-4985-bf0d-73806b4a5744', 'disableIPForwardingMonitoring'],
  ['vm-encryption-at-host', 'DP-4', 'fc4d8e41-e223-45ea-9bf5-eada37891d87', 'virtualMachinesAndVirtualMachineScaleSetsShouldHaveEncryptionAtHostEnabled'],
  ['vm-backup', 'BR-1', '013e242c-8828-4970-87b3-ab247555486d', 'azureBackupShouldBeEnabledForVirtualMachinesMonitoringEffect'],
  ['kv-purge-protection', 'DP-8', '0b60c0b2-2dc2-4e1c-b5c9-abbed971de53', 'keyVaultsShouldHavePurgeProtectionEnabledMonitoringEffect'],
  ['kv-firewall', 'NS-2', '55615ac9-af46-4a59-874e-391cc3dfb490', 'firewallShouldBeEnabledOnKeyVaultMonitoringEffect'],
  ['kv-rbac', 'PA-7', '12d4fa5e-1f9f-4c21-97a9-b99b3c6611b5', 'keyvaultServiceRbacEnabledMonitoring'],
  ['webapp-https', 'DP-3', 'a4af4a39-4135-47fb-b175-47fbdf85311d', 'webAppEnforceHttpsMonitoring'],
  ['webapp-tls', 'DP-3', 'f0e6e85b-9b9f-4a4b-b67b-f730d42f1b0b', 'latestTLSVersionShouldBeUsedInYourWebAppMonitoringEffect'],
  ['webapp-ftps', 'DP-3', '4d24b6d4-5e53-4a4f-a7f4-618fa573ee4b', 'fTPSShouldBeRequiredInYourWebAppMonitoringEffect'],
  ['func-https', 'DP-3', '6d555dd1-86f2-4f1c-8ed7-5abae7c6cbab', 'functionAppEnforceHttpsMonitoring'],
  ['func-tls', 'DP-3', 'f9d614c5-c173-4d56-95a7-b4437057d193', 'latestTLSVersionShouldBeUsedInYourFunctionAppMonitoringEffect'],
  ['aks-rbac', 'PA-7', 'ac4a19c2-fa67-49b4-8ae5-0b2e78c49457', 'kubernetesServiceRbacEnabledMonitoring'],
  ['aks-authorized-ips', 'NS-2', '0e246bcf-5f6f-4f87-bc6f-775d4712c7ea', 'kubernetesServiceAuthorizedIPRangesEnabledMonitoring'],
  ['redis-secure-connections', 'DP-3', '22bee202-a82f-4305-9a2a-6d7f44d4dedb', 'diagnosticsLogsInRedisCacheMonitoring'],
  ['redis-private-endpoint', 'NS-2', '7803067c-7d34-46e3-8c79-0ca68fc4036d', 'azureCacheForRedisShouldUsePrivateEndpointMonitoringEffect'],
  ['agw-waf', 'NS-6', '564feb30-bf6a-4854-b4bb-0d2d2d1e6c66', 'webApplicationFirewallShouldBeEnabledForApplicationGatewayMonitoringEffect'],
  ['afd-waf', 'NS-6', '055aa869-bc98-4af8-bafc-23f1ab6ffe2c', 'webApplicationFirewallShouldBeEnabledForAzureFrontDoorServiceServiceMonitoringEffect'],
];

const AWS_WA_BASE = 'https://docs.aws.amazon.com/wellarchitected/latest';
const AZ_WA_BASE = 'https://learn.microsoft.com/azure/well-architected';
const WA_NOTE = 'Pillar URL carried over from CloudBuilder framework definitions. docs.aws.amazon.com and learn.microsoft.com are blocked by the build environment\'s network policy, so it has not been verified against the published framework — reference verification required.';

function build(): Record<string, SourceReference> {
  const refs: Record<string, SourceReference> = {};

  for (const [id, svc, title, sev] of AWS_FSBP) {
    refs[`AWS-FSBP-${id}`] = {
      key: `AWS-FSBP-${id}`,
      organization: 'AWS',
      framework: 'AWS Security Hub — AWS Foundational Security Best Practices',
      identifier: id,
      title,
      url: SH_PAGE(svc),
      verification: 'CROSS_CHECKED_SECONDARY',
      verificationNote: SH_NOTE,
      officialSeverity: sev,
    };
  }

  for (const [id, title, guid, refId] of AZURE_MCSB) {
    refs[`MCSB-${id}`] = {
      key: `MCSB-${id}`,
      organization: 'Microsoft',
      framework: 'Microsoft cloud security benchmark',
      identifier: id,
      title,
      url: MCSB_PAGES[id.split('-')[0]],
      verification: 'VERIFIED_OFFICIAL_SOURCE',
      verificationNote: MCSB_NOTE + (guid ? ` Mapped Azure Policy definition: ${guid} (${refId}).` : ''),
    };
  }

  for (const [suffix, control, guid, refId] of AZURE_POLICIES) {
    refs[`AZPOLICY-${suffix}`] = {
      key: `AZPOLICY-${suffix}`,
      organization: 'Microsoft',
      framework: 'Azure Policy built-in definition (Microsoft cloud security benchmark initiative)',
      identifier: guid,
      // Reader-facing title: the MCSB control this built-in policy is grouped under. The
      // initiative's internal reference ID stays in the verification note.
      title: `Built-in policy for MCSB ${control} — ${AZURE_MCSB.find(([id]) => id === control)?.[1] ?? 'Microsoft cloud security benchmark'}`,
      verification: 'VERIFIED_OFFICIAL_SOURCE',
      verificationNote: `Definition GUID, initiative reference ID (${refId}) and MCSB group re-verified on 2026-09-24 in the official MCSB initiative (Azure/azure-policy, v57.58.0).`,
    };
  }

  const awsPillars: Array<[string, string, string]> = [
    ['operational_excellence', 'Operational Excellence Pillar', `${AWS_WA_BASE}/operational-excellence-pillar/welcome.html`],
    ['security', 'Security Pillar', `${AWS_WA_BASE}/security-pillar/welcome.html`],
    ['reliability', 'Reliability Pillar', `${AWS_WA_BASE}/reliability-pillar/welcome.html`],
    ['performance_efficiency', 'Performance Efficiency Pillar', `${AWS_WA_BASE}/performance-efficiency-pillar/welcome.html`],
    ['cost_optimization', 'Cost Optimization Pillar', `${AWS_WA_BASE}/cost-optimization-pillar/welcome.html`],
    ['sustainability', 'Sustainability Pillar', `${AWS_WA_BASE}/sustainability-pillar/sustainability-pillar.html`],
  ];
  for (const [id, title, url] of awsPillars) {
    refs[`AWS-WA-${id}`] = {
      key: `AWS-WA-${id}`, organization: 'AWS', framework: 'AWS Well-Architected Framework',
      title, url, verification: 'NOT_VERIFIED_IN_BUILD', verificationNote: WA_NOTE,
    };
  }
  const azPillars: Array<[string, string, string]> = [
    ['reliability', 'Reliability', `${AZ_WA_BASE}/reliability/`],
    ['security', 'Security', `${AZ_WA_BASE}/security/`],
    ['cost_optimization', 'Cost Optimization', `${AZ_WA_BASE}/cost-optimization/`],
    ['operational_excellence', 'Operational Excellence', `${AZ_WA_BASE}/operational-excellence/`],
    ['performance_efficiency', 'Performance Efficiency', `${AZ_WA_BASE}/performance-efficiency/`],
  ];
  for (const [id, title, url] of azPillars) {
    refs[`AZ-WA-${id}`] = {
      key: `AZ-WA-${id}`, organization: 'Microsoft', framework: 'Azure Well-Architected Framework',
      title, url, verification: 'NOT_VERIFIED_IN_BUILD', verificationNote: WA_NOTE,
    };
  }

  refs['TF-AWS'] = {
    key: 'TF-AWS', organization: 'HashiCorp', framework: 'Terraform AWS Provider documentation',
    title: 'hashicorp/aws provider resource documentation',
    url: 'https://registry.terraform.io/providers/hashicorp/aws/latest/docs',
    verification: 'VERIFIED_OFFICIAL_SOURCE',
    verificationNote: 'Attribute names used in remediation checked against hashicorp/terraform-provider-aws website/docs sources.',
  };
  refs['TF-AZURERM'] = {
    key: 'TF-AZURERM', organization: 'HashiCorp', framework: 'Terraform AzureRM Provider documentation',
    title: 'hashicorp/azurerm provider resource documentation',
    url: 'https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs',
    verification: 'VERIFIED_OFFICIAL_SOURCE',
    verificationNote: 'Attribute names checked against hashicorp/terraform-provider-azurerm website/docs sources. CloudBuilder pins azurerm ~> 3.0; some attributes are renamed in 4.x.',
  };
  refs['AICPA-SOC1'] = {
    key: 'AICPA-SOC1', organization: 'AICPA', framework: 'SOC 1® — SOC for Service Organizations: ICFR (SSAE 18, AT-C section 320)',
    identifier: 'AT-C 320',
    title: 'Reporting on an Examination of Controls at a Service Organization Relevant to User Entities\' Internal Control Over Financial Reporting',
    url: 'https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-1',
    verification: 'NOT_VERIFIED_IN_BUILD',
    verificationNote: 'Used only to describe the scope of SOC 1 reporting. aicpa-cima.com is blocked by the build environment\'s network policy, so the page was not verified. CloudBuilder does not perform SOC 1 examinations.',
  };

  return refs;
}

export const REFERENCES: Record<string, SourceReference> = build();

/** Reader-facing description of how a reference was verified (reports, Appendix B). */
export const VERIFICATION_LABEL: Record<SourceReference['verification'], string> = {
  VERIFIED_OFFICIAL_SOURCE: 'Identifier verified against an official machine-readable source',
  CROSS_CHECKED_SECONDARY: 'Cross-checked against a secondary source; primary verification pending',
  NOT_VERIFIED_IN_BUILD: 'Not verified; reference verification pending',
};

export function resolveReferences(keys: string[]): SourceReference[] {
  return keys.map((k) => REFERENCES[k]).filter((r): r is SourceReference => Boolean(r));
}
