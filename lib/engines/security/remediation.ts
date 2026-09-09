/**
 * Security Rule Remediation mappings for Phase 2D and legacy rule IDs.
 *
 * Deterministic mapping from rule ID to the config patch that fixes the finding.
 * When applied, the security rule check returns null (finding resolved).
 */

export const RULE_REMEDIATIONS: Record<string, Record<string, unknown>> = {
  // Phase 2D AWS
  'AWS-S3-PUBLIC': { publicAccess: false },
  'AWS-S3-NO-ENCRYPTION': { encryption: true },
  'AWS-S3-NO-PUBLIC-BLOCK': { blockPublicAccess: true },
  'AWS-RDS-NO-ENCRYPTION': { encrypted: true },
  'AWS-RDS-PUBLICLY-ACCESSIBLE': { publiclyAccessible: false },
  'AWS-RDS-NO-MULTI-AZ': { multiAz: true },
  'AWS-SG-OPEN-SSH': { allowSsh: false },
  'AWS-EC2-PUBLIC-SUBNET': { mapPublicIpOnLaunch: false },
  'AWS-VPC-NO-DNS': { enableDnsSupport: true },

  // Phase 2D Azure
  'AZ-STORAGE-NO-HTTPS': { httpsOnly: true },
  'AZ-STORAGE-PUBLIC-BLOB': { allowBlobPublicAccess: false },
  'AZ-SQL-PUBLIC-ACCESS': { publicNetworkAccess: false },
  'AZ-SQL-NO-TDE': { transparentDataEncryption: true },
  'AZ-NSG-OPEN-SSH': { allowSsh: false },
  'AZ-NSG-OPEN-RDP': { allowRdp: false },
  'AZ-VM-NO-DISK-ENCRYPTION': { diskEncryption: true },

  // Legacy rule IDs (backward compatibility)
  's3-encryption': { encryption: true },
  's3-public': { publicAccess: false },
  'rds-encryption': { encrypted: true },
  'rds-multi-az': { multiAz: true },
  'sg-open-ssh': { allowSsh: false },
  'nsg-open-ssh': { allowSsh: false },
  'nsg-open-rdp': { allowRdp: false },
  'storage-https': { httpsOnly: true },
  'vpc-dns': { enableDnsSupport: true },
  'subnet-public-ip': { mapPublicIpOnLaunch: false },
};

/** Check whether a rule ID can be automatically remediated */
export function isRuleFixable(ruleId: string): boolean {
  return ruleId in RULE_REMEDIATIONS;
}

/** Apply the remediation patch for a given rule ID to a resource config */
export function applyRuleRemediation(
  config: Record<string, unknown>,
  ruleId: string,
): Record<string, unknown> {
  const patch = RULE_REMEDIATIONS[ruleId];
  if (!patch) return config;
  return { ...config, ...patch };
}
