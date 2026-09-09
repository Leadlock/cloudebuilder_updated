/**
 * Azure Security Rules for Phase 2D.
 *
 * Rules are deterministic — same resource config → same findings.
 * We only fire when there is sufficient evidence in the persisted config.
 */
import type { SecurityRule } from './types';

// ─── Rules ────────────────────────────────────────────────────────────────────

export const azureSecurityRules: SecurityRule[] = [

  // ── Storage ────────────────────────────────────────────────────────────────

  {
    ruleId: 'AZ-STORAGE-NO-HTTPS',
    severity: 'high',
    title: 'Azure Storage Account allows HTTP traffic',
    description: 'The storage account has httpsOnly set to false, allowing data to be transferred over unencrypted HTTP connections.',
    remediation: 'Enable the "Secure transfer required" setting (enable_https_traffic_only = true) on the storage account to enforce HTTPS-only connections.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_storage') return null;
      if (config['httpsOnly'] !== false) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'azure', resourceType: resource.resourceType,
        meta: { httpsOnly: config['httpsOnly'] },
      };
    },
  },

  {
    ruleId: 'AZ-STORAGE-PUBLIC-BLOB',
    severity: 'critical',
    title: 'Azure Storage Account allows public blob access',
    description: 'The storage account has anonymous public blob access enabled. Any blob container set to public access can be read without authentication.',
    remediation: 'Disable public blob access by setting allowBlobPublicAccess to false on the storage account.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_storage') return null;
      if (config['allowBlobPublicAccess'] !== true) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'azure', resourceType: resource.resourceType,
        meta: { allowBlobPublicAccess: config['allowBlobPublicAccess'] },
      };
    },
  },

  // ── SQL Database ───────────────────────────────────────────────────────────

  {
    ruleId: 'AZ-SQL-PUBLIC-ACCESS',
    severity: 'critical',
    title: 'Azure SQL Server has public access enabled',
    description: 'The Azure SQL Server allows public network access, making it reachable from the internet.',
    remediation: 'Disable public_network_access_enabled on the SQL Server and use private endpoints or VNet service endpoints for access.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_sql') return null;
      if (config['publicNetworkAccess'] !== true) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'azure', resourceType: resource.resourceType,
        meta: { publicNetworkAccess: config['publicNetworkAccess'] },
      };
    },
  },

  {
    ruleId: 'AZ-SQL-NO-TDE',
    severity: 'high',
    title: 'Azure SQL Database Transparent Data Encryption disabled',
    description: 'Transparent Data Encryption (TDE) is not enabled on the SQL database, leaving data at rest unprotected.',
    remediation: 'Enable TDE on the Azure SQL database. TDE is enabled by default in recent API versions, but older configurations may have it disabled.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_sql') return null;
      if (config['transparentDataEncryption'] !== false) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'azure', resourceType: resource.resourceType,
        meta: { transparentDataEncryption: config['transparentDataEncryption'] },
      };
    },
  },

  // ── Network Security ───────────────────────────────────────────────────────

  {
    ruleId: 'AZ-NSG-OPEN-SSH',
    severity: 'high',
    title: 'Azure NSG allows unrestricted SSH access (port 22)',
    description: 'The Network Security Group has an inbound rule allowing SSH (port 22) from any source (0.0.0.0/0).',
    remediation: 'Restrict SSH ingress to known management IP addresses or use Azure Bastion for secure administrative access without exposing port 22.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_nsg') return null;
      if (config['allowSsh'] !== true) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'azure', resourceType: resource.resourceType,
        meta: { allowSsh: config['allowSsh'] },
      };
    },
  },

  {
    ruleId: 'AZ-NSG-OPEN-RDP',
    severity: 'critical',
    title: 'Azure NSG allows unrestricted RDP access (port 3389)',
    description: 'The Network Security Group allows inbound RDP (port 3389) from any IP address. This is a very high-risk configuration commonly exploited by attackers.',
    remediation: 'Immediately remove the unrestricted RDP rule. Use Azure Bastion, VPN, or IP whitelisting for remote desktop access.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_nsg') return null;
      if (config['allowRdp'] !== true) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'azure', resourceType: resource.resourceType,
        meta: { allowRdp: config['allowRdp'] },
      };
    },
  },

  // ── VM ─────────────────────────────────────────────────────────────────────

  {
    ruleId: 'AZ-VM-NO-DISK-ENCRYPTION',
    severity: 'high',
    title: 'Azure VM OS disk encryption disabled',
    description: 'The Azure Virtual Machine OS disk does not have encryption enabled, leaving operating system and application data at rest unprotected.',
    remediation: 'Enable Azure Disk Encryption (ADE) or server-side encryption with customer-managed keys on the VM disk.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_vm') return null;
      if (config['diskEncryption'] !== false) return null;
      return {
        ruleId: this.ruleId, severity: this.severity, title: this.title,
        description: this.description, remediation: this.remediation,
        resourceId: resource.id, provider: 'azure', resourceType: resource.resourceType,
        meta: { diskEncryption: config['diskEncryption'] },
      };
    },
  },
];
