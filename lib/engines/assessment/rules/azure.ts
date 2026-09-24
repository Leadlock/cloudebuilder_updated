/**
 * Azure provider-native assessment rules.
 *
 * Mapped to the Microsoft cloud security benchmark (MCSB) and the Azure Policy
 * built-in definitions Microsoft uses to implement it, and to the five Azure
 * Well-Architected pillars (Reliability, Security, Cost Optimization,
 * Operational Excellence, Performance Efficiency) — NOT to AWS terminology.
 *
 * Rules read the same configuration keys as lib/resources/azure.ts and the
 * Terraform generator (azurerm ~> 3.0).
 */
import type { AssessResource, RuleDefinition } from '../types';
import { REVIEWED, configEvaluator, ev, notModelled, rule, isAzureAnySource, fmt } from '../ruleHelpers';

const V = '1.0.0';
const deployed = (r: AssessResource) => ['imported', 'cloudcraft-managed', 'modified'].includes(String(r.importState ?? ''));
const TF = 'TF-AZURERM';

const WA = {
  sec: (practice: string) => ({ pillar: 'security' as const, practice }),
  rel: (practice: string) => ({ pillar: 'reliability' as const, practice }),
  ops: (practice: string) => ({ pillar: 'operational_excellence' as const, practice }),
  perf: (practice: string) => ({ pillar: 'performance_efficiency' as const, practice }),
  cost: (practice: string) => ({ pillar: 'cost_optimization' as const, practice }),
};

const common = { version: V, lastReviewed: REVIEWED, provider: 'azure' as const };
const TLS_OLD = new Set(['1.0', '1.1', 'TLS1_0', 'TLS1_1']);

export const azureRules: RuleDefinition[] = [
  // ════════════════════════════════════════════════════════════════════════
  // Storage accounts
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-STG-001', service: 'Azure Storage', scope: 'resource', resourceTypes: ['azure_storage'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'Storage account does not require secure transfer',
    description: '"Secure transfer required" is disabled, so the account accepts HTTP and unencrypted SMB requests.',
    rationale: 'MCSB DP-3; Azure Policy "secure transfer to storage accounts" (404c3081…).',
    risk: 'Data and shared-key/SAS credentials can be intercepted in transit.', impact: 'Data disclosure and credential theft.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-3', 'AZPOLICY-storage-secure-transfer', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Enable "Secure transfer required".', manualSteps: ['Enable secure transfer required on the storage account.'], terraform: 'azurerm_storage_account.enable_https_traffic_only = true (https_traffic_only_enabled in azurerm 4.x)' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'HTTPS is supported by all Azure Storage SDKs; only plaintext HTTP clients are affected.',
      description: 'Require secure transfer (HTTPS only).', patch: () => ({ httpsOnly: true }),
      architectureImpact: 'HTTP requests are rejected.', costImpact: 'NONE', terraformExpect: /enable_https_traffic_only\s*=\s*true/,
    },
    evaluate: configEvaluator(['httpsOnly'], { httpsOnly: 'Enabled / Yes' }, (c) => c.httpsOnly === false
      ? { status: 'FAIL', observation: 'Secure transfer is not required (HTTP allowed).' }
      : { status: 'PASS', observation: 'Secure transfer is required.' }),
  }),
  rule({
    ...common,
    id: 'AZ-STG-002', service: 'Azure Storage', scope: 'resource', resourceTypes: ['azure_storage'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'Storage account allows anonymous blob access',
    description: '"Allow Blob anonymous access" is enabled, so any container can be configured for anonymous public read access.',
    rationale: 'MCSB NS-2; Azure Policy "Storage account public access should be disallowed" (4fa4b6c0…). The setting permits — but does not by itself create — public containers, so it is HIGH rather than CRITICAL.',
    risk: 'A single container ACL change exposes data to the internet without authentication.', impact: 'Data disclosure.',
    wellArchitected: WA.sec('SE:06 — Network controls / SE:05 — Access'),
    references: ['MCSB-NS-2', 'AZPOLICY-storage-public-access', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01', 'SOC1-DP-01'],
    remediation: { recommendation: 'Disallow anonymous blob access; serve public content through Azure Front Door/CDN with a private origin or SAS.', manualSteps: ['Confirm no container intentionally serves anonymous content.', 'Disable anonymous blob access.'], terraform: 'azurerm_storage_account.allow_nested_items_to_be_public = false' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Breaks any static website or consumer relying on anonymous container access.',
      description: 'Disallow anonymous blob access.', patch: () => ({ allowBlobPublicAccess: false }),
      architectureImpact: 'Anonymous reads stop; authenticated access is unaffected.', costImpact: 'NONE', terraformExpect: /allow_nested_items_to_be_public\s*=\s*false/,
    },
    evaluate: configEvaluator(['allowBlobPublicAccess'], { allowBlobPublicAccess: 'Disabled / No' }, (c) => c.allowBlobPublicAccess === true
      ? { status: 'FAIL', observation: 'Anonymous blob access is allowed.' }
      : { status: 'PASS', observation: 'Anonymous blob access is disallowed.' }),
  }),
  rule({
    ...common,
    id: 'AZ-STG-003', service: 'Azure Storage', scope: 'resource', resourceTypes: ['azure_storage'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Storage account permits TLS versions older than 1.2',
    description: 'The minimum TLS version is 1.0 or 1.1.',
    rationale: 'MCSB DP-3 (encrypt data in transit with current protocols).',
    risk: 'Clients can negotiate deprecated TLS versions.', impact: 'Weaker transport encryption.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-3', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Set the minimum TLS version to TLS 1.2.', manualSteps: ['Identify clients still using TLS 1.0/1.1.', 'Set minimum TLS version to 1.2.'], terraform: 'azurerm_storage_account.min_tls_version = "TLS1_2"' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Legacy clients that only support TLS 1.0/1.1 will fail to connect.',
      description: 'Set minimum TLS to 1.2.', patch: () => ({ minimumTlsVersion: 'TLS1_2' }),
      architectureImpact: 'TLS < 1.2 connections are refused.', costImpact: 'NONE', terraformExpect: /min_tls_version\s*=\s*"TLS1_2"/,
    },
    evaluate: configEvaluator(['minimumTlsVersion'], { minimumTlsVersion: 'TLS1_2' }, (c) => TLS_OLD.has(String(c.minimumTlsVersion))
      ? { status: 'FAIL', observation: `Minimum TLS version is ${c.minimumTlsVersion}.` }
      : { status: 'PASS', observation: `Minimum TLS version is ${c.minimumTlsVersion}.` }),
  }),
  rule({
    ...common,
    id: 'AZ-STG-004', service: 'Azure Storage', scope: 'resource', resourceTypes: ['azure_storage'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Storage account network access is unrestricted',
    description: 'The storage firewall default action is "Allow", so the account endpoint accepts connections from all networks.',
    rationale: 'MCSB NS-2; Azure Policy "Storage accounts should restrict network access" (34c877ad…).',
    risk: 'The data plane endpoint is reachable from any network; only authentication protects it.', impact: 'Exposure to credential misuse from anywhere.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZPOLICY-storage-network-restrict', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Set the default action to Deny and allow access through private endpoints, virtual network rules or trusted IP ranges.', manualSteps: ['Add private endpoints or VNet rules for legitimate clients.', 'Set the firewall default action to Deny.'], terraform: 'azurerm_storage_account.network_rules { default_action = "Deny" }' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Clients without a private endpoint, VNet rule or IP rule lose access immediately.',
      description: 'Set the storage firewall default action to Deny.', patch: () => ({ networkDefaultAction: 'Deny' }),
      architectureImpact: 'Only explicitly allowed networks can reach the account.', costImpact: 'NONE', terraformExpect: /default_action\s*=\s*"Deny"/,
    },
    evaluate: configEvaluator(['networkDefaultAction'], { networkDefaultAction: 'Deny' }, (c) => c.networkDefaultAction === 'Allow'
      ? { status: 'FAIL', observation: 'Network default action is Allow (all networks).' }
      : { status: 'PASS', observation: 'Network default action is Deny.' }),
  }),
  rule({
    ...common,
    id: 'AZ-STG-005', service: 'Azure Storage', scope: 'resource', resourceTypes: ['azure_storage'],
    domain: 'RELIABILITY', category: 'Data protection', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Blob soft delete is disabled',
    description: 'Deleted blobs are not retained for recovery.',
    rationale: 'Azure Well-Architected Reliability data-protection guidance for Blob Storage.',
    risk: 'Accidental or malicious deletion is unrecoverable.', impact: 'Data loss.',
    wellArchitected: WA.rel('RE:09 — Business continuity and disaster recovery'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-03'],
    remediation: { recommendation: 'Enable blob soft delete (e.g. 7 days) and consider blob versioning.', manualSteps: ['Enable blob soft delete with a retention period.'], terraform: 'blob_properties { delete_retention_policy { days = 7 } }' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Additive: deleted blobs are retained for the retention period.',
      description: 'Enable blob soft delete for 7 days.', patch: () => ({ blobSoftDeleteRetentionDays: 7 }),
      architectureImpact: 'Deleted blobs retained for 7 days.', costImpact: 'POSSIBLE_INCREASE', terraformExpect: /days\s*=\s*7/,
    },
    evaluate: configEvaluator(['blobSoftDeleteRetentionDays'], { blobSoftDeleteRetentionDays: '1 or more days' }, (c) => Number(c.blobSoftDeleteRetentionDays) > 0
      ? { status: 'PASS', observation: `Blob soft delete retains data for ${c.blobSoftDeleteRetentionDays} days.` }
      : { status: 'FAIL', observation: 'Blob soft delete is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-STG-006', service: 'Azure Storage', scope: 'resource', resourceTypes: ['azure_storage'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Storage account uses locally-redundant storage (LRS)',
    description: 'LRS keeps three copies within a single datacenter.',
    rationale: 'Azure Well-Architected Reliability guidance recommends zone-redundant (ZRS) or geo-redundant replication for production data.',
    risk: 'A datacenter or zone failure makes the data unavailable.', impact: 'Outage or data loss during zonal incidents.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Use ZRS (or GZRS/RA-GZRS for regional DR) for production data.', manualSteps: ['Confirm ZRS availability in the region.', 'Convert the account replication type.'] },
    autoFix: {
      safety: (r) => (String(r.config.sku ?? '').startsWith('Premium') ? 'MANUAL_ONLY' : 'REVIEW_REQUIRED'),
      safetyReason: (r) => String(r.config.sku ?? '').startsWith('Premium') ? 'Premium account conversion options differ by account kind.' : 'Higher storage cost; conversion of an existing account is an asynchronous migration.',
      description: 'Change replication to Standard_ZRS.', patch: () => ({ sku: 'Standard_ZRS' }),
      architectureImpact: 'Data replicated across availability zones.', costImpact: 'POSSIBLE_INCREASE', terraformExpect: /account_replication_type\s*=\s*"ZRS"/,
    },
    evaluate: configEvaluator(['sku'], { sku: 'ZRS / GRS / GZRS' }, (c) => String(c.sku).endsWith('_LRS')
      ? { status: 'WARNING', observation: `Replication is ${c.sku}.` }
      : { status: 'PASS', observation: `Replication is ${c.sku}.` }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Azure SQL
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-SQL-001', service: 'Azure SQL Database', scope: 'resource', resourceTypes: ['azure_sql'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'Azure SQL logical server allows public network access',
    description: 'Public network access is enabled on the logical server.',
    rationale: 'MCSB NS-2; Azure Policy "Public network access on Azure SQL Database should be disabled" (1b8ca024…). Rated HIGH (not CRITICAL) because the server firewall still applies; it becomes CRITICAL in practice when broad firewall rules exist, which CloudCraft does not model.',
    risk: 'The database endpoint is reachable from the internet, subject only to firewall rules and authentication.', impact: 'Unauthorized data access.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZPOLICY-sql-public-access', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Disable public network access and connect through a private endpoint.', manualSteps: ['Create a private endpoint in the application VNet.', 'Disable public network access.'], terraform: 'azurerm_mssql_server.public_network_access_enabled = false' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Clients connecting over the public endpoint lose access unless a private endpoint exists.',
      description: 'Disable public network access.', patch: () => ({ publicNetworkAccess: false }),
      architectureImpact: 'Only private endpoint connections are accepted.', costImpact: 'NONE', terraformExpect: /public_network_access_enabled\s*=\s*false/,
    },
    evaluate: configEvaluator(['publicNetworkAccess'], { publicNetworkAccess: 'Disabled / No' }, (c) => c.publicNetworkAccess === true
      ? { status: 'FAIL', observation: 'Public network access is enabled.' }
      : { status: 'PASS', observation: 'Public network access is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-SQL-002', service: 'Azure SQL Database', scope: 'resource', resourceTypes: ['azure_sql'],
    domain: 'SECURITY', category: 'Encryption at rest', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'Transparent Data Encryption is disabled',
    description: 'TDE is disabled, so the database, backups and transaction logs are not encrypted at rest.',
    rationale: 'MCSB DP-4; Azure Policy "Transparent Data Encryption on SQL databases should be enabled" (17k78e20…).',
    risk: 'Database files and backups are unencrypted.', impact: 'Data disclosure from storage or backups.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-4', 'AZPOLICY-sql-tde', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-01'],
    remediation: { recommendation: 'Enable TDE (service-managed or customer-managed key).', manualSteps: ['Enable Transparent Data Encryption on the database.'], terraform: 'azurerm_mssql_database.transparent_data_encryption_enabled = true' },
    autoFix: {
      safety: (r) => (deployed(r) ? 'REVIEW_REQUIRED' : 'SAFE_AUTOFIX'),
      safetyReason: (r) => deployed(r) ? 'Enabling TDE on an existing database runs an online background encryption scan that consumes resources.' : 'Not yet deployed: TDE is on from creation.',
      description: 'Enable Transparent Data Encryption.', patch: () => ({ transparentDataEncryptionEnabled: true }),
      architectureImpact: 'Database encrypted at rest.', costImpact: 'NONE', terraformExpect: /transparent_data_encryption_enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['transparentDataEncryptionEnabled'], { transparentDataEncryptionEnabled: 'Enabled / Yes' }, (c) => c.transparentDataEncryptionEnabled === false
      ? { status: 'FAIL', observation: 'TDE is disabled.' }
      : { status: 'PASS', observation: 'TDE is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-SQL-003', service: 'Azure SQL Database', scope: 'resource', resourceTypes: ['azure_sql'],
    domain: 'SECURITY', category: 'Logging & audit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Azure SQL auditing is disabled',
    description: 'Server auditing is not enabled.',
    rationale: 'MCSB LT-3; Azure Policy "Auditing on SQL server should be enabled" (a6fb4358…).',
    risk: 'Database access and changes are not recorded.', impact: 'No audit trail for data access.',
    wellArchitected: WA.sec('SE:10 — Monitoring and threat detection'),
    references: ['MCSB-LT-3', 'AZPOLICY-sql-auditing', 'AZ-WA-security'],
    soc1: ['SOC1-OP-01'],
    remediation: { recommendation: 'Enable server auditing to a Log Analytics workspace or storage account with appropriate retention.', manualSteps: ['Create/choose a Log Analytics workspace.', 'Enable auditing on the logical server.'] },
    autoFix: {
      safety: 'MANUAL_ONLY', safetyReason: 'Auditing needs a destination workspace/storage account; the CloudCraft Terraform generator does not yet emit the extended auditing policy.',
      description: 'Manual: configure auditing destination.', patch: () => ({}), architectureImpact: 'Adds audit log destination.', costImpact: 'POSSIBLE_INCREASE',
    },
    evaluate: configEvaluator(['auditingEnabled'], { auditingEnabled: 'Enabled / Yes' }, (c) => c.auditingEnabled === true
      ? { status: 'PASS', observation: 'Auditing is enabled in the design (destination must be connected for Terraform to emit it).' }
      : { status: 'FAIL', observation: 'Auditing is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-SQL-004', service: 'Azure SQL Database', scope: 'resource', resourceTypes: ['azure_sql'],
    domain: 'SECURITY', category: 'Threat detection', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Microsoft Defender for SQL threat detection is disabled',
    description: 'Threat detection (security alert policy) is not enabled on the logical server.',
    rationale: 'MCSB LT-1; Azure Policy for Defender for SQL on servers (abfb4388…).',
    risk: 'SQL injection, anomalous access and brute force attempts are not alerted.', impact: 'Delayed detection of database attacks.',
    wellArchitected: WA.sec('SE:10 — Monitoring and threat detection'),
    references: ['MCSB-LT-1', 'AZPOLICY-sql-defender', 'AZ-WA-security', TF],
    soc1: ['SOC1-OP-02'],
    remediation: { recommendation: 'Enable Microsoft Defender for SQL (security alert policy) on the logical server.', manualSteps: ['Enable Defender for SQL.', 'Route alerts to the security operations team.'], terraform: 'azurerm_mssql_server_security_alert_policy { state = "Enabled" }' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Microsoft Defender for SQL is a paid plan.',
      description: 'Enable the SQL server security alert policy.', patch: () => ({ threatDetectionEnabled: true }),
      architectureImpact: 'Threat alerts are generated for the server.', costImpact: 'POSSIBLE_INCREASE', terraformExpect: /azurerm_mssql_server_security_alert_policy/,
    },
    evaluate: configEvaluator(['threatDetectionEnabled'], { threatDetectionEnabled: 'Enabled / Yes' }, (c) => c.threatDetectionEnabled === true
      ? { status: 'PASS', observation: 'Threat detection is enabled.' }
      : { status: 'FAIL', observation: 'Threat detection is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-SQL-005', service: 'Azure SQL Database', scope: 'resource', resourceTypes: ['azure_sql'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Azure SQL permits TLS versions older than 1.2',
    description: 'The minimum TLS version of the logical server is 1.0 or 1.1.',
    rationale: 'MCSB DP-3; Azure Policy "Azure SQL Database should be running TLS version 1.2 or newer" (32e6bbec…).',
    risk: 'Clients can negotiate deprecated TLS.', impact: 'Weaker transport encryption.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-3', 'AZPOLICY-sql-tls', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Set minimum TLS to 1.2.', manualSteps: ['Set the server minimum TLS version to 1.2.'], terraform: 'azurerm_mssql_server.minimum_tls_version = "1.2"' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Legacy drivers that only support TLS 1.0/1.1 will fail to connect.',
      description: 'Set minimum TLS to 1.2.', patch: () => ({ minimumTlsVersion: '1.2' }), architectureImpact: 'TLS < 1.2 connections refused.', costImpact: 'NONE',
      terraformExpect: /minimum_tls_version\s*=\s*"1\.2"/,
    },
    evaluate: configEvaluator(['minimumTlsVersion'], { minimumTlsVersion: '1.2' }, (c) => TLS_OLD.has(String(c.minimumTlsVersion))
      ? { status: 'FAIL', observation: `Minimum TLS version is ${c.minimumTlsVersion}.` }
      : { status: 'PASS', observation: `Minimum TLS version is ${c.minimumTlsVersion}.` }),
  }),
  rule({
    ...common,
    id: 'AZ-SQL-006', service: 'Azure SQL Database', scope: 'resource', resourceTypes: ['azure_sql'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: '"Allow Azure services" firewall exception is enabled on a public SQL server',
    description: 'The AllowAllWindowsAzureIps firewall rule (0.0.0.0) admits connections from any Azure-hosted address, including other customers\' resources.',
    rationale: 'MCSB NS-2 (restrict access to trusted networks). Only evaluated when public network access is enabled.',
    risk: 'Any workload running in Azure can reach the server endpoint.', impact: 'Wider attack surface than intended.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Remove the Azure-services exception; use private endpoints or specific firewall/VNet rules.', manualSteps: ['Disable "Allow Azure services and resources to access this server".'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Azure services (e.g. App Service without VNet integration) that rely on the exception lose access.',
      description: 'Disable the Allow Azure services exception.', patch: () => ({ allowAzureServices: false }),
      architectureImpact: 'Azure-hosted clients need explicit rules or private endpoints.', costImpact: 'NONE',
    },
    evaluate: configEvaluator(['publicNetworkAccess', 'allowAzureServices'], { allowAzureServices: 'Disabled / No' }, (c) => {
      if (c.publicNetworkAccess !== true) return { status: 'NOT_APPLICABLE', observation: 'Public network access is disabled, so the exception has no effect.' };
      return c.allowAzureServices === true ? { status: 'FAIL', observation: 'Public server with the Allow Azure services exception enabled.' } : { status: 'PASS', observation: 'The Allow Azure services exception is disabled.' };
    }),
  }),
  rule({
    ...common,
    id: 'AZ-SQL-010', service: 'Azure SQL Database', scope: 'resource', resourceTypes: ['azure_sql'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Azure SQL database is not zone-redundant',
    description: 'Zone redundancy is disabled on a service tier that supports it.',
    rationale: 'Azure Well-Architected Reliability (redundancy). Not applicable to Basic/Standard (DTU) tiers, which do not offer zone redundancy.',
    risk: 'A zonal failure makes the database unavailable.', impact: 'Outage during zone incidents.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Enable zone redundancy for production databases on Premium, Business Critical or General Purpose tiers.', manualSteps: ['Confirm region zone support.', 'Enable zone redundancy.'], terraform: 'azurerm_mssql_database.zone_redundant = true' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Increases cost and is only available in regions with availability zones.',
      description: 'Enable zone redundancy.', patch: () => ({ zoneRedundant: true }), architectureImpact: 'Replicas spread across zones.', costImpact: 'POSSIBLE_INCREASE',
      terraformExpect: /zone_redundant\s*=\s*true/,
    },
    evaluate: configEvaluator(['tier', 'zoneRedundant'], {}, (c) => {
      const tier = String(c.tier);
      if (tier === 'Basic' || tier === 'Standard') return { status: 'NOT_APPLICABLE', observation: `The ${tier} (DTU) tier does not offer zone redundancy.` };
      return c.zoneRedundant === true ? { status: 'PASS', observation: 'Zone redundancy is enabled.' } : { status: 'FAIL', observation: `Zone redundancy is disabled on the ${tier} tier.` };
    }),
  }),
  rule({
    ...common,
    id: 'AZ-SQL-011', service: 'Azure SQL Database', scope: 'resource', resourceTypes: ['azure_sql'],
    domain: 'RELIABILITY', category: 'Data protection', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Azure SQL backups use locally-redundant storage',
    description: 'Backup storage redundancy is Local.',
    rationale: 'Azure Well-Architected Reliability (BCDR): geo- or zone-redundant backup storage protects restores from regional/zonal loss.',
    risk: 'Backups are lost with the datacenter/region.', impact: 'Inability to restore after a regional incident.',
    wellArchitected: WA.rel('RE:09 — Business continuity and disaster recovery'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-03'],
    remediation: { recommendation: 'Use Geo or GeoZone backup storage redundancy unless data residency forbids it.', manualSteps: ['Change backup storage redundancy.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Geo-redundant backups may conflict with data residency requirements and cost more.',
      description: 'Use Geo backup storage redundancy.', patch: () => ({ requestedBackupStorageRedundancy: 'Geo' }), architectureImpact: 'Backups replicated to the paired region.', costImpact: 'POSSIBLE_INCREASE',
      terraformExpect: /storage_account_type\s*=\s*"Geo"/,
    },
    evaluate: configEvaluator(['requestedBackupStorageRedundancy'], {}, (c) => c.requestedBackupStorageRedundancy === 'Local'
      ? { status: 'WARNING', observation: 'Backup storage redundancy is Local.' }
      : { status: 'PASS', observation: `Backup storage redundancy is ${c.requestedBackupStorageRedundancy}.` }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Cosmos DB, Redis, Key Vault
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-COS-001', service: 'Azure Cosmos DB', scope: 'resource', resourceTypes: ['azure_cosmos_db'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'Cosmos DB account allows public network access',
    description: 'Public network access is enabled on the account.',
    rationale: 'MCSB NS-2; Azure Policy "Azure Cosmos DB should disable public network access" (797b37f7…).',
    risk: 'The account endpoint is reachable from the internet.', impact: 'Unauthorized data access with leaked keys.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZPOLICY-cosmos-public-access', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Disable public network access and use private endpoints.', manualSteps: ['Create a private endpoint.', 'Disable public network access.'], terraform: 'azurerm_cosmosdb_account.public_network_access_enabled = false' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Clients without a private endpoint lose access.',
      description: 'Disable public network access.', patch: () => ({ publicNetworkAccess: false }), architectureImpact: 'Private endpoint access only.', costImpact: 'NONE',
      terraformExpect: /public_network_access_enabled\s*=\s*false/,
    },
    evaluate: configEvaluator(['publicNetworkAccess'], { publicNetworkAccess: 'Disabled / No' }, (c) => c.publicNetworkAccess === true
      ? { status: 'FAIL', observation: 'Public network access is enabled.' }
      : { status: 'PASS', observation: 'Public network access is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-COS-010', service: 'Azure Cosmos DB', scope: 'resource', resourceTypes: ['azure_cosmos_db'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Cosmos DB service-managed failover is disabled',
    description: 'Automatic (service-managed) failover is disabled.',
    rationale: 'Azure Well-Architected Reliability guidance for Cosmos DB. Only effective when the account has more than one region, which CloudCraft does not model — hence LOW.',
    risk: 'A regional outage requires manual failover.', impact: 'Longer recovery time.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Add a secondary region and enable service-managed failover.', manualSteps: ['Add a read region.', 'Enable service-managed failover.'] },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Setting has no effect until a second region exists.', description: 'Enable service-managed failover.', patch: () => ({ enableAutomaticFailover: true }),
      architectureImpact: 'Failover occurs automatically when multiple regions exist.', costImpact: 'NONE', terraformExpect: /enable_automatic_failover\s*=\s*true/,
    },
    evaluate: configEvaluator(['enableAutomaticFailover'], { enableAutomaticFailover: 'Enabled / Yes' }, (c) => c.enableAutomaticFailover === false
      ? { status: 'WARNING', observation: 'Service-managed failover is disabled.' }
      : { status: 'PASS', observation: 'Service-managed failover is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-RED-001', service: 'Azure Cache for Redis', scope: 'resource', resourceTypes: ['azure_redis'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Azure Cache for Redis non-TLS port is enabled',
    description: 'The non-TLS port (6379) accepts unencrypted connections.',
    rationale: 'MCSB DP-3; Azure Policy "Only secure connections to your Azure Cache for Redis should be enabled" (22bee202…).',
    risk: 'Cache data and access keys transit in plaintext.', impact: 'Interception of data and keys.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-3', 'AZPOLICY-redis-secure-connections', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Disable the non-TLS port and connect on 6380 with TLS.', manualSteps: ['Update clients to TLS on port 6380.', 'Disable the non-TLS port.'], terraform: 'azurerm_redis_cache.enable_non_ssl_port = false (non_ssl_port_enabled in azurerm 4.x)' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Clients connecting on 6379 without TLS will fail.', description: 'Disable the non-TLS port.', patch: () => ({ enableNonSslPort: false }),
      architectureImpact: 'Clients must use TLS on 6380.', costImpact: 'NONE', terraformExpect: /enable_non_ssl_port\s*=\s*false/,
    },
    evaluate: configEvaluator(['enableNonSslPort'], { enableNonSslPort: 'Disabled / No' }, (c) => c.enableNonSslPort === true
      ? { status: 'FAIL', observation: 'The non-TLS port is enabled.' }
      : { status: 'PASS', observation: 'Only TLS connections are accepted.' }),
  }),
  rule({
    ...common,
    id: 'AZ-RED-002', service: 'Azure Cache for Redis', scope: 'resource', resourceTypes: ['azure_redis'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Azure Cache for Redis allows public network access',
    description: 'The cache endpoint accepts connections from public networks.',
    rationale: 'MCSB NS-2; Azure Policy "Azure Cache for Redis should use private link" (7803067c…).',
    risk: 'The cache is reachable from the internet with only access keys protecting it.', impact: 'Data access with leaked keys.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZPOLICY-redis-private-endpoint', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Use a private endpoint and disable public network access.', manualSteps: ['Create a private endpoint.', 'Disable public network access.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Requires a private endpoint first; disabling public access alone would cut off all clients.', description: 'Manual: add private endpoint.', patch: () => ({}), architectureImpact: 'Private access only.', costImpact: 'POSSIBLE_INCREASE' },
    evaluate: configEvaluator(['publicNetworkAccessEnabled'], { publicNetworkAccessEnabled: 'Disabled / No' }, (c) => c.publicNetworkAccessEnabled === true
      ? { status: 'FAIL', observation: 'Public network access is enabled.' }
      : { status: 'PASS', observation: 'Public network access is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-RED-003', service: 'Azure Cache for Redis', scope: 'resource', resourceTypes: ['azure_redis'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Azure Cache for Redis permits TLS versions older than 1.2',
    description: 'The minimum TLS version is 1.0 or 1.1.',
    rationale: 'MCSB DP-3.',
    risk: 'Clients can negotiate deprecated TLS.', impact: 'Weaker transport encryption.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-3', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Set minimum TLS to 1.2.', manualSteps: ['Set minimum TLS version to 1.2.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Legacy clients may not support TLS 1.2.', description: 'Set minimum TLS to 1.2.', patch: () => ({ minimumTlsVersion: '1.2' }),
      architectureImpact: 'TLS < 1.2 refused.', costImpact: 'NONE', terraformExpect: /minimum_tls_version\s*=\s*"1\.2"/,
    },
    evaluate: configEvaluator(['minimumTlsVersion'], { minimumTlsVersion: '1.2' }, (c) => TLS_OLD.has(String(c.minimumTlsVersion))
      ? { status: 'FAIL', observation: `Minimum TLS version is ${c.minimumTlsVersion}.` }
      : { status: 'PASS', observation: `Minimum TLS version is ${c.minimumTlsVersion}.` }),
  }),
  rule({
    ...common,
    id: 'AZ-KV-001', service: 'Azure Key Vault', scope: 'resource', resourceTypes: ['azure_key_vault'],
    domain: 'SECURITY', category: 'Key management', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Key Vault is reachable from all networks',
    description: 'Public network access is enabled and the vault firewall default action is Allow.',
    rationale: 'MCSB NS-2 / DP-8; Azure Policy "Azure Key Vault should have firewall enabled" (55615ac9…). A public vault whose firewall denies by default passes.',
    risk: 'The vault data plane is reachable from any network.', impact: 'Secret/key access with stolen credentials.',
    wellArchitected: WA.sec('SE:09 — Protect application secrets'),
    references: ['MCSB-NS-2', 'MCSB-DP-8', 'AZPOLICY-kv-firewall', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01', 'SOC1-DP-01'],
    remediation: { recommendation: 'Set the firewall default action to Deny with private endpoints or trusted networks, or disable public network access.', manualSteps: ['Add private endpoints / allowed networks.', 'Set network ACL default action to Deny.'], terraform: 'azurerm_key_vault.network_acls { default_action = "Deny" }' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Applications outside allowed networks will lose access to secrets.', description: 'Set the vault firewall default action to Deny.', patch: () => ({ networkAclsDefaultAction: 'Deny' }),
      architectureImpact: 'Only allowed networks / private endpoints reach the vault.', costImpact: 'NONE', terraformExpect: /default_action\s*=\s*"Deny"/,
    },
    evaluate: configEvaluator(['publicNetworkAccessEnabled', 'networkAclsDefaultAction'], { networkAclsDefaultAction: 'Deny' }, (c) => {
      if (c.publicNetworkAccessEnabled !== true) return { status: 'PASS', observation: 'Public network access is disabled.' };
      return c.networkAclsDefaultAction === 'Deny' ? { status: 'PASS', observation: 'Public access is enabled but the firewall denies by default.' } : { status: 'FAIL', observation: 'Public access is enabled and the firewall allows all networks.' };
    }),
  }),
  rule({
    ...common,
    id: 'AZ-KV-002', service: 'Azure Key Vault', scope: 'resource', resourceTypes: ['azure_key_vault'],
    domain: 'SECURITY', category: 'Key management', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Key Vault purge protection is disabled',
    description: 'Soft-deleted vaults and objects can be permanently purged before the retention period ends.',
    rationale: 'MCSB DP-8; Azure Policy "Key vaults should have deletion protection enabled" (0b60c0b2…).',
    risk: 'A malicious or accidental purge destroys keys and secrets permanently.', impact: 'Irrecoverable loss of keys (and data encrypted with them).',
    wellArchitected: WA.sec('SE:09 — Protect application secrets'),
    references: ['MCSB-DP-8', 'AZPOLICY-kv-purge-protection', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-01', 'SOC1-CM-01'],
    remediation: { recommendation: 'Enable purge protection.', manualSteps: ['Enable purge protection (cannot be disabled afterwards).'], terraform: 'azurerm_key_vault.purge_protection_enabled = true' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Purge protection is irreversible once enabled and blocks re-creating a vault with the same name during retention.',
      description: 'Enable purge protection.', patch: () => ({ purgeProtectionEnabled: true }), architectureImpact: 'Vault/objects cannot be purged during retention.', costImpact: 'NONE',
      terraformExpect: /purge_protection_enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['purgeProtectionEnabled'], { purgeProtectionEnabled: 'Enabled / Yes' }, (c) => c.purgeProtectionEnabled === false
      ? { status: 'FAIL', observation: 'Purge protection is disabled.' }
      : { status: 'PASS', observation: 'Purge protection is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-KV-003', service: 'Azure Key Vault', scope: 'resource', resourceTypes: ['azure_key_vault'],
    domain: 'SECURITY', category: 'Identity & access', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Key Vault uses access policies instead of Azure RBAC',
    description: 'Azure RBAC authorization is disabled for the vault data plane.',
    rationale: 'MCSB PA-7; Azure Policy "Azure Key Vault should use RBAC permission model" (12d4fa5e…).',
    risk: 'Access is managed per vault outside central RBAC governance (PIM, access reviews).', impact: 'Harder least-privilege enforcement and review.',
    wellArchitected: WA.sec('SE:05 — Identity and access management'),
    references: ['MCSB-PA-7', 'AZPOLICY-kv-rbac', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-02'],
    remediation: { recommendation: 'Migrate to the Azure RBAC permission model.', manualSteps: ['Map existing access policies to RBAC role assignments.', 'Enable RBAC authorization.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Existing access policies stop applying; equivalent role assignments must exist first.', description: 'Enable Azure RBAC authorization.', patch: () => ({ enableRbacAuthorization: true }),
      architectureImpact: 'Data-plane access governed by Azure RBAC.', costImpact: 'NONE', terraformExpect: /enable_rbac_authorization\s*=\s*true/,
    },
    evaluate: configEvaluator(['enableRbacAuthorization'], { enableRbacAuthorization: 'Enabled / Yes' }, (c) => c.enableRbacAuthorization === false
      ? { status: 'FAIL', observation: 'RBAC authorization is disabled (access policies in use).' }
      : { status: 'PASS', observation: 'RBAC authorization is enabled.' }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Networking
  // ════════════════════════════════════════════════════════════════════════
  ...([['AZ-NSG-001', 'SSH', 22, 'allowSsh'], ['AZ-NSG-002', 'RDP', 3389, 'allowRdp']] as const).map(([id, proto, port, field]) => rule({
    ...common,
    id, service: 'Azure network security groups', scope: 'resource', resourceTypes: ['azure_nsg'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: `NSG allows ${proto} (${port}) from any source`,
    description: `An inbound rule allows TCP ${port} from "*" / Internet / 0.0.0.0/0.`,
    rationale: 'MCSB NS-3; Azure Policy "Management ports should be closed on your virtual machines" (22730e10…).',
    risk: `${proto} is exposed to internet brute force and exploitation.`, impact: 'Compromise of associated virtual machines.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-3', 'AZPOLICY-mgmt-ports', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01', 'SOC1-LA-02'],
    remediation: { recommendation: `Remove internet-wide ${proto}; use Azure Bastion or just-in-time VM access, or restrict the source to known administrator ranges.`, manualSteps: ['Deploy Azure Bastion or enable JIT access.', `Remove or restrict the ${port} inbound rule.`], terraform: `azurerm_network_security_rule: no destination_port_range ${port} with source_address_prefix "*"` },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Removing the rule can lock administrators out unless Bastion/JIT/VPN is in place.',
      description: `Remove the ${proto} inbound rule.`, patch: () => ({ [field]: false }), architectureImpact: `${proto} ingress removed.`, costImpact: 'NONE',
    },
    evaluate: configEvaluator([field], { [field]: 'Disabled, or restricted source' }, (c, r) => {
      if (c[field] !== true) return { status: 'PASS', observation: `No ${proto} inbound rule.` };
      if (c.sourceCidr === undefined || c.sourceCidr === null || c.sourceCidr === '') return { status: 'WARNING', observation: `${proto} is allowed but the source is not specified; the generated Terraform defaults to "*".`, extraEvidence: [ev(r, 'sourceCidr')] };
      return isAzureAnySource(c.sourceCidr)
        ? { status: 'FAIL', observation: `${proto} (${port}) is open to source "${c.sourceCidr}".`, extraEvidence: [ev(r, 'sourceCidr', 'Specific trusted range')] }
        : { status: 'PASS', observation: `${proto} is restricted to ${c.sourceCidr}.`, extraEvidence: [ev(r, 'sourceCidr')] };
    }),
  })),
  rule({
    ...common,
    id: 'AZ-NIC-001', service: 'Azure network interfaces', scope: 'resource', resourceTypes: ['azure_nic'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'IP forwarding is enabled on a network interface',
    description: 'The NIC can forward traffic not addressed to it.',
    rationale: 'MCSB NS-3; Azure Policy "IP Forwarding on your virtual machine should be disabled" (bd352bd5…). Legitimate for network virtual appliances.',
    risk: 'The VM can route traffic between networks, bypassing segmentation.', impact: 'Lateral movement paths.',
    wellArchitected: WA.sec('SE:04 — Segmentation'),
    references: ['MCSB-NS-3', 'AZPOLICY-ip-forwarding', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Disable IP forwarding unless the VM is an intentional network virtual appliance.', manualSteps: ['Confirm the VM is not an NVA.', 'Disable IP forwarding.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Breaks routing if the VM is a network virtual appliance.', description: 'Disable IP forwarding.', patch: () => ({ enableIpForwarding: false }),
      architectureImpact: 'The NIC stops forwarding traffic.', costImpact: 'NONE', terraformExpect: /enable_ip_forwarding\s*=\s*false/,
    },
    evaluate: configEvaluator(['enableIpForwarding'], { enableIpForwarding: 'Disabled / No' }, (c) => c.enableIpForwarding === true
      ? { status: 'FAIL', observation: 'IP forwarding is enabled.' }
      : { status: 'PASS', observation: 'IP forwarding is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-ARCH-001', service: 'Azure Virtual Network', scope: 'architecture',
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Subnets are not protected by a network security group',
    description: 'Subnets in the architecture have no associated NSG.',
    rationale: 'MCSB NS-1; Azure Policy "Subnets should be associated with a Network Security Group" (e71308d3…). Unlike AWS, Azure attaches no NSG by default, so a subnet with no NSG in the design will have none when deployed. Association is inferred from containment or a diagram connection.',
    risk: 'No subnet-level traffic filtering.', impact: 'Unrestricted east-west and (with public IPs) inbound traffic.',
    wellArchitected: WA.sec('SE:04 — Segmentation / SE:06 — Network controls'),
    references: ['MCSB-NS-1', 'AZPOLICY-nsg-subnets', 'AZ-WA-security'],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Associate a least-privilege NSG with every workload subnet.', manualSteps: ['Create NSGs per tier.', 'Associate them with the subnets.'] },
    evaluateArchitecture: (ctx) => {
      const subnets = ctx.ofType('azure_subnet');
      if (subnets.length === 0) return [{ status: 'NOT_APPLICABLE', observation: 'No Azure subnets are modelled.', evidence: [] }];
      const nsgs = ctx.ofType('azure_nsg');
      const unprotected = subnets.filter((s) => !nsgs.some((n) => n.parentId === s.id || ctx.neighbors(s.id).some((x) => x.id === n.id)));
      const evidence = [
        { label: 'Subnets', observed: String(subnets.length), basis: 'TOPOLOGY' as const },
        { label: 'Network security groups', observed: String(nsgs.length), basis: 'TOPOLOGY' as const },
        { label: 'Subnets without an associated NSG', observed: unprotected.map((s) => s.label).join(', ') || 'None', basis: 'RELATIONSHIP' as const },
      ];
      if (unprotected.length === 0) return [{ status: 'PASS', observation: 'Every subnet has an associated NSG.', evidence, resourceIds: subnets.map((s) => s.id) }];
      if (nsgs.length === 0) return [{ status: 'FAIL', observation: `No NSGs exist; ${subnets.length} subnet(s) are unfiltered.`, evidence, resourceIds: unprotected.map((s) => s.id) }];
      return [{ status: 'WARNING', observation: `${unprotected.length} subnet(s) have no NSG associated in the diagram.`, evidence, resourceIds: unprotected.map((s) => s.id), requiredData: 'Place each NSG inside, or connect it to, the subnet it protects.' }];
    },
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Compute
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-VM-001', service: 'Azure Virtual Machines', scope: 'resource', resourceTypes: ['azure_vm'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Virtual machine has a public IP address',
    description: 'A public IP is attached to the VM network interface.',
    rationale: 'MCSB NS-1/NS-2: expose workloads through controlled entry points (load balancer, Application Gateway, Bastion) rather than per-VM public IPs.',
    risk: 'The VM is directly internet-addressable.', impact: 'Larger attack surface; bypass of WAF and load balancer controls.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Remove the public IP; use Azure Bastion for administration and a load balancer/Application Gateway for inbound traffic.', manualSteps: ['Deploy Azure Bastion.', 'Remove the public IP from the NIC.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Direct inbound access to the VM stops; admins need Bastion/VPN.', description: 'Remove the VM public IP.', patch: () => ({ publicIpEnabled: false }),
      architectureImpact: 'VM reachable only privately.', costImpact: 'POSSIBLE_DECREASE',
    },
    evaluate: configEvaluator(['publicIpEnabled'], { publicIpEnabled: 'Disabled / No' }, (c) => c.publicIpEnabled === true
      ? { status: 'FAIL', observation: 'A public IP address is attached.' }
      : { status: 'PASS', observation: 'No public IP address is attached.' }),
  }),
  rule({
    ...common,
    id: 'AZ-VM-002', service: 'Azure Virtual Machines', scope: 'resource', resourceTypes: ['azure_vm'],
    domain: 'SECURITY', category: 'Encryption at rest', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Encryption at host is disabled',
    description: 'Temporary disks and disk caches are not encrypted at the host.',
    rationale: 'MCSB DP-4; Azure Policy "VMs and VMSS should have encryption at host enabled" (fc4d8e41…). Rated LOW because managed OS/data disks are always encrypted at rest with platform-managed keys (server-side encryption); encryption at host extends this to temp disks and caches.',
    risk: 'Temp disk and cache contents are not encrypted end-to-end.', impact: 'Residual data exposure on host storage.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-4', 'AZPOLICY-vm-encryption-at-host', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-01'],
    remediation: { recommendation: 'Enable encryption at host (register the EncryptionAtHost feature on the subscription first).', manualSteps: ['Register Microsoft.Compute/EncryptionAtHost.', 'Deallocate the VM and enable encryption at host.'], terraform: 'azurerm_linux_virtual_machine.encryption_at_host_enabled = true' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Requires the EncryptionAtHost subscription feature and a supported VM size; deployed VMs must be deallocated.',
      description: 'Enable encryption at host.', patch: () => ({ encryptionAtHostEnabled: true }), architectureImpact: 'Temp disks and caches encrypted.', costImpact: 'NONE',
      terraformExpect: /encryption_at_host_enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['encryptionAtHostEnabled'], { encryptionAtHostEnabled: 'Enabled / Yes' }, (c) => c.encryptionAtHostEnabled === true
      ? { status: 'PASS', observation: 'Encryption at host is enabled.' }
      : { status: 'FAIL', observation: 'Encryption at host is disabled (managed disks remain encrypted with platform-managed keys).' }),
  }),
  rule({
    ...common,
    id: 'AZ-VMSS-001', service: 'Azure Virtual Machine Scale Sets', scope: 'resource', resourceTypes: ['azure_vmss'],
    domain: 'SECURITY', category: 'Encryption at rest', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Scale set encryption at host is disabled',
    description: 'Temporary disks and caches of scale set instances are not encrypted at the host.',
    rationale: 'MCSB DP-4; Azure Policy fc4d8e41…. Managed disks are always encrypted with platform-managed keys.',
    risk: 'Temp disk and cache contents are not encrypted end-to-end.', impact: 'Residual data exposure on host storage.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-4', 'AZPOLICY-vm-encryption-at-host', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-01'],
    remediation: { recommendation: 'Enable encryption at host on the scale set.', manualSteps: ['Register Microsoft.Compute/EncryptionAtHost.', 'Enable encryption at host.'], terraform: 'azurerm_linux_virtual_machine_scale_set.encryption_at_host_enabled = true' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Requires the EncryptionAtHost subscription feature and a supported size.', description: 'Enable encryption at host.', patch: () => ({ osDiskEncryption: true }),
      architectureImpact: 'Temp disks and caches encrypted.', costImpact: 'NONE', terraformExpect: /encryption_at_host_enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['osDiskEncryption'], { osDiskEncryption: 'Enabled / Yes' }, (c) => c.osDiskEncryption === true
      ? { status: 'PASS', observation: 'Encryption at host is enabled.' }
      : { status: 'FAIL', observation: 'Encryption at host is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-VM-010', service: 'Azure Virtual Machines', scope: 'resource', resourceTypes: ['azure_vm'],
    domain: 'RELIABILITY', category: 'Data protection', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Azure Backup protection is not modelled for the VM',
    description: 'CloudCraft does not model Recovery Services vaults or backup policies.',
    rationale: 'MCSB BR-1; Azure Policy "Azure Backup should be enabled for Virtual Machines" (013e242c…). Reported NOT EVALUATED — backup is never assumed.',
    risk: 'VM data may not be recoverable.', impact: 'Data loss after corruption or ransomware.',
    wellArchitected: WA.rel('RE:09 — Business continuity and disaster recovery'),
    references: ['MCSB-BR-1', 'AZPOLICY-vm-backup', 'AZ-WA-reliability'],
    soc1: ['SOC1-OP-03'],
    remediation: { recommendation: 'Protect the VM with Azure Backup (Recovery Services vault + policy).', manualSteps: ['Create a Recovery Services vault.', 'Enable backup for the VM with a policy.'] },
    evaluate: (r) => notModelled('Azure Backup protection', 'Evidence of a Recovery Services vault protecting this VM (live discovery or user-provided).', [r.id]),
  }),
  rule({
    ...common,
    id: 'AZ-VM-011', service: 'Azure Virtual Machines', scope: 'resource', resourceTypes: ['azure_vm'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Virtual machine is not pinned to an availability zone',
    description: 'No availability zone is set, so the VM is placed regionally without zonal guarantees.',
    rationale: 'Azure Well-Architected Reliability (redundancy): spread instances across zones where the region supports them.',
    risk: 'Zone placement is uncontrolled; redundant instances may share a failure domain.', impact: 'Reduced resilience to zone failures.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Deploy VMs across zones (or use a zone-redundant scale set).', manualSteps: ['Assign zones 1/2/3 to redundant instances.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Changing the zone of an existing VM requires recreation, and zone choice depends on the other instances.', description: 'Manual: choose zones.', patch: () => ({}), architectureImpact: 'VM recreation.', costImpact: 'NONE' },
    evaluate: configEvaluator([], {}, (c, r) => c.availabilityZone
      ? { status: 'PASS', observation: `Pinned to zone ${c.availabilityZone}.`, extraEvidence: [ev(r, 'availabilityZone')] }
      : { status: 'WARNING', observation: 'No availability zone is set.', extraEvidence: [ev(r, 'availabilityZone', 'Zone 1, 2 or 3')] }),
  }),
  rule({
    ...common,
    id: 'AZ-VM-020', service: 'Azure Virtual Machines', scope: 'resource', resourceTypes: ['azure_vm'],
    domain: 'OPERATIONAL_EXCELLENCE', category: 'Monitoring', severity: 'LOW', priority: 'OPTIONAL_OPTIMIZATION',
    title: 'VM boot diagnostics are disabled',
    description: 'Serial console output and boot screenshots are not captured.',
    rationale: 'Azure Well-Architected Operational Excellence (monitoring).',
    risk: 'Boot failures are hard to diagnose.', impact: 'Longer recovery from boot problems.',
    wellArchitected: WA.ops('OE:07 — Monitoring system'),
    references: ['AZ-WA-operational_excellence', TF],
    soc1: ['SOC1-OP-02'],
    remediation: { recommendation: 'Enable boot diagnostics (managed storage).', manualSteps: ['Enable boot diagnostics.'] },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'Diagnostics-only.', description: 'Enable boot diagnostics.', patch: () => ({ bootDiagnosticsEnabled: true }),
      architectureImpact: 'Boot diagnostics captured.', costImpact: 'NONE', terraformExpect: /boot_diagnostics/,
    },
    evaluate: configEvaluator(['bootDiagnosticsEnabled'], { bootDiagnosticsEnabled: 'Enabled / Yes' }, (c) => c.bootDiagnosticsEnabled === false
      ? { status: 'FAIL', observation: 'Boot diagnostics are disabled.' }
      : { status: 'PASS', observation: 'Boot diagnostics are enabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-ARCH-010', service: 'Azure Virtual Machines', scope: 'architecture',
    domain: 'RELIABILITY', category: 'Resilience', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Virtual machines are not behind a load balancer or scale set',
    description: 'VMs exist without an Azure Load Balancer, Application Gateway, Front Door or VM Scale Set in the architecture.',
    rationale: 'Azure Well-Architected Reliability (redundancy). The previous rule looked for resource types that do not exist in CloudCraft and fired even when a load balancer was present; it has been corrected.',
    risk: 'Each VM is a single point of failure.', impact: 'Outage when a VM or zone fails.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability'],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Run the tier on a zone-redundant VM Scale Set behind a Standard Load Balancer or Application Gateway.', manualSteps: ['Create a VM Scale Set across zones.', 'Front it with a Standard Load Balancer or Application Gateway.'] },
    evaluateArchitecture: (ctx) => {
      const vms = ctx.ofType('azure_vm');
      if (vms.length === 0) return [{ status: 'NOT_APPLICABLE', observation: 'No Azure VMs.', evidence: [] }];
      const lbs = ctx.ofType('azure_lb', 'azure_app_gateway', 'azure_front_door', 'azure_vmss');
      const evidence = [{ label: 'Virtual machines', observed: String(vms.length), basis: 'TOPOLOGY' as const }, { label: 'Load balancers / gateways / scale sets', observed: String(lbs.length), basis: 'TOPOLOGY' as const }];
      return lbs.length > 0
        ? [{ status: 'PASS', observation: 'A load balancer, gateway or scale set is present.', evidence, resourceIds: vms.map((v) => v.id) }]
        : [{ status: 'FAIL', severity: vms.length === 1 ? 'MEDIUM' : 'LOW', observation: `${vms.length} VM(s) without a load balancer, gateway or scale set.`, evidence, resourceIds: vms.map((v) => v.id) }];
    },
  }),

  // ════════════════════════════════════════════════════════════════════════
  // App Service & Functions
  // ════════════════════════════════════════════════════════════════════════
  ...([
    ['AZ-APP-001', 'azure_app_service', 'App Service', 'AZPOLICY-webapp-https'],
    ['AZ-FUNC-001', 'azure_functions', 'Function App', 'AZPOLICY-func-https'],
  ] as const).map(([id, type, svc, pol]) => rule({
    ...common,
    id, service: `Azure ${svc}`, scope: 'resource', resourceTypes: [type],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: `${svc} accepts plaintext HTTP`,
    description: 'HTTPS Only is disabled.',
    rationale: `MCSB DP-3; Azure Policy for ${svc} HTTPS-only.`,
    risk: 'Traffic can be intercepted or modified.', impact: 'Session hijacking and data disclosure.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-3', pol, 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Enable HTTPS Only.', manualSteps: ['Enable HTTPS Only.'], terraform: 'https_only = true' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'HTTP requests are redirected to HTTPS.', description: 'Enable HTTPS Only.', patch: () => ({ httpsOnly: true }),
      architectureImpact: 'HTTP redirected to HTTPS.', costImpact: 'NONE', terraformExpect: /https_only\s*=\s*true/,
    },
    evaluate: configEvaluator(['httpsOnly'], { httpsOnly: 'Enabled / Yes' }, (c) => c.httpsOnly === false
      ? { status: 'FAIL', observation: 'HTTPS Only is disabled.' }
      : { status: 'PASS', observation: 'HTTPS Only is enabled.' }),
  })),
  ...([
    ['AZ-APP-002', 'azure_app_service', 'App Service', 'AZPOLICY-webapp-tls'],
    ['AZ-FUNC-002', 'azure_functions', 'Function App', 'AZPOLICY-func-tls'],
  ] as const).map(([id, type, svc, pol]) => rule({
    ...common,
    id, service: `Azure ${svc}`, scope: 'resource', resourceTypes: [type],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: `${svc} permits TLS versions older than 1.2`,
    description: 'The minimum inbound TLS version is 1.0 or 1.1.',
    rationale: `MCSB DP-3; Azure Policy "Latest TLS version should be used" for ${svc}.`,
    risk: 'Clients can negotiate deprecated TLS.', impact: 'Weaker transport encryption.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-3', pol, 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Set minimum TLS to 1.2.', manualSteps: ['Set Minimum Inbound TLS Version to 1.2.'], terraform: 'site_config { minimum_tls_version = "1.2" }' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Legacy clients may not support TLS 1.2.', description: 'Set minimum TLS to 1.2.', patch: () => ({ minimumTlsVersion: '1.2' }),
      architectureImpact: 'TLS < 1.2 refused.', costImpact: 'NONE', terraformExpect: /minimum_tls_version\s*=\s*"1\.2"/,
    },
    evaluate: configEvaluator(['minimumTlsVersion'], { minimumTlsVersion: '1.2' }, (c) => TLS_OLD.has(String(c.minimumTlsVersion))
      ? { status: 'FAIL', observation: `Minimum TLS version is ${c.minimumTlsVersion}.` }
      : { status: 'PASS', observation: `Minimum TLS version is ${c.minimumTlsVersion}.` }),
  })),
  rule({
    ...common,
    id: 'AZ-APP-003', service: 'Azure App Service', scope: 'resource', resourceTypes: ['azure_app_service'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'App Service allows unencrypted FTP deployment',
    description: 'FTP state is "AllAllowed" (plain FTP and FTPS).',
    rationale: 'MCSB DP-3; Azure Policy "FTPS should be required in your web App" (4d24b6d4…).',
    risk: 'Deployment credentials and code transit in plaintext.', impact: 'Credential theft and code tampering.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-3', 'AZPOLICY-webapp-ftps', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-02', 'SOC1-CM-01'],
    remediation: { recommendation: 'Set FTP state to "FTPS only" or "Disabled".', manualSteps: ['Set FTP state to FtpsOnly (or Disabled if not used).'], terraform: 'site_config { ftps_state = "FtpsOnly" }' },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'FTPS remains available for FTP-based deployments.', description: 'Require FTPS.', patch: () => ({ ftpsState: 'FtpsOnly' }),
      architectureImpact: 'Plain FTP deployment refused.', costImpact: 'NONE', terraformExpect: /ftps_state\s*=\s*"FtpsOnly"/,
    },
    evaluate: configEvaluator(['ftpsState'], { ftpsState: 'FtpsOnly or Disabled' }, (c) => c.ftpsState === 'AllAllowed'
      ? { status: 'FAIL', observation: 'Plain FTP is allowed.' }
      : { status: 'PASS', observation: `FTP state is ${c.ftpsState}.` }),
  }),
  rule({
    ...common,
    id: 'AZ-APP-010', service: 'Azure App Service', scope: 'resource', resourceTypes: ['azure_app_service'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'App Service health check is not configured',
    description: 'No health check path is set, so unhealthy instances are not removed from rotation.',
    rationale: 'Azure Well-Architected Reliability guidance for App Service.',
    risk: 'Traffic continues to reach failing instances.', impact: 'Partial outages that do not self-heal.',
    wellArchitected: WA.rel('RE:05 — Redundancy / health modeling'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Expose a health endpoint and set the health check path.', manualSteps: ['Implement a /health endpoint.', 'Set the health check path.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'The application must implement the health endpoint.', description: 'Manual: set health check path.', patch: () => ({}), architectureImpact: 'Unhealthy instances removed.', costImpact: 'NONE' },
    evaluate: configEvaluator([], {}, (c, r) => c.healthCheckPath
      ? { status: 'PASS', observation: `Health check path: ${c.healthCheckPath}.`, extraEvidence: [ev(r, 'healthCheckPath')] }
      : { status: 'WARNING', observation: 'No health check path is configured.', extraEvidence: [ev(r, 'healthCheckPath', 'e.g. /health')] }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // AKS
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-AKS-001', service: 'Azure Kubernetes Service', scope: 'resource', resourceTypes: ['azure_aks'],
    domain: 'SECURITY', category: 'Identity & access', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'AKS Kubernetes RBAC is disabled',
    description: 'Role-based access control is disabled for the cluster.',
    rationale: 'MCSB PA-7; Azure Policy "Role-Based Access Control (RBAC) should be used on Kubernetes Services" (ac4a19c2…).',
    risk: 'Any authenticated identity has unrestricted cluster access.', impact: 'Cluster takeover from a single compromised credential.',
    wellArchitected: WA.sec('SE:05 — Identity and access management'),
    references: ['MCSB-PA-7', 'AZPOLICY-aks-rbac', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-02'],
    remediation: { recommendation: 'Enable Kubernetes RBAC with Microsoft Entra integration.', manualSteps: ['Recreate the cluster with RBAC enabled (cannot be toggled in place).'] },
    autoFix: {
      safety: (r) => (deployed(r) ? 'MANUAL_ONLY' : 'SAFE_AUTOFIX'),
      safetyReason: (r) => deployed(r) ? 'RBAC cannot be enabled on an existing cluster without recreating it.' : 'Not yet deployed: RBAC is enabled at creation.',
      description: 'Enable Kubernetes RBAC.', patch: () => ({ rbacEnabled: true }), architectureImpact: 'Cluster access governed by RBAC.', costImpact: 'NONE',
      terraformExpect: /role_based_access_control_enabled\s*=\s*true|azure_active_directory_role_based_access_control/,
    },
    evaluate: configEvaluator(['rbacEnabled'], { rbacEnabled: 'Enabled / Yes' }, (c) => c.rbacEnabled === false
      ? { status: 'FAIL', observation: 'Kubernetes RBAC is disabled.' }
      : { status: 'PASS', observation: 'Kubernetes RBAC is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-AKS-002', service: 'Azure Kubernetes Service', scope: 'resource', resourceTypes: ['azure_aks'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'AKS API server is publicly reachable without authorized IP ranges',
    description: 'The cluster is not private and CloudCraft has no authorized IP range configuration for the API server.',
    rationale: 'MCSB NS-2; Azure Policy "Authorized IP ranges should be defined on Kubernetes Services" (0e246bcf…).',
    risk: 'The API server is exposed to internet scanning and credential attacks.', impact: 'Cluster compromise.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZPOLICY-aks-authorized-ips', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Use a private cluster, or restrict API server access with authorized IP ranges.', manualSteps: ['Define authorized IP ranges for administrators and CI.', 'Or deploy as a private cluster.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Private clusters must be created as such and require private connectivity for kubectl/CI; CloudCraft does not know administrator IP ranges.', description: 'Manual.', patch: () => ({}), architectureImpact: 'Changes how the API server is reached.', costImpact: 'NONE' },
    evaluate: configEvaluator(['privateClusterEnabled'], { privateClusterEnabled: 'Enabled / Yes (or authorized IP ranges)' }, (c) => c.privateClusterEnabled === true
      ? { status: 'PASS', observation: 'The cluster is private.' }
      : { status: 'FAIL', observation: 'The API server is public and no authorized IP ranges are modelled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-AKS-010', service: 'Azure Kubernetes Service', scope: 'resource', resourceTypes: ['azure_aks'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'AKS cluster uses the Free tier (no financially-backed API server SLA)',
    description: 'The control plane runs on the Free tier.',
    rationale: 'Azure Well-Architected Reliability guidance for AKS recommends the Standard tier for production clusters.',
    risk: 'Control plane availability has no SLA.', impact: 'Longer or unrecoverable control plane disruption.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Use the Standard tier for production clusters.', manualSteps: ['Upgrade the cluster SKU tier to Standard.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'The Standard tier adds an hourly control plane charge.', description: 'Use the Standard tier.', patch: () => ({ skuTier: 'Standard' }),
      architectureImpact: 'Control plane SLA.', costImpact: 'POSSIBLE_INCREASE', terraformExpect: /sku_tier\s*=\s*"Standard"/,
    },
    evaluate: configEvaluator(['skuTier'], { skuTier: 'Standard' }, (c) => c.skuTier === 'Free'
      ? { status: 'WARNING', observation: 'The cluster uses the Free tier.' }
      : { status: 'PASS', observation: `The cluster uses the ${c.skuTier} tier.` }),
  }),
  rule({
    ...common,
    id: 'AZ-AKS-030', service: 'Azure Kubernetes Service', scope: 'resource', resourceTypes: ['azure_aks'],
    domain: 'COST_OPTIMIZATION', category: 'Cost', severity: 'LOW', priority: 'OPTIONAL_OPTIMIZATION',
    title: 'AKS cluster autoscaler is disabled',
    description: 'The node pool runs a fixed node count.',
    rationale: 'Azure Well-Architected Cost Optimization: scale capacity with demand.',
    risk: 'Capacity is paid for when idle and may be insufficient at peak.', impact: 'Overspend or throttling.',
    wellArchitected: WA.cost('CO:12 — Scaling costs'),
    references: ['AZ-WA-cost_optimization', TF],
    soc1: [],
    remediation: { recommendation: 'Enable the cluster autoscaler with sensible min/max node counts.', manualSteps: ['Enable autoscaling on the node pool.', 'Set min/max node counts.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Min/max counts must reflect workload requirements.', description: 'Enable the cluster autoscaler.',
      patch: (c) => ({ enableAutoScaling: true, minNodeCount: Math.min(Number(c.minNodeCount) || 1, Number(c.nodeCount) || 1), maxNodeCount: Math.max(Number(c.maxNodeCount) || 1, Number(c.nodeCount) || 1) }),
      architectureImpact: 'Node count scales with demand.', costImpact: 'POSSIBLE_DECREASE', terraformExpect: /enable_auto_scaling\s*=\s*true/,
    },
    evaluate: configEvaluator(['enableAutoScaling'], { enableAutoScaling: 'Enabled / Yes' }, (c) => c.enableAutoScaling === true
      ? { status: 'PASS', observation: 'The cluster autoscaler is enabled.' }
      : { status: 'WARNING', observation: `Fixed node count (${fmt(c.nodeCount)}).` }, ['nodeCount']),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Edge: Application Gateway, Front Door, WAF policy, Bastion
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-AGW-001', service: 'Azure Application Gateway', scope: 'resource', resourceTypes: ['azure_app_gateway'],
    domain: 'SECURITY', category: 'Edge protection', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Application Gateway web application firewall is not enforcing',
    description: 'The gateway uses the Standard_v2 SKU, has WAF disabled, or runs WAF in Detection mode.',
    rationale: 'MCSB NS-6; Azure Policy "Web Application Firewall (WAF) should be enabled for Application Gateway" (564feb30…). Detection mode logs but does not block, so it is a WARNING.',
    risk: 'Web exploits reach the backend unfiltered.', impact: 'Application compromise.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-6', 'AZPOLICY-agw-waf', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Use the WAF_v2 SKU with WAF in Prevention mode after tuning in Detection mode.', manualSteps: ['Switch to WAF_v2.', 'Tune rules in Detection mode.', 'Switch to Prevention.'], terraform: 'sku WAF_v2 + waf_configuration { enabled = true, firewall_mode = "Prevention" }' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'WAF_v2 costs more and Prevention mode can block legitimate traffic until tuned.', description: 'Use WAF_v2 with WAF enabled in Prevention mode.',
      patch: () => ({ sku: 'WAF_v2', wafEnabled: true, wafMode: 'Prevention' }),
      architectureImpact: 'Requests matching OWASP rules are blocked.', costImpact: 'POSSIBLE_INCREASE', terraformExpect: /firewall_mode\s*=\s*"Prevention"/,
    },
    evaluate: configEvaluator(['sku'], {}, (c) => {
      if (c.sku !== 'WAF_v2') return { status: 'FAIL', observation: `The ${fmt(c.sku)} SKU has no web application firewall.` };
      if (c.wafEnabled !== true) return { status: 'FAIL', observation: 'WAF_v2 SKU with the firewall disabled.' };
      if (c.wafMode === 'Detection') return { status: 'WARNING', observation: 'WAF is in Detection mode (logs only).' };
      return { status: 'PASS', observation: 'WAF is enabled in Prevention mode.' };
    }, ['wafEnabled', 'wafMode']),
  }),
  rule({
    ...common,
    id: 'AZ-AFD-001', service: 'Azure Front Door', scope: 'resource', resourceTypes: ['azure_front_door'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Front Door accepts plaintext HTTP',
    description: 'HTTPS-only / HTTP-to-HTTPS redirect is disabled on the route.',
    rationale: 'MCSB DP-3.',
    risk: 'Client traffic can be intercepted.', impact: 'Session hijacking and data disclosure.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-3', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Accept HTTPS only and redirect HTTP to HTTPS.', manualSteps: ['Enable HTTPS redirect on the route.'] },
    autoFix: {
      safety: 'SAFE_AUTOFIX', safetyReason: 'HTTP requests are redirected rather than rejected.', description: 'Enable HTTPS redirect.', patch: () => ({ httpsOnly: true }),
      architectureImpact: 'HTTP redirected to HTTPS.', costImpact: 'NONE', terraformExpect: /https_redirect_enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['httpsOnly'], { httpsOnly: 'Enabled / Yes' }, (c) => c.httpsOnly === false
      ? { status: 'FAIL', observation: 'HTTP is accepted without redirect.' }
      : { status: 'PASS', observation: 'HTTPS only (with redirect).' }),
  }),
  rule({
    ...common,
    id: 'AZ-AFD-002', service: 'Azure Front Door', scope: 'resource', resourceTypes: ['azure_front_door'],
    domain: 'SECURITY', category: 'Edge protection', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Front Door has no WAF policy',
    description: 'No Azure WAF policy is connected to the Front Door profile in the architecture.',
    rationale: 'MCSB NS-6; Azure Policy "Azure Web Application Firewall should be enabled for Azure Front Door entry-points" (055aa869…). Managed rule sets require the Premium tier.',
    risk: 'Web exploits and abusive traffic reach the origin.', impact: 'Application compromise or abuse.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-6', 'AZPOLICY-afd-waf', 'AZ-WA-security'],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Attach a WAF policy (Premium tier for managed rule sets) in Prevention mode.', manualSteps: ['Create a Front Door WAF policy.', 'Associate it with the endpoint/security policy.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Adds a billable policy; managed rules may require a tier change.', description: 'Manual: add WAF policy.', patch: () => ({}), architectureImpact: 'Adds WAF.', costImpact: 'POSSIBLE_INCREASE' },
    evaluate: (r, ctx) => {
      const waf = ctx.neighbors(r.id).find((n) => n.resourceType === 'azure_waf');
      const evidence = [ev(r, 'sku'), { label: 'Diagram relationship', observed: waf ? `Connected to ${waf.label}` : 'No connection to an Azure WAF policy', basis: 'RELATIONSHIP' as const }];
      return waf ? { status: 'PASS', observation: `Connected to WAF policy "${waf.label}".`, evidence } : { status: 'FAIL', observation: 'No WAF policy is connected.', evidence };
    },
  }),
  rule({
    ...common,
    id: 'AZ-WAF-001', service: 'Azure Web Application Firewall', scope: 'resource', resourceTypes: ['azure_waf'],
    domain: 'SECURITY', category: 'Edge protection', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'WAF policy is in Detection mode',
    description: 'Matching requests are logged but not blocked.',
    rationale: 'MCSB NS-6. Detection mode is appropriate while tuning, not for steady state.',
    risk: 'Attacks are detected but not stopped.', impact: 'Application compromise despite a WAF being present.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-6', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Switch to Prevention mode after reviewing detections and adding exclusions.', manualSteps: ['Review WAF logs for false positives.', 'Add exclusions.', 'Switch to Prevention.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Prevention mode blocks false positives that have not been tuned out.', description: 'Switch to Prevention mode.', patch: () => ({ mode: 'Prevention' }),
      architectureImpact: 'Matching requests are blocked.', costImpact: 'NONE', terraformExpect: /mode\s*=\s*"Prevention"/,
    },
    evaluate: configEvaluator(['mode'], { mode: 'Prevention' }, (c) => c.mode === 'Detection'
      ? { status: 'WARNING', observation: 'The policy is in Detection mode.' }
      : { status: 'PASS', observation: 'The policy is in Prevention mode.' }),
  }),
  rule({
    ...common,
    id: 'AZ-BAS-001', service: 'Azure Bastion', scope: 'resource', resourceTypes: ['azure_bastion'],
    domain: 'SECURITY', category: 'Identity & access', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Bastion shareable links are enabled',
    description: 'Users can create links that allow VM access without Azure portal sign-in.',
    rationale: 'Azure Bastion shareable links bypass portal-based access paths; they should be enabled only with governance over link creation and expiry.',
    risk: 'Leaked links grant VM access.', impact: 'Unauthorized VM sessions.',
    wellArchitected: WA.sec('SE:05 — Identity and access management'),
    references: ['AZ-WA-security', TF],
    soc1: ['SOC1-LA-02'],
    remediation: { recommendation: 'Disable shareable links unless there is a governed business need.', manualSteps: ['Disable shareable links.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Existing shared links stop working.', description: 'Disable shareable links.', patch: () => ({ shareableLinkEnabled: false }),
      architectureImpact: 'Shared links revoked.', costImpact: 'NONE', terraformExpect: /shareable_link_enabled\s*=\s*false/,
    },
    evaluate: configEvaluator(['shareableLinkEnabled'], { shareableLinkEnabled: 'Disabled / No' }, (c) => c.shareableLinkEnabled === true
      ? { status: 'FAIL', observation: 'Shareable links are enabled.' }
      : { status: 'PASS', observation: 'Shareable links are disabled.' }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Architecture-level operations & performance
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-ARCH-020', service: 'Azure Monitor', scope: 'architecture',
    domain: 'OPERATIONAL_EXCELLENCE', category: 'Monitoring', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Azure Monitor / Log Analytics configuration not modelled',
    description: 'CloudCraft has no resource type for Log Analytics workspaces, Application Insights or diagnostic settings.',
    rationale: 'The previous rule reported "no monitoring" for every Azure architecture because it looked for resource types that cannot be created in CloudCraft. It is now NOT EVALUATED with a clear data requirement.',
    risk: 'Monitoring coverage is unknown.', impact: 'Undetected failures if monitoring is absent.',
    wellArchitected: WA.ops('OE:07 — Monitoring system'),
    references: ['AZ-WA-operational_excellence', 'MCSB-LT-3'],
    soc1: ['SOC1-OP-02', 'SOC1-OP-01'],
    remediation: { recommendation: 'Send platform metrics and resource logs to a Log Analytics workspace via diagnostic settings and define alert rules.', manualSteps: ['Create a Log Analytics workspace.', 'Configure diagnostic settings for each resource.', 'Create alert rules and action groups.'] },
    evaluateArchitecture: (ctx) => ctx.providers.includes('azure')
      ? [notModelled('Azure Monitor diagnostic settings and alerting', 'Live discovery of diagnostic settings/alert rules, or user-provided evidence.')]
      : [{ status: 'NOT_APPLICABLE', observation: 'No Azure resources.', evidence: [] }],
  }),
  rule({
    ...common,
    id: 'AZ-ARCH-030', service: 'Azure Cache for Redis', scope: 'architecture',
    domain: 'PERFORMANCE_EFFICIENCY', category: 'Performance', severity: 'INFORMATIONAL', priority: 'OPTIONAL_OPTIMIZATION',
    title: 'Database-backed compute has no caching layer',
    description: 'Azure SQL/Cosmos DB and compute resources are present without Azure Cache for Redis.',
    rationale: 'Azure Well-Architected Performance Efficiency: caching reduces repeated reads. Informational — it depends on the read pattern. (The previous rule looked for non-existent resource types and fired even when Redis was present.)',
    risk: 'Read-heavy workloads place all load on the database.', impact: 'Higher latency and database cost at scale.',
    wellArchitected: WA.perf('PE:08 — Data performance'),
    references: ['AZ-WA-performance_efficiency'],
    soc1: [],
    remediation: { recommendation: 'If read-heavy, add Azure Cache for Redis for hot data and sessions.', manualSteps: ['Profile read patterns.', 'Add Azure Cache for Redis.'] },
    evaluateArchitecture: (ctx) => {
      const dbs = ctx.ofType('azure_sql', 'azure_cosmos_db');
      const compute = ctx.ofType('azure_vm', 'azure_vmss', 'azure_app_service', 'azure_functions', 'azure_aks');
      if (dbs.length === 0 || compute.length === 0) return [{ status: 'NOT_APPLICABLE', observation: 'No database + compute combination.', evidence: [] }];
      const caches = ctx.ofType('azure_redis');
      const evidence = [{ label: 'Databases', observed: String(dbs.length), basis: 'TOPOLOGY' as const }, { label: 'Caches', observed: String(caches.length), basis: 'TOPOLOGY' as const }];
      return caches.length > 0 ? [{ status: 'PASS', observation: 'Azure Cache for Redis is modelled.', evidence, resourceIds: caches.map((c) => c.id) }]
        : [{ status: 'WARNING', observation: 'No caching layer is modelled.', evidence, resourceIds: dbs.map((d) => d.id) }];
    },
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Subscription / tenant-level controls — never assumed
  // ════════════════════════════════════════════════════════════════════════
  ...([
    ['AZ-ACCT-001', 'Microsoft Defender for Cloud', 'Microsoft Defender for Cloud plans', 'MCSB-LT-1', 'Threat detection', 'HIGH', ['SOC1-OP-02'], 'Threats against resources may go undetected.', 'Enable the Defender for Cloud plans relevant to the workload (Servers, SQL, Storage, Containers, Key Vault).', 'SE:10 — Monitoring and threat detection'],
    ['AZ-ACCT-002', 'Azure Monitor', 'Activity log export and diagnostic settings', 'MCSB-LT-3', 'Logging & audit', 'MEDIUM', ['SOC1-OP-01', 'SOC1-CM-01'], 'Control-plane changes may not be retained for investigation.', 'Export the subscription Activity Log and resource logs to a Log Analytics workspace with defined retention.', 'SE:10 — Monitoring and threat detection'],
    ['AZ-ACCT-003', 'Microsoft Entra ID', 'Multifactor authentication / Conditional Access', 'MCSB-IM-6', 'Identity & access', 'HIGH', ['SOC1-LA-03'], 'Privileged and user sign-ins may be protected by passwords only.', 'Require MFA through Conditional Access for all users, and phishing-resistant MFA for privileged roles.', 'SE:05 — Identity and access management'],
  ] as const).map(([id, service, what, ref, category, severity, soc1, risk, rec, practice]) => rule({
    ...common,
    id, service, scope: 'account', domain: 'SECURITY', category, severity, priority: 'REQUIRED_REMEDIATION',
    title: `${what} — subscription/tenant-level control`,
    description: `${what} is configured at the subscription or tenant level, outside an architecture diagram.`,
    rationale: 'Reported NOT EVALUATED at design time. CloudCraft never assumes subscription or tenant controls are enabled.',
    risk, impact: 'Reduced detection, audit or identity protection.',
    wellArchitected: WA.sec(practice),
    references: [ref, 'AZ-WA-security'],
    soc1: [...soc1],
    remediation: { recommendation: rec, manualSteps: [rec] },
    evaluateArchitecture: (ctx) => ctx.providers.includes('azure')
      ? [notModelled(what, 'Evidence from the Azure subscription/tenant (e.g. Defender for Cloud secure score export or connected subscription discovery).')]
      : [{ status: 'NOT_APPLICABLE', observation: 'No Azure resources.', evidence: [] }],
  })),
];
