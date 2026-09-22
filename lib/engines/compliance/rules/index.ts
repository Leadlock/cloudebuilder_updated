/**
 * CloudCraft — Compliance Rules
 *
 * SOC2, HIPAA, and PCI-DSS rules evaluated against actual architecture/resource configuration.
 *
 * Each rule:
 *  - Inspects actual node config values (not generic assumptions)
 *  - Produces findings with: framework, controlId, title, severity, status,
 *    affectedResourceIds, evidence, recommendation, remediation, reference, provider
 *  - Never generates findings for resources not in the architecture
 */

import type { CanvasNode } from '@/types';

export interface ComplianceRule {
  id: string;
  framework: 'SOC2' | 'HIPAA' | 'PCI-DSS';
  controlId: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  reference: string;  // Official control documentation URL
  evaluate: (resources: CanvasNode[]) => ComplianceFinding;
}

export interface ComplianceFinding {
  passed: boolean;
  affectedResourceIds: string[];
  /** Actual config values/conditions that triggered this finding */
  evidence: string[];
  recommendation: string;
  remediation: string;
  /** Which cloud providers are covered by this finding */
  providers: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getConfig(node: CanvasNode, key: string): unknown {
  return (node.config as Record<string, unknown>)?.[key];
}

function nodeProvider(type: string): string {
  if (type.startsWith('aws_')) return 'aws';
  if (type.startsWith('azure_')) return 'azure';
  return 'unknown';
}

// ─── SOC2 Rules ───────────────────────────────────────────────────────────────

export const soc2Rules: ComplianceRule[] = [
  {
    id: 'SOC2-CC6.1-ENCRYPTION-AT-REST',
    framework: 'SOC2',
    controlId: 'CC6.1',
    title: 'Data at rest must be encrypted',
    description: 'All storage services and databases must have encryption at rest enabled to protect data confidentiality.',
    severity: 'high',
    reference: 'https://www.aicpa.org/resources/article/soc-2-cc6-logical-and-physical-access-controls',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        const p = nodeProvider(r.resourceType);
        providers.add(p);
        const cfg = r.config as Record<string, unknown>;

        if (r.resourceType === 'aws_rds' && cfg['storageEncrypted'] !== true) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_rds): storageEncrypted=${JSON.stringify(cfg['storageEncrypted'] ?? 'not set')}`);
        }
        if (r.resourceType === 'aws_ebs' && cfg['encrypted'] !== true) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_ebs): encrypted=${JSON.stringify(cfg['encrypted'] ?? 'not set')}`);
        }
        if (r.resourceType === 'aws_s3' && !cfg['sseAlgorithm']) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_s3): sseAlgorithm=not configured`);
        }
        if (r.resourceType === 'azure_sql' && cfg['transparentDataEncryption'] === false) {
          affected.push(r.id);
          evidence.push(`${r.label} (azure_sql): transparentDataEncryption=false`);
        }
        if (r.resourceType === 'azure_storage' && cfg['enableHttpsTrafficOnly'] === false) {
          affected.push(r.id);
          evidence.push(`${r.label} (azure_storage): enableHttpsTrafficOnly=false`);
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Enable server-side encryption on all databases, volumes, and storage buckets.',
        remediation: 'AWS: Set storageEncrypted=true on RDS, encrypted=true on EBS, configure SSE on S3. Azure: Enable TDE on SQL, HTTPS-only on storage.',
        providers: [...providers],
      };
    },
  },
  {
    id: 'SOC2-CC6.6-NETWORK-ACCESS',
    framework: 'SOC2',
    controlId: 'CC6.6',
    title: 'Restrict network access to authorized sources',
    description: 'Security groups and firewall rules must not allow unrestricted ingress from any IP address (0.0.0.0/0 or ::/0) on sensitive ports.',
    severity: 'high',
    reference: 'https://www.aicpa.org/resources/article/soc-2-cc6-logical-and-physical-access-controls',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        providers.add(nodeProvider(r.resourceType));
        const cfgStr = JSON.stringify(r.config ?? {});

        if (
          (r.resourceType === 'aws_sg' || r.resourceType === 'aws_security_group') &&
          (cfgStr.includes('0.0.0.0/0') || cfgStr.includes('::/0'))
        ) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_sg): ingressCidr includes 0.0.0.0/0 or ::/0`);
        }
        if (r.resourceType === 'azure_nsg' && cfgStr.includes('0.0.0.0/0')) {
          affected.push(r.id);
          evidence.push(`${r.label} (azure_nsg): source address includes 0.0.0.0/0`);
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Replace 0.0.0.0/0 ingress rules with specific CIDR ranges or security group references.',
        remediation: 'Review and update inbound rules to restrict access to known IP ranges. Use VPN or bastion host for administrative access.',
        providers: [...providers],
      };
    },
  },
  {
    id: 'SOC2-CC6.7-ENCRYPTION-IN-TRANSIT',
    framework: 'SOC2',
    controlId: 'CC6.7',
    title: 'Encryption in transit must be enforced',
    description: 'All HTTP listeners and database connections must enforce TLS/HTTPS to protect data in transit.',
    severity: 'high',
    reference: 'https://www.aicpa.org/resources/article/soc-2-cc6-logical-and-physical-access-controls',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        providers.add(nodeProvider(r.resourceType));
        const cfg = r.config as Record<string, unknown>;

        if (r.resourceType === 'aws_alb' && cfg['httpRedirectEnabled'] === false) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_alb): httpRedirectEnabled=false (HTTP traffic allowed without redirect)`);
        }
        if (r.resourceType === 'aws_rds' && cfg['sslRequired'] === false) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_rds): sslRequired=false`);
        }
        if (r.resourceType === 'azure_storage' && cfg['enableHttpsTrafficOnly'] === false) {
          affected.push(r.id);
          evidence.push(`${r.label} (azure_storage): enableHttpsTrafficOnly=false`);
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Enforce HTTPS/TLS on all load balancers, API endpoints, and database connections.',
        remediation: 'Enable HTTP→HTTPS redirects on ALBs, set sslRequired on RDS, enableHttpsTrafficOnly on Azure Storage.',
        providers: [...providers],
      };
    },
  },
  {
    id: 'SOC2-CC7.2-LOGGING-MONITORING',
    framework: 'SOC2',
    controlId: 'CC7.2',
    title: 'Logging and monitoring must be enabled',
    description: 'CloudTrail or Azure Monitor must be present in the architecture for security event detection.',
    severity: 'medium',
    reference: 'https://www.aicpa.org/resources/article/soc-2-cc7-system-operations',
    evaluate: (resources) => {
      const providers = new Set<string>();
      const hasLogging: Record<string, boolean> = { aws: false, azure: false };

      resources.forEach(r => {
        const p = nodeProvider(r.resourceType);
        providers.add(p);
        const cfg = r.config as Record<string, unknown>;

        if (r.resourceType === 'aws_cloudtrail' || (cfg['enableCloudTrail'] === true)) hasLogging.aws = true;
        if (r.resourceType === 'azure_log_analytics' || (cfg['diagnosticsEnabled'] === true)) hasLogging.azure = true;
      });

      const affected: string[] = [];
      const evidence: string[] = [];

      // Check: if there are cloud resources but no logging for that provider
      const awsResources = resources.filter(r => r.resourceType.startsWith('aws_'));
      const azureResources = resources.filter(r => r.resourceType.startsWith('azure_'));

      if (awsResources.length > 0 && !hasLogging.aws) {
        awsResources.forEach(r => affected.push(r.id));
        evidence.push(`${awsResources.length} AWS resource(s) present but no CloudTrail or logging resource found in architecture`);
      }
      if (azureResources.length > 0 && !hasLogging.azure) {
        azureResources.forEach(r => affected.push(r.id));
        evidence.push(`${azureResources.length} Azure resource(s) present but no Log Analytics Workspace found in architecture`);
      }

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Add CloudTrail (AWS) or Log Analytics Workspace (Azure) to your architecture.',
        remediation: 'Enable audit logging for all API calls and data access events. Configure log retention for at least 90 days.',
        providers: [...providers],
      };
    },
  },
  {
    id: 'SOC2-CC9.2-BACKUP',
    framework: 'SOC2',
    controlId: 'CC9.2',
    title: 'Backup and recovery must be configured',
    description: 'Databases must have automated backups enabled with appropriate retention periods.',
    severity: 'medium',
    reference: 'https://www.aicpa.org/resources/article/soc-2-cc9-risk-mitigation',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        providers.add(nodeProvider(r.resourceType));
        const cfg = r.config as Record<string, unknown>;

        if (r.resourceType === 'aws_rds') {
          const retention = Number(cfg['backupRetentionPeriod'] ?? 0);
          if (retention === 0) {
            affected.push(r.id);
            evidence.push(`${r.label} (aws_rds): backupRetentionPeriod=0 (automated backups disabled)`);
          } else if (retention < 7) {
            affected.push(r.id);
            evidence.push(`${r.label} (aws_rds): backupRetentionPeriod=${retention} days (recommended ≥7)`);
          }
        }
        if (r.resourceType === 'azure_sql') {
          const backupEnabled = cfg['backupEnabled'];
          if (backupEnabled === false) {
            affected.push(r.id);
            evidence.push(`${r.label} (azure_sql): backupEnabled=false`);
          }
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Enable automated backups with a minimum 7-day retention period on all databases.',
        remediation: 'Set backupRetentionPeriod≥7 on AWS RDS, enable Azure SQL backup.',
        providers: [...providers],
      };
    },
  },
];

// ─── HIPAA Rules ──────────────────────────────────────────────────────────────

export const hipaaRules: ComplianceRule[] = [
  {
    id: 'HIPAA-164.312-a1-ACCESS-CONTROL',
    framework: 'HIPAA',
    controlId: '164.312(a)(1)',
    title: 'Strict Access Control — No Public Database Access',
    description: 'Databases storing ePHI must not be publicly accessible. Direct internet access to databases is prohibited.',
    severity: 'critical',
    reference: 'https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        providers.add(nodeProvider(r.resourceType));
        const cfg = r.config as Record<string, unknown>;

        if (r.resourceType === 'aws_rds' && cfg['publiclyAccessible'] === true) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_rds): publiclyAccessible=true — database reachable from public internet`);
        }
        if (r.resourceType === 'azure_sql' && cfg['publicNetworkAccess'] === true) {
          affected.push(r.id);
          evidence.push(`${r.label} (azure_sql): publicNetworkAccess=true`);
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Place databases in private subnets and disable public internet access.',
        remediation: 'Set publiclyAccessible=false on RDS. Disable public network access on Azure SQL.',
        providers: [...providers],
      };
    },
  },
  {
    id: 'HIPAA-164.312-b-AUDIT-CONTROLS',
    framework: 'HIPAA',
    controlId: '164.312(b)',
    title: 'Audit Controls — Activity Logging Required',
    description: 'Hardware, software, and procedural mechanisms must record and examine activity in systems containing ePHI.',
    severity: 'high',
    reference: 'https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        providers.add(nodeProvider(r.resourceType));
        const cfg = r.config as Record<string, unknown>;

        if (r.resourceType === 'aws_rds' && cfg['enableCloudwatchLogsExports'] === undefined) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_rds): enableCloudwatchLogsExports not configured — database activity not logged`);
        }
        if (r.resourceType === 'aws_s3' && cfg['accessLogging'] === false) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_s3): accessLogging=false — S3 access not logged`);
        }
        if (r.resourceType === 'azure_sql' && cfg['auditingEnabled'] !== true) {
          affected.push(r.id);
          evidence.push(`${r.label} (azure_sql): auditingEnabled=${JSON.stringify(cfg['auditingEnabled'] ?? 'not set')}`);
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Enable audit logging on all data stores processing ePHI.',
        remediation: 'Enable CloudWatch logs exports on RDS, server access logging on S3. Enable SQL auditing on Azure SQL.',
        providers: [...providers],
      };
    },
  },
  {
    id: 'HIPAA-164.312-c1-INTEGRITY',
    framework: 'HIPAA',
    controlId: '164.312(c)(1)',
    title: 'Data Integrity — Backup and Versioning',
    description: 'Implement policies and procedures to protect ePHI from improper alteration or destruction.',
    severity: 'high',
    reference: 'https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        providers.add(nodeProvider(r.resourceType));
        const cfg = r.config as Record<string, unknown>;

        if (r.resourceType === 'aws_s3' && cfg['versioning'] !== 'Enabled') {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_s3): versioning=${JSON.stringify(cfg['versioning'] ?? 'not set')} — objects cannot be recovered`);
        }
        if (r.resourceType === 'aws_rds' && cfg['deletionProtection'] !== true) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_rds): deletionProtection=${JSON.stringify(cfg['deletionProtection'] ?? 'not set')}`);
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Enable versioning on S3 buckets and deletion protection on databases.',
        remediation: 'Set versioning=Enabled on S3. Set deletionProtection=true on RDS.',
        providers: [...providers],
      };
    },
  },
  {
    id: 'HIPAA-164.312-e2ii-ENCRYPTION-TRANSIT',
    framework: 'HIPAA',
    controlId: '164.312(e)(2)(ii)',
    title: 'Encryption in Transit for ePHI',
    description: 'Implement a mechanism to encrypt ePHI in transit unless otherwise protected.',
    severity: 'high',
    reference: 'https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        providers.add(nodeProvider(r.resourceType));
        const cfg = r.config as Record<string, unknown>;

        if (r.resourceType === 'aws_rds' && cfg['sslRequired'] === false) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_rds): sslRequired=false — unencrypted database connections allowed`);
        }
        if (r.resourceType === 'azure_sql' && cfg['sslEnforcementEnabled'] === false) {
          affected.push(r.id);
          evidence.push(`${r.label} (azure_sql): sslEnforcementEnabled=false`);
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Enforce SSL/TLS on all database connections.',
        remediation: 'Set sslRequired=true on RDS. Enable sslEnforcementEnabled on Azure SQL.',
        providers: [...providers],
      };
    },
  },
];

// ─── PCI-DSS Rules ────────────────────────────────────────────────────────────

export const pciRules: ComplianceRule[] = [
  {
    id: 'PCI-DSS-1.2.1-FIREWALL',
    framework: 'PCI-DSS',
    controlId: '1.2.1',
    title: 'Restrict inbound and outbound traffic to cardholder data environment',
    description: 'Firewall and security group rules must not allow unrestricted ingress or egress. Cardholder data systems must only accept necessary traffic.',
    severity: 'critical',
    reference: 'https://www.pcisecuritystandards.org/document_library/?document=pci_dss',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        providers.add(nodeProvider(r.resourceType));
        const cfgStr = JSON.stringify(r.config ?? {});

        if (
          (r.resourceType === 'aws_sg' || r.resourceType === 'aws_security_group') &&
          cfgStr.includes('0.0.0.0/0')
        ) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_sg): ingress cidr 0.0.0.0/0 allows unrestricted internet access`);
        }
        if (r.resourceType === 'azure_nsg' && cfgStr.includes('0.0.0.0/0')) {
          affected.push(r.id);
          evidence.push(`${r.label} (azure_nsg): security rule allows traffic from 0.0.0.0/0`);
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Replace all 0.0.0.0/0 ingress rules with specific, minimal CIDR ranges.',
        remediation: 'Update security groups/NSGs/firewall rules to restrict source IPs. Document all necessary traffic flows in a network diagram.',
        providers: [...providers],
      };
    },
  },
  {
    id: 'PCI-DSS-2.2.1-UNNECESSARY-SERVICES',
    framework: 'PCI-DSS',
    controlId: '2.2.1',
    title: 'Disable unnecessary services and default open ports',
    description: 'System components must not have unnecessary or insecure services, protocols, or ports enabled.',
    severity: 'high',
    reference: 'https://www.pcisecuritystandards.org/document_library/?document=pci_dss',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        providers.add(nodeProvider(r.resourceType));
        const cfg = r.config as Record<string, unknown>;
        const cfgStr = JSON.stringify(cfg);

        // Check for telnet (port 23), FTP (port 21) in firewall rules
        if (
          (r.resourceType === 'aws_sg' || r.resourceType === 'azure_nsg') &&
          (cfgStr.includes('"23"') || cfgStr.includes(':23') || cfgStr.includes('"21"') || cfgStr.includes(':21'))
        ) {
          affected.push(r.id);
          evidence.push(`${r.label} (${r.resourceType}): Ports 21 (FTP) or 23 (Telnet) detected in rules — insecure protocols not allowed in CDE`);
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Remove or disable rules allowing FTP (21), Telnet (23) and other insecure protocols.',
        remediation: 'Review all inbound/outbound rules. Remove rules allowing Telnet, FTP, unencrypted HTTP on CDE systems.',
        providers: [...providers],
      };
    },
  },
  {
    id: 'PCI-DSS-6.4.1-PUBLIC-DATABASE',
    framework: 'PCI-DSS',
    controlId: '6.4.1',
    title: 'Cardholder data stores must not be publicly accessible',
    description: 'Databases that may store cardholder data must be isolated from public internet access.',
    severity: 'critical',
    reference: 'https://www.pcisecuritystandards.org/document_library/?document=pci_dss',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        providers.add(nodeProvider(r.resourceType));
        const cfg = r.config as Record<string, unknown>;

        const isDbType = [
          'aws_rds', 'aws_dynamodb',
          'azure_sql', 'azure_cosmos',
        ].includes(r.resourceType);

        if (isDbType && cfg['publiclyAccessible'] === true) {
          affected.push(r.id);
          evidence.push(`${r.label} (${r.resourceType}): publiclyAccessible=true — may expose cardholder data to internet`);
        }
        if (isDbType && cfg['publicNetworkAccess'] === true) {
          affected.push(r.id);
          evidence.push(`${r.label} (${r.resourceType}): publicNetworkAccess=true`);
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Place all databases in private subnets. Disable all forms of public internet access.',
        remediation: 'Set publiclyAccessible=false. Configure VPC private endpoints or service endpoints for database access.',
        providers: [...providers],
      };
    },
  },
  {
    id: 'PCI-DSS-8.3.1-MFA',
    framework: 'PCI-DSS',
    controlId: '8.3.1',
    title: 'Multi-factor authentication on administrative access',
    description: 'MFA must be required for all non-console administrative access to the cardholder data environment.',
    severity: 'high',
    reference: 'https://www.pcisecuritystandards.org/document_library/?document=pci_dss',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        providers.add(nodeProvider(r.resourceType));
        const cfg = r.config as Record<string, unknown>;

        if (r.resourceType === 'aws_iam' && cfg['mfaEnabled'] === false) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_iam): mfaEnabled=false — administrative accounts without MFA`);
        }
        if (r.resourceType === 'azure_key_vault' && cfg['enablePurgeProtection'] === false) {
          affected.push(r.id);
          evidence.push(`${r.label} (azure_key_vault): enablePurgeProtection=false — admin access without purge protection`);
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Enforce MFA on all IAM users and service accounts with administrative access.',
        remediation: 'Enable AWS IAM MFA enforcement policy. Use Azure Conditional Access for MFA.',
        providers: [...providers],
      };
    },
  },
  {
    id: 'PCI-DSS-10.2-AUDIT-LOGS',
    framework: 'PCI-DSS',
    controlId: '10.2',
    title: 'Audit logs must be enabled for all system components',
    description: 'Implement audit trails to reconstruct access, privilege changes, and security events in the CDE.',
    severity: 'high',
    reference: 'https://www.pcisecuritystandards.org/document_library/?document=pci_dss',
    evaluate: (resources) => {
      const affected: string[] = [];
      const evidence: string[] = [];
      const providers = new Set<string>();

      resources.forEach(r => {
        providers.add(nodeProvider(r.resourceType));
        const cfg = r.config as Record<string, unknown>;

        if (r.resourceType === 'aws_rds' && cfg['enableCloudwatchLogsExports'] === undefined) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_rds): CloudWatch log exports not configured`);
        }
        if (r.resourceType === 'aws_s3' && cfg['serverAccessLogging'] === false) {
          affected.push(r.id);
          evidence.push(`${r.label} (aws_s3): serverAccessLogging=false`);
        }
        if (r.resourceType === 'azure_sql' && cfg['auditingEnabled'] !== true) {
          affected.push(r.id);
          evidence.push(`${r.label} (azure_sql): auditingEnabled=${JSON.stringify(cfg['auditingEnabled'] ?? 'not set')}`);
        }
      });

      return {
        passed: affected.length === 0,
        affectedResourceIds: [...new Set(affected)],
        evidence,
        recommendation: 'Enable audit logging on all databases, storage, and network components in the CDE.',
        remediation: 'Configure CloudWatch exports on RDS, server access logging on S3. Enable SQL audit on Azure.',
        providers: [...providers],
      };
    },
  },
];
