/**
 * Where the evidence for a control can come from — and why a control is reported as
 * NOT EVALUATED when that evidence is not available to the assessment.
 *
 *  - DESIGN_TIME_SUPPORTED: the architecture model can hold the evidence (evaluated when modelled).
 *  - DISCOVERY_SUPPORTED: a resource-level provider API returns it; CloudCraft discovery does
 *    not collect it yet.
 *  - ACCOUNT_API_REQUIRED: account / subscription / tenant APIs (not resource configuration).
 *  - ORGANIZATIONAL_EVIDENCE_REQUIRED: depends on processes and people, not configuration.
 *  - NOT_SUPPORTED: CloudCraft cannot evaluate this control and should not claim to.
 *
 * Every rule that can return NOT_EVALUATED must have an entry (enforced by tests).
 */
export type EvidenceAvailabilityClass =
  | 'DESIGN_TIME_SUPPORTED'
  | 'DISCOVERY_SUPPORTED'
  | 'ACCOUNT_API_REQUIRED'
  | 'ORGANIZATIONAL_EVIDENCE_REQUIRED'
  | 'NOT_SUPPORTED';

export interface EvidenceAvailability {
  classes: EvidenceAvailabilityClass[];
  /** Plain-language reason, shown in reports next to NOT EVALUATED controls. */
  explanation: string;
  /** The provider APIs or evidence that would allow evaluation. */
  evidenceSource: string;
}

export const EVIDENCE_AVAILABILITY: Record<string, EvidenceAvailability> = {
  'AWS-VPC-002': {
    classes: ['DESIGN_TIME_SUPPORTED', 'DISCOVERY_SUPPORTED'],
    explanation: 'Flow logs are modelled as VPC settings (enabled, S3 bucket, traffic type) and emitted in Terraform. An imported VPC stays not evaluated until the setting is known, because discovery does not yet call DescribeFlowLogs.',
    evidenceSource: 'ec2:DescribeFlowLogs (ResourceId = VPC ID).',
  },
  'AWS-SG-003': {
    classes: ['DESIGN_TIME_SUPPORTED'],
    explanation: 'Not evaluated only when no security groups are modelled; add security groups to the design (or import them) and AWS-SG-001/002 evaluate their rules.',
    evidenceSource: 'Security group resources in the architecture, or ec2:DescribeSecurityGroups via discovery.',
  },
  'AWS-ACCT-001': {
    classes: ['ACCOUNT_API_REQUIRED'],
    explanation: 'CloudTrail is configured per account/organization, not on the resources in the diagram.',
    evidenceSource: 'cloudtrail:DescribeTrails and cloudtrail:GetTrailStatus in each Region.',
  },
  'AWS-ACCT-002': {
    classes: ['ACCOUNT_API_REQUIRED'],
    explanation: 'GuardDuty is enabled per account and Region.',
    evidenceSource: 'guardduty:ListDetectors / GetDetector in each Region.',
  },
  'AWS-ACCT-003': {
    classes: ['ACCOUNT_API_REQUIRED', 'ORGANIZATIONAL_EVIDENCE_REQUIRED'],
    explanation: 'Root-user MFA is an account setting; custody of the root credentials and MFA device is an organizational control.',
    evidenceSource: 'iam:GetAccountSummary (AccountMFAEnabled); root credential custody procedures.',
  },
  'AWS-ACCT-004': {
    classes: ['ACCOUNT_API_REQUIRED'],
    explanation: 'AWS Config recording is an account/Region setting.',
    evidenceSource: 'config:DescribeConfigurationRecorders and DescribeConfigurationRecorderStatus.',
  },
  'AZ-VM-010': {
    classes: ['DISCOVERY_SUPPORTED'],
    explanation: 'Backup protection is recorded in a Recovery Services vault, not on the VM; CloudCraft does not model vaults and discovery does not query protected items.',
    evidenceSource: 'Recovery Services protected items (Microsoft.RecoveryServices/vaults/backupProtectedItems).',
  },
  'AZ-ARCH-020': {
    classes: ['DISCOVERY_SUPPORTED'],
    explanation: 'Diagnostic settings and alert rules are separate Azure Monitor resources that CloudCraft does not model or discover.',
    evidenceSource: 'Microsoft.Insights/diagnosticSettings per resource; Microsoft.Insights/metricAlerts and scheduledQueryRules.',
  },
  'AZ-ACCT-001': {
    classes: ['ACCOUNT_API_REQUIRED'],
    explanation: 'Defender for Cloud plans are enabled per subscription.',
    evidenceSource: 'Microsoft.Security/pricings (subscription scope).',
  },
  'AZ-ACCT-002': {
    classes: ['ACCOUNT_API_REQUIRED'],
    explanation: 'Activity log export is a subscription-level diagnostic setting.',
    evidenceSource: 'Microsoft.Insights/diagnosticSettings at subscription scope.',
  },
  'AZ-ACCT-003': {
    classes: ['ACCOUNT_API_REQUIRED', 'ORGANIZATIONAL_EVIDENCE_REQUIRED'],
    explanation: 'MFA and Conditional Access are Microsoft Entra ID tenant policies; enrolment and exception handling are organizational processes.',
    evidenceSource: 'Microsoft Graph conditional access policies and authentication methods reports.',
  },
};

export const EVIDENCE_CLASS_LABEL: Record<EvidenceAvailabilityClass, string> = {
  DESIGN_TIME_SUPPORTED: 'Design-time supported',
  DISCOVERY_SUPPORTED: 'Discovery supported (not collected yet)',
  ACCOUNT_API_REQUIRED: 'Account-level API required',
  ORGANIZATIONAL_EVIDENCE_REQUIRED: 'Organizational evidence required',
  NOT_SUPPORTED: 'Not supported',
};
