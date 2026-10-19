/**
 * CloudBuilder — framework control mappings (SOC 2, HIPAA Security Rule, PCI DSS v4.0).
 *
 * These are MAPPINGS from framework control areas to CloudBuilder's technical
 * assessment rules — not independent checks. Each control's status is derived
 * from the shared assessment evaluations, so it can never disagree with the
 * Security view. The previous implementation re-read resource configuration
 * with keys that do not exist in CloudBuilder (e.g. `storageEncrypted`,
 * `sseAlgorithm`, `enableHttpsTrafficOnly`) and string-matched "0.0.0.0/0" in the
 * whole security-group config (which matched the default EGRESS rule), so it
 * failed controls on correctly configured architectures.
 *
 * A "technical indicators passed" status is NOT a statement of compliance.
 * Compliance with SOC 2, HIPAA or PCI DSS can only be determined by the
 * appropriate assessor (CPA firm, covered entity/regulator, QSA).
 */

export type ComplianceFramework = 'SOC2' | 'HIPAA' | 'PCI-DSS';

export interface ComplianceRule {
  id: string;
  framework: ComplianceFramework;
  controlId: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  reference: string;
  /** Assessment rule IDs that provide technical evidence for this control area. */
  assessmentRules: string[];
}

const SOC2_REF = 'https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services';
const HIPAA_REF = 'https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html';
const PCI_REF = 'https://www.pcisecuritystandards.org/document_library/';

const ENCRYPTION_AT_REST = ['AWS-RDS-002', 'AWS-EC2-002', 'AWS-EBS-001', 'AWS-S3-002', 'AWS-EKS-002', 'AWS-ELC-002', 'AWS-SQS-001', 'AWS-DDB-001', 'AWS-KMS-001', 'AZ-SQL-002', 'AZ-VM-002', 'AZ-VMSS-001', 'AZ-KV-002'];
const ENCRYPTION_IN_TRANSIT = ['AWS-ELB-001', 'AWS-ELB-002', 'AWS-CF-001', 'AWS-ELC-001', 'AZ-STG-001', 'AZ-STG-003', 'AZ-SQL-005', 'AZ-APP-001', 'AZ-APP-002', 'AZ-APP-003', 'AZ-FUNC-001', 'AZ-FUNC-002', 'AZ-RED-001', 'AZ-RED-003', 'AZ-AFD-001'];
const NETWORK_BOUNDARY = ['AWS-SG-001', 'AWS-SG-002', 'AWS-NACL-001', 'AWS-RDS-001', 'AWS-S3-001', 'AWS-EC2-001', 'AWS-ECS-001', 'AWS-EKS-001', 'AWS-VPC-001', 'AZ-NSG-001', 'AZ-NSG-002', 'AZ-SQL-001', 'AZ-SQL-006', 'AZ-COS-001', 'AZ-STG-002', 'AZ-STG-004', 'AZ-KV-001', 'AZ-RED-002', 'AZ-AKS-002', 'AZ-VM-001', 'AZ-ARCH-001'];
const LOGGING = ['AWS-ACCT-001', 'AWS-S3-003', 'AWS-RDS-004', 'AWS-EKS-003', 'AWS-VPC-002', 'AZ-SQL-003', 'AZ-ACCT-002', 'AZ-ARCH-020'];
const MONITORING = ['AWS-ACCT-002', 'AWS-ARCH-003', 'AZ-SQL-004', 'AZ-ACCT-001'];
const BACKUP = ['AWS-RDS-007', 'AWS-S3-005', 'AWS-DDB-002', 'AWS-EBS-002', 'AWS-ELC-004', 'AZ-STG-005', 'AZ-SQL-011', 'AZ-VM-010'];
const PUBLIC_DATA_STORES = ['AWS-RDS-001', 'AWS-S3-001', 'AZ-SQL-001', 'AZ-COS-001', 'AZ-STG-002', 'AZ-RED-002'];
const EDGE_PROTECTION = ['AWS-ELB-003', 'AWS-CF-002', 'AWS-WAF-001', 'AZ-AGW-001', 'AZ-AFD-002', 'AZ-WAF-001'];
const PRIVILEGE = ['AWS-IAM-001', 'AWS-S3-004', 'AZ-AKS-001', 'AZ-KV-003'];
const STRONG_AUTH = ['AWS-ACCT-003', 'AZ-ACCT-003'];

export const soc2Rules: ComplianceRule[] = [
  { id: 'SOC2-CC6.1', framework: 'SOC2', controlId: 'CC6.1', title: 'Logical access security — protection of data at rest', description: 'Technical indicators relevant to logical access security over information assets, including encryption of stored data and least-privilege access.', severity: 'high', reference: SOC2_REF, assessmentRules: [...ENCRYPTION_AT_REST, ...PRIVILEGE] },
  { id: 'SOC2-CC6.6', framework: 'SOC2', controlId: 'CC6.6', title: 'Boundary protection against threats from outside system boundaries', description: 'Technical indicators for restricting access from untrusted networks (security groups/NSGs, public endpoints, edge protection).', severity: 'high', reference: SOC2_REF, assessmentRules: [...NETWORK_BOUNDARY, ...EDGE_PROTECTION] },
  { id: 'SOC2-CC6.7', framework: 'SOC2', controlId: 'CC6.7', title: 'Protection of information during transmission', description: 'Technical indicators for encryption in transit.', severity: 'high', reference: SOC2_REF, assessmentRules: ENCRYPTION_IN_TRANSIT },
  { id: 'SOC2-CC7.2', framework: 'SOC2', controlId: 'CC7.2', title: 'Monitoring of system components for anomalies', description: 'Technical indicators for logging, monitoring and threat detection.', severity: 'medium', reference: SOC2_REF, assessmentRules: [...LOGGING, ...MONITORING] },
  // Previously mapped to CC9.2 (vendor and business partner risk), which does not cover backups.
  { id: 'SOC2-A1.2', framework: 'SOC2', controlId: 'A1.2', title: 'Availability — data backup and recovery infrastructure', description: 'Technical indicators for backup configuration (Availability criteria).', severity: 'medium', reference: SOC2_REF, assessmentRules: BACKUP },
];

export const hipaaRules: ComplianceRule[] = [
  { id: 'HIPAA-164.312(a)(1)', framework: 'HIPAA', controlId: '164.312(a)(1)', title: 'Access control (technical safeguard)', description: 'Technical indicators that data stores holding ePHI are not publicly reachable and access is restricted.', severity: 'critical', reference: HIPAA_REF, assessmentRules: [...PUBLIC_DATA_STORES, ...PRIVILEGE] },
  { id: 'HIPAA-164.312(b)', framework: 'HIPAA', controlId: '164.312(b)', title: 'Audit controls', description: 'Technical indicators that activity is recorded (logging and audit trails).', severity: 'high', reference: HIPAA_REF, assessmentRules: LOGGING },
  { id: 'HIPAA-164.312(c)(1)', framework: 'HIPAA', controlId: '164.312(c)(1)', title: 'Integrity', description: 'Technical indicators protecting data from improper alteration or destruction (backups, versioning).', severity: 'high', reference: HIPAA_REF, assessmentRules: BACKUP },
  { id: 'HIPAA-164.312(e)(2)(ii)', framework: 'HIPAA', controlId: '164.312(e)(2)(ii)', title: 'Transmission security — encryption', description: 'Technical indicators for encryption of data in transit.', severity: 'high', reference: HIPAA_REF, assessmentRules: ENCRYPTION_IN_TRANSIT },
  { id: 'HIPAA-164.312(a)(2)(iv)', framework: 'HIPAA', controlId: '164.312(a)(2)(iv)', title: 'Encryption and decryption (data at rest)', description: 'Technical indicators for encryption of stored data.', severity: 'high', reference: HIPAA_REF, assessmentRules: ENCRYPTION_AT_REST },
];

// PCI DSS v4.0 requirement numbers. The previous mapping used 6.4.1 for public
// databases (6.4.x covers public-facing web application protection) and 1.2.1
// for inbound restriction (1.3.1 / 1.4.4 cover this in v4.0).
export const pciRules: ComplianceRule[] = [
  { id: 'PCI-DSS-1.3.1', framework: 'PCI-DSS', controlId: '1.3.1', title: 'Inbound traffic to the CDE is restricted', description: 'Technical indicators that inbound network access is restricted to necessary traffic.', severity: 'critical', reference: PCI_REF, assessmentRules: NETWORK_BOUNDARY },
  { id: 'PCI-DSS-1.4.4', framework: 'PCI-DSS', controlId: '1.4.4', title: 'Stored account data is not directly accessible from untrusted networks', description: 'Technical indicators that data stores are not publicly reachable.', severity: 'critical', reference: PCI_REF, assessmentRules: PUBLIC_DATA_STORES },
  { id: 'PCI-DSS-3.5.1', framework: 'PCI-DSS', controlId: '3.5.1', title: 'Stored account data is rendered unreadable', description: 'Technical indicators for encryption of stored data (storage-level encryption alone may not satisfy 3.5.1 — assessor determination required).', severity: 'high', reference: PCI_REF, assessmentRules: ENCRYPTION_AT_REST },
  { id: 'PCI-DSS-4.2.1', framework: 'PCI-DSS', controlId: '4.2.1', title: 'Strong cryptography during transmission over open, public networks', description: 'Technical indicators for encryption in transit.', severity: 'high', reference: PCI_REF, assessmentRules: ENCRYPTION_IN_TRANSIT },
  { id: 'PCI-DSS-6.4.2', framework: 'PCI-DSS', controlId: '6.4.2', title: 'Automated technical solution protects public-facing web applications', description: 'Technical indicators for web application firewall coverage.', severity: 'high', reference: PCI_REF, assessmentRules: EDGE_PROTECTION },
  { id: 'PCI-DSS-8.4.2', framework: 'PCI-DSS', controlId: '8.4.2', title: 'MFA for all access into the CDE', description: 'Multi-factor authentication is configured in the identity provider, which an architecture design cannot show.', severity: 'high', reference: PCI_REF, assessmentRules: STRONG_AUTH },
  { id: 'PCI-DSS-10.2.1', framework: 'PCI-DSS', controlId: '10.2.1', title: 'Audit logs are enabled and active', description: 'Technical indicators for audit logging.', severity: 'high', reference: PCI_REF, assessmentRules: LOGGING },
];
