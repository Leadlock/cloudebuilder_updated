import type { RuleDefinition } from '../types';
import { awsRules } from './aws';
import { azureRules } from './azure';
import { QUESTION_RULES } from '../questionnaire/questionRules';

export const ALL_RULES: RuleDefinition[] = [...awsRules, ...azureRules];

export const RULES_BY_ID: Map<string, RuleDefinition> = (() => {
  const m = new Map<string, RuleDefinition>();
  // Questionnaire rules are looked up by id like any other rule, but only run when answers are supplied (not part of ALL_RULES).
  for (const r of [...ALL_RULES, ...QUESTION_RULES]) {
    if (m.has(r.id)) throw new Error(`Duplicate assessment rule id ${r.id}`);
    m.set(r.id, r);
  }
  return m;
})();

/**
 * Legacy rule IDs (pre-2026.09 engines) → current rule IDs. Used to keep old
 * persisted scans, tests and fix actions resolvable. Legacy IDs whose rule was
 * removed as incorrect map to null.
 */
export const LEGACY_RULE_IDS: Record<string, string | null> = {
  // Former SecurityAnalyzer IDs
  'AWS-S3-PUBLIC': 'AWS-S3-001',
  'AWS-S3-NO-PUBLIC-BLOCK': 'AWS-S3-001',
  'AWS-S3-NO-ENCRYPTION': 'AWS-S3-002',
  'AWS-RDS-PUBLICLY-ACCESSIBLE': 'AWS-RDS-001',
  'AWS-RDS-NO-ENCRYPTION': 'AWS-RDS-002',
  'AWS-RDS-NO-MULTI-AZ': 'AWS-RDS-006',
  'AWS-SG-OPEN-SSH': 'AWS-SG-001',
  'AWS-EC2-PUBLIC-SUBNET': 'AWS-VPC-001',
  'AWS-VPC-NO-DNS': 'AWS-VPC-003',
  'AZ-STORAGE-NO-HTTPS': 'AZ-STG-001',
  'AZ-STORAGE-PUBLIC-BLOB': 'AZ-STG-002',
  'AZ-SQL-PUBLIC-ACCESS': 'AZ-SQL-001',
  'AZ-SQL-NO-TDE': 'AZ-SQL-002',
  'AZ-NSG-OPEN-SSH': 'AZ-NSG-001',
  'AZ-NSG-OPEN-RDP': 'AZ-NSG-002',
  'AZ-VM-NO-DISK-ENCRYPTION': 'AZ-VM-002',
  // Former resource-definition (RDE) rule IDs
  's3-public': 'AWS-S3-001', 's3-block-public-access': 'AWS-S3-001', 's3-encryption': 'AWS-S3-002',
  's3-versioning': 'AWS-S3-005', 's3-logging': 'AWS-S3-003',
  'rds-public-access': 'AWS-RDS-001', 'rds-encryption': 'AWS-RDS-002', 'rds-multi-az': 'AWS-RDS-006',
  'rds-no-deletion-protection': 'AWS-RDS-008', 'rds-backup-retention': 'AWS-RDS-007',
  'sg-open-ssh': 'AWS-SG-001', 'sg-open-rdp': 'AWS-SG-002', 'nacl-allow-all-inbound': 'AWS-NACL-001',
  'vpc-dns': 'AWS-VPC-003', 'subnet-public-ip': 'AWS-VPC-001', 'ec2-public-ip': 'AWS-EC2-001',
  'ebs-encryption': 'AWS-EBS-001', 'ebs-no-snapshot-schedule': 'AWS-EBS-002',
  'cloudfront-http-allowed': 'AWS-CF-001', 'cloudfront-no-waf': 'AWS-CF-002',
  'alb-https-no-cert': 'AWS-ELB-001', 'alb-deletion-protection': 'AWS-ELB-004',
  'lambda-tracing-disabled': 'AWS-LAMBDA-001', 'ecs-public-ip': 'AWS-ECS-001',
  'eks-public-endpoint-open': 'AWS-EKS-001', 'eks-secrets-encryption': 'AWS-EKS-002', 'eks-no-audit-logging': 'AWS-EKS-003',
  'iam-admin-access': 'AWS-IAM-001', 'kms-key-rotation': 'AWS-KMS-001',
  'dynamodb-pitr': 'AWS-DDB-002', 'waf-no-managed-rules': 'AWS-WAF-001',
  'elasticache-transit-encryption': 'AWS-ELC-001', 'elasticache-at-rest-encryption': 'AWS-ELC-002', 'elasticache-no-failover': 'AWS-ELC-003',
  'sqs-encryption': 'AWS-SQS-001', 'sqs-no-dlq': 'AWS-SQS-002',
  'storage-https': 'AZ-STG-001', 'storage-public-blob-access': 'AZ-STG-002', 'storage-tls-version': 'AZ-STG-003', 'storage-network-open': 'AZ-STG-004',
  'sql-public-access': 'AZ-SQL-001', 'sql-tde-disabled': 'AZ-SQL-002', 'sql-threat-detection': 'AZ-SQL-004',
  'cosmos-public-access': 'AZ-COS-001', 'nsg-open-ssh': 'AZ-NSG-001', 'nsg-open-rdp': 'AZ-NSG-002',
  'vm-public-ip': 'AZ-VM-001', 'vmss-disk-encryption': 'AZ-VMSS-001', 'nic-ip-forwarding': 'AZ-NIC-001',
  'keyvault-public-access': 'AZ-KV-001', 'keyvault-no-purge-protection': 'AZ-KV-002',
  'functions-https-only': 'AZ-FUNC-001', 'app-service-https-only': 'AZ-APP-001', 'app-service-ftp-enabled': 'AZ-APP-003', 'app-service-old-tls': 'AZ-APP-002',
  'aks-no-rbac': 'AZ-AKS-001', 'aks-no-private-cluster': 'AZ-AKS-002', 'frontdoor-https-only': 'AZ-AFD-001',
  'azure-waf-detection-only': 'AZ-WAF-001', 'app-gateway-no-waf': 'AZ-AGW-001',
  'redis-non-ssl-port': 'AZ-RED-001', 'redis-public-access': 'AZ-RED-002', 'bastion-shareable-link': 'AZ-BAS-001',
  // Removed as incorrect (see docs/security-assessment/AUDIT.md)
  'ec2-key-pair': null, 'kms-short-deletion-window': null, 'waf-default-allow': null, 'dynamodb-encryption': null,
  'vm-managed-disk': null, 'functions-public-access': null,
};

export function resolveRuleId(id: string): string | null {
  if (RULES_BY_ID.has(id)) return id;
  if (id in LEGACY_RULE_IDS) return LEGACY_RULE_IDS[id];
  return null;
}
