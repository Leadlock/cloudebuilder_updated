/**
 * Azure Well-Architected Framework Rules
 *
 * Rules organized by official Azure WAF pillar (5 pillars).
 * Each rule:
 *  - Maps to the official pillar documentation URL
 *  - Only fires when there is explicit evidence in the config
 *  - Never fires when the relevant field is absent/unknown
 *  - Carries full source attribution
 *
 * Source: https://learn.microsoft.com/azure/well-architected/
 */
import type { WaRule } from '../types';
import { AZURE_PILLARS } from '../frameworkDefinitions';

// ─── Helper ───────────────────────────────────────────────────────────────────

function pillar(id: string) {
  return AZURE_PILLARS.find((p) => p.id === id)!;
}

function makeRef(pillarId: string): string {
  const p = pillar(pillarId);
  return `Microsoft Azure Well-Architected Framework — ${p.label}`;
}

// ─── Reliability Rules ────────────────────────────────────────────────────────

const RE_PILLAR = pillar('reliability');

const azureRelRules: WaRule[] = [
  {
    ruleId: 'AZ-WAF-RE-01',
    provider: 'azure',
    pillar: 'reliability',
    pillarLabel: RE_PILLAR.label,
    pillarRef: RE_PILLAR.referenceUrl,
    severity: 'high',
    title: 'No load balancer for Azure VMs',
    description: 'Azure Virtual Machines are deployed without an Azure Load Balancer or Application Gateway. Traffic to a single VM creates a single point of failure.',
    frameworkReference: makeRef('reliability'),
    source: 'DESIGN_TIME',
    remediation: 'Add an Azure Load Balancer or Application Gateway in front of multiple VMs across Availability Zones.',
    check(resource, config, allResources) {
      const vms = allResources.filter((r) => r.provider === 'azure' && r.resourceType === 'azure_vm');
      if (vms.length === 0) return null;
      if (resource.id !== vms[0].id) return null;
      const hasLb = allResources.some((r) =>
        ['azure_load_balancer', 'azure_application_gateway', 'azure_agw'].includes(r.resourceType)
      );
      if (hasLb) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: vms.map((r) => r.id),
        affectedResourceLabels: vms.map((r) => r.label),
        evidence: { vmCount: vms.length, loadBalancerFound: false },
        recommendation: 'Add an Azure Application Gateway or Standard Load Balancer to distribute traffic across VMs in multiple Availability Zones.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AZ-WAF-RE-02',
    provider: 'azure',
    pillar: 'reliability',
    pillarLabel: RE_PILLAR.label,
    pillarRef: RE_PILLAR.referenceUrl,
    severity: 'high',
    title: 'Azure SQL not configured for geo-redundancy or zone-redundancy',
    description: 'Azure SQL is deployed without zone-redundant or geo-redundant configuration, reducing the durability and availability of the database.',
    frameworkReference: makeRef('reliability'),
    source: 'DESIGN_TIME',
    remediation: 'Configure Azure SQL with zone-redundant storage or enable geo-replication for cross-region disaster recovery.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_sql') return null;
      if (config['zoneRedundant'] !== false) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { zoneRedundant: config['zoneRedundant'] },
        recommendation: 'Enable zone-redundant or geo-redundant backup on Azure SQL for production databases.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AZ-WAF-RE-03',
    provider: 'azure',
    pillar: 'reliability',
    pillarLabel: RE_PILLAR.label,
    pillarRef: RE_PILLAR.referenceUrl,
    severity: 'medium',
    title: 'Single Azure VM — no high availability',
    description: 'Only one Azure VM is present with no availability set or zone configuration. Any VM restart or hardware failure causes downtime.',
    frameworkReference: makeRef('reliability'),
    source: 'DESIGN_TIME',
    remediation: 'Deploy VMs in Availability Zones or Availability Sets with at least 2 instances. Use Azure VM Scale Sets for elastic workloads.',
    check(resource, config, allResources) {
      if (resource.resourceType !== 'azure_vm') return null;
      const vms = allResources.filter((r) => r.resourceType === 'azure_vm');
      if (vms.length !== 1) return null;
      if (resource.id !== vms[0].id) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { vmCount: 1 },
        recommendation: 'Deploy at least 2 VMs across different Availability Zones and place them behind a Load Balancer.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
];

// ─── Security Rules ───────────────────────────────────────────────────────────

const SEC_PILLAR = pillar('security');

const azureSecRules: WaRule[] = [
  {
    ruleId: 'AZ-WAF-SEC-01',
    provider: 'azure',
    pillar: 'security',
    pillarLabel: SEC_PILLAR.label,
    pillarRef: SEC_PILLAR.referenceUrl,
    severity: 'critical',
    title: 'NSG allows unrestricted RDP access (port 3389)',
    description: 'The Network Security Group allows inbound RDP (port 3389) from any IP address (0.0.0.0/0). RDP is actively scanned by attackers.',
    frameworkReference: makeRef('security'),
    source: 'DESIGN_TIME',
    remediation: 'Remove the unrestricted RDP rule. Use Azure Bastion for secure remote access without exposing RDP to the internet.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_nsg') return null;
      if (config['allowRdp'] !== true) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { allowRdp: config['allowRdp'] },
        recommendation: 'Deploy Azure Bastion and remove the RDP inbound rule from the NSG entirely.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AZ-WAF-SEC-02',
    provider: 'azure',
    pillar: 'security',
    pillarLabel: SEC_PILLAR.label,
    pillarRef: SEC_PILLAR.referenceUrl,
    severity: 'critical',
    title: 'Azure SQL Server publicly accessible',
    description: 'The Azure SQL Server allows public network access, making it reachable from the internet without network-level filtering.',
    frameworkReference: makeRef('security'),
    source: 'DESIGN_TIME',
    remediation: 'Disable public network access on Azure SQL Server and use private endpoints or VNet service endpoints.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_sql') return null;
      if (config['publicNetworkAccess'] !== true) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { publicNetworkAccess: config['publicNetworkAccess'] },
        recommendation: 'Set publicNetworkAccess = false and configure a private endpoint or VNet service endpoint for Azure SQL.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AZ-WAF-SEC-03',
    provider: 'azure',
    pillar: 'security',
    pillarLabel: SEC_PILLAR.label,
    pillarRef: SEC_PILLAR.referenceUrl,
    severity: 'high',
    title: 'Azure VM OS disk encryption disabled',
    description: 'The Azure VM OS disk does not have encryption enabled, leaving operating system data at rest unprotected.',
    frameworkReference: makeRef('security'),
    source: 'DESIGN_TIME',
    remediation: 'Enable Azure Disk Encryption (ADE) or server-side encryption with a Platform-managed or Customer-managed key.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_vm') return null;
      if (config['diskEncryption'] !== false) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { diskEncryption: config['diskEncryption'] },
        recommendation: 'Enable Azure Disk Encryption on all VM OS and data disks storing sensitive information.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AZ-WAF-SEC-04',
    provider: 'azure',
    pillar: 'security',
    pillarLabel: SEC_PILLAR.label,
    pillarRef: SEC_PILLAR.referenceUrl,
    severity: 'high',
    title: 'NSG allows unrestricted SSH access (port 22)',
    description: 'The Network Security Group permits inbound SSH (port 22) from any source (0.0.0.0/0).',
    frameworkReference: makeRef('security'),
    source: 'DESIGN_TIME',
    remediation: 'Restrict SSH ingress to known management IPs or use Azure Bastion for SSH-less administration.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_nsg') return null;
      if (config['allowSsh'] !== true) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { allowSsh: config['allowSsh'] },
        recommendation: 'Remove the public SSH inbound rule. Use Azure Bastion for secure VM access.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AZ-WAF-SEC-05',
    provider: 'azure',
    pillar: 'security',
    pillarLabel: SEC_PILLAR.label,
    pillarRef: SEC_PILLAR.referenceUrl,
    severity: 'high',
    title: 'Azure SQL Database Transparent Data Encryption disabled',
    description: 'TDE is disabled on the Azure SQL database, leaving data at rest unencrypted.',
    frameworkReference: makeRef('security'),
    source: 'DESIGN_TIME',
    remediation: 'Enable Transparent Data Encryption on all Azure SQL databases. TDE encrypts the entire database, backups, and logs.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_sql') return null;
      if (config['transparentDataEncryption'] !== false) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { transparentDataEncryption: config['transparentDataEncryption'] },
        recommendation: 'Enable TDE (transparentDataEncryption = true) on all Azure SQL databases.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
  {
    ruleId: 'AZ-WAF-SEC-06',
    provider: 'azure',
    pillar: 'security',
    pillarLabel: SEC_PILLAR.label,
    pillarRef: SEC_PILLAR.referenceUrl,
    severity: 'critical',
    title: 'Azure Storage allows public blob access',
    description: 'The Azure Storage account has anonymous public blob access enabled, allowing unauthorized reads from the internet.',
    frameworkReference: makeRef('security'),
    source: 'DESIGN_TIME',
    remediation: 'Disable public blob access by setting allowBlobPublicAccess = false. Use Azure CDN with a private origin for public content delivery.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_storage') return null;
      if (config['allowBlobPublicAccess'] !== true) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { allowBlobPublicAccess: config['allowBlobPublicAccess'] },
        recommendation: 'Set allowBlobPublicAccess = false and use Azure CDN or SAS tokens for controlled access.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
];

// ─── Cost Optimization Rules ──────────────────────────────────────────────────

const CO_PILLAR = pillar('cost_optimization');

const azureCostRules: WaRule[] = [
  {
    ruleId: 'AZ-WAF-CO-01',
    provider: 'azure',
    pillar: 'cost_optimization',
    pillarLabel: CO_PILLAR.label,
    pillarRef: CO_PILLAR.referenceUrl,
    severity: 'low',
    title: 'Large Azure VM size — right-sizing opportunity',
    description: 'Large Azure VM sizes may be over-provisioned without utilization data to justify the size.',
    frameworkReference: makeRef('cost_optimization'),
    source: 'DESIGN_TIME',
    remediation: 'Use Azure Advisor (in portal) to get right-sizing recommendations. Enable VM auto-shutdown for dev/test environments.',
    check(resource, config) {
      if (resource.resourceType !== 'azure_vm') return null;
      const size = (config['size'] as string) ?? '';
      const isLarge = size.match(/_[EKLRSD]?[0-9]*[24][0-9]?/) !== null || size.includes('Standard_E') || size.includes('Standard_M');
      if (!isLarge) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: [resource.id], affectedResourceLabels: [resource.label],
        evidence: { size },
        recommendation: 'Review CPU and memory utilization. Downsize if average CPU is under 40% over a 7-day period.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
];

// ─── Operational Excellence Rules ─────────────────────────────────────────────

const OE_PILLAR = pillar('operational_excellence');

const azureOeRules: WaRule[] = [
  {
    ruleId: 'AZ-WAF-OE-01',
    provider: 'azure',
    pillar: 'operational_excellence',
    pillarLabel: OE_PILLAR.label,
    pillarRef: OE_PILLAR.referenceUrl,
    severity: 'medium',
    title: 'No monitoring resources detected in Azure architecture',
    description: 'The architecture has no Azure Monitor or Application Insights resources. Operational excellence requires observability.',
    frameworkReference: makeRef('operational_excellence'),
    source: 'DESIGN_TIME',
    remediation: 'Add Azure Monitor and Application Insights to track performance, availability, and failures. Set up action groups and alerts.',
    check(resource, config, allResources) {
      const azureResources = allResources.filter((r) => r.provider === 'azure');
      if (azureResources.length === 0) return null;
      if (resource.id !== azureResources[0].id) return null; // Run once
      const hasMonitoring = allResources.some((r) =>
        ['azure_monitor', 'azure_log_analytics', 'azure_application_insights'].includes(r.resourceType)
      );
      if (hasMonitoring) return null;
      if (azureResources.length < 2) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: azureResources.map((r) => r.id),
        affectedResourceLabels: azureResources.map((r) => r.label),
        evidence: { azureResourceCount: azureResources.length, monitoringFound: false },
        recommendation: 'Add Azure Monitor and configure metric alerts for critical resources.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
];

// ─── Performance Efficiency Rules ─────────────────────────────────────────────

const PE_PILLAR = pillar('performance_efficiency');

const azurePerfRules: WaRule[] = [
  {
    ruleId: 'AZ-WAF-PE-01',
    provider: 'azure',
    pillar: 'performance_efficiency',
    pillarLabel: PE_PILLAR.label,
    pillarRef: PE_PILLAR.referenceUrl,
    severity: 'low',
    title: 'No caching layer for Azure SQL-backed application',
    description: 'Azure SQL and compute resources are present without a caching layer. Repeated identical queries increase latency and load.',
    frameworkReference: makeRef('performance_efficiency'),
    source: 'DESIGN_TIME',
    remediation: 'Add Azure Cache for Redis to cache frequently-read data, session state, and computed results.',
    check(resource, config, allResources) {
      const sqls = allResources.filter((r) => r.resourceType === 'azure_sql');
      const computes = allResources.filter((r) =>
        ['azure_vm', 'azure_app_service', 'azure_function_app'].includes(r.resourceType)
      );
      if (sqls.length === 0 || computes.length === 0) return null;
      if (resource.id !== sqls[0].id) return null;
      const hasCache = allResources.some((r) => r.resourceType === 'azure_redis_cache');
      if (hasCache) return null;
      return {
        ruleId: this.ruleId, provider: this.provider, pillar: this.pillar,
        pillarLabel: this.pillarLabel, pillarRef: this.pillarRef,
        severity: this.severity, title: this.title, description: this.description,
        affectedResourceIds: sqls.map((r) => r.id),
        affectedResourceLabels: sqls.map((r) => r.label),
        evidence: { sqlCount: sqls.length, cacheFound: false },
        recommendation: 'Add Azure Cache for Redis to reduce database load and improve application response time.',
        remediation: this.remediation,
        frameworkReference: this.frameworkReference,
        source: this.source,
        sourceLabel: 'Design-time assessment',
      };
    },
  },
];

// ─── Export all Azure WAF rules ───────────────────────────────────────────────

export const azureWaRules: WaRule[] = [
  ...azureRelRules,
  ...azureSecRules,
  ...azureCostRules,
  ...azureOeRules,
  ...azurePerfRules,
];
