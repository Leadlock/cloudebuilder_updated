/**
 * Assessment rules for the Azure managed services in lib/resources/azureServices.ts, and for Private Endpoints.
 *
 * Same conventions as azure.ts: every rule reads settings that exist in the resource definition and in the Terraform generator
 * (lib/engines/terraform/azureServices.ts), so __tests__/ruleSchemaConsistency.test.ts can check them. New rules are LOW or MEDIUM
 * unless a design is actually broken by the finding, and a fix that changes how clients connect is REVIEW_REQUIRED or MANUAL_ONLY.
 */
import type { RuleDefinition } from '../types';
import { REVIEWED, configEvaluator, ev, rule, isMissing } from '../ruleHelpers';
import { PRIVATE_LINK_TARGETS, needsPrivateEndpoint } from '../privateAccess';

const V = '1.0.0';
const TF = 'TF-AZURERM';
/** Resource types that call a service over the network: the ones that need a path to it. */
const CALLERS = new Set(['azure_vm', 'azure_vmss', 'azure_functions', 'azure_app_service', 'azure_aks', 'azure_container_apps']);
const common = { version: V, lastReviewed: REVIEWED, provider: 'azure' as const };
const WA = {
  sec: (practice: string) => ({ pillar: 'security' as const, practice }),
  rel: (practice: string) => ({ pillar: 'reliability' as const, practice }),
  ops: (practice: string) => ({ pillar: 'operational_excellence' as const, practice }),
};

// ─── PostgreSQL / MySQL flexible servers share their rules ───────────────────

interface Flex { type: 'azure_postgres' | 'azure_mysql'; prefix: 'PG' | 'MY'; engine: string; service: string; tf: string; sqlTls: RegExp }

const FLEX: Flex[] = [
  { type: 'azure_postgres', prefix: 'PG', engine: 'PostgreSQL', service: 'Azure Database for PostgreSQL', tf: 'azurerm_postgresql_flexible_server', sqlTls: /value\s*=\s*"on"/ },
  { type: 'azure_mysql', prefix: 'MY', engine: 'MySQL', service: 'Azure Database for MySQL', tf: 'azurerm_mysql_flexible_server', sqlTls: /value\s*=\s*"ON"/ },
];

const flexRules = (f: Flex): RuleDefinition[] => [
  rule({
    ...common,
    id: `AZ-${f.prefix}-001`, service: f.service, scope: 'resource', resourceTypes: [f.type],
    domain: 'SECURITY', category: 'Network exposure', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: `${f.engine} flexible server allows public network access`,
    description: `The server has a public endpoint, reachable from the internet subject to its firewall rules and authentication.`,
    rationale: 'MCSB NS-2: keep data services off the public internet. A flexible server with private access is placed in a delegated subnet of the application network.',
    risk: 'The database endpoint is reachable from the internet.', impact: 'Unauthorized data access, brute-force and exploitation attempts against the database.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Turn public access off and place the server in a subnet reserved for flexible servers.', manualSteps: ['Create a subnet delegated to the flexible server service.', 'Create the server with private access in that subnet.'], terraform: `${f.tf}.delegated_subnet_id and private_dns_zone_id` },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Making a server private means placing it in its own subnet, and an existing server cannot be moved into one without being recreated.', description: 'Manual: place the server in its own subnet and turn public access off.', patch: () => ({}), architectureImpact: 'Only clients in the network can connect.', costImpact: 'NONE' },
    evaluate: configEvaluator(['publicNetworkAccess'], { publicNetworkAccess: 'Disabled / No' }, (c) => c.publicNetworkAccess === true
      ? { status: 'FAIL', observation: 'Public network access is enabled.' }
      : { status: 'PASS', observation: 'Public network access is disabled (private access through a subnet).' }),
  }),
  rule({
    ...common,
    id: `AZ-${f.prefix}-002`, service: f.service, scope: 'resource', resourceTypes: [f.type],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: `${f.engine} flexible server does not require TLS`,
    description: 'Clients can connect without encryption.',
    rationale: 'MCSB DP-3: encrypt data in transit. The server parameter require_secure_transport rejects unencrypted connections.',
    risk: 'Credentials and data can be read on the network path.', impact: 'Interception of data and credentials.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-3', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Require TLS for all connections.', manualSteps: ['Set require_secure_transport to on.', 'Update clients that connect without TLS.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Clients that connect without TLS will be refused.', description: 'Require TLS.', patch: () => ({ requireSecureTransport: true }),
      architectureImpact: 'Unencrypted connections are refused.', costImpact: 'NONE', terraformExpect: f.sqlTls,
    },
    evaluate: configEvaluator(['requireSecureTransport'], { requireSecureTransport: 'Enabled / Yes' }, (c) => c.requireSecureTransport === false
      ? { status: 'FAIL', observation: 'TLS is not required.' }
      : { status: 'PASS', observation: 'TLS is required.' }),
  }),
  rule({
    ...common,
    id: `AZ-${f.prefix}-010`, service: f.service, scope: 'resource', resourceTypes: [f.type],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: `${f.engine} flexible server is not zone-redundant`,
    description: 'High availability is off on a size that supports it, so a zone failure takes the database down.',
    rationale: 'Azure Well-Architected Reliability (redundancy). Burstable sizes do not offer zone-redundant high availability, so they are not evaluated.',
    risk: 'A zonal failure makes the database unavailable until Azure recovers it.', impact: 'Outage during zone incidents.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Enable zone-redundant high availability for production databases on General Purpose or Memory Optimized sizes.', manualSteps: ['Confirm the region has availability zones.', 'Enable zone-redundant high availability.'], terraform: `${f.tf}.high_availability { mode = "ZoneRedundant" }` },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Doubles compute and storage cost and is only offered in regions with availability zones.',
      description: 'Enable zone-redundant high availability.', patch: () => ({ highAvailability: 'ZoneRedundant' }),
      architectureImpact: 'A standby replica runs in another zone.', costImpact: 'POSSIBLE_INCREASE', terraformExpect: /mode\s*=\s*"ZoneRedundant"/,
    },
    evaluate: configEvaluator(['skuName', 'highAvailability'], {}, (c) => {
      if (String(c.skuName).startsWith('B_')) return { status: 'NOT_APPLICABLE', observation: 'Burstable sizes do not offer zone-redundant high availability.' };
      return c.highAvailability === 'ZoneRedundant'
        ? { status: 'PASS', observation: 'Zone-redundant high availability is enabled.' }
        : { status: 'FAIL', observation: `High availability is ${String(c.highAvailability)} on ${String(c.skuName)}.` };
    }),
  }),
  rule({
    ...common,
    id: `AZ-${f.prefix}-011`, service: f.service, scope: 'resource', resourceTypes: [f.type],
    domain: 'RELIABILITY', category: 'Data protection', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: `${f.engine} backups are not geo-redundant`,
    description: 'Backups are kept in the server\'s own region only.',
    rationale: 'Azure Well-Architected Reliability (BCDR): geo-redundant backups allow a restore in the paired region after a regional loss. LOW because it adds cost and may conflict with data residency.',
    risk: 'Backups are lost with the region.', impact: 'Inability to restore after a regional incident.',
    wellArchitected: WA.rel('RE:09 — Business continuity and disaster recovery'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-03'],
    remediation: { recommendation: 'Enable geo-redundant backup unless data residency forbids it.', manualSteps: ['Confirm residency requirements.', 'Enable geo-redundant backup (set at creation).'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Geo-redundant backup can only be chosen when the server is created, may conflict with data residency, and costs more.',
      description: 'Enable geo-redundant backup.', patch: () => ({ geoRedundantBackup: true }),
      architectureImpact: 'Backups are copied to the paired region.', costImpact: 'POSSIBLE_INCREASE', terraformExpect: /geo_redundant_backup_enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['geoRedundantBackup'], { geoRedundantBackup: 'Enabled / Yes' }, (c) => c.geoRedundantBackup === true
      ? { status: 'PASS', observation: 'Backups are geo-redundant.' }
      : { status: 'WARNING', observation: 'Backups stay in the server\'s region.' }),
  }),
  rule({
    ...common,
    id: `AZ-${f.prefix}-012`, service: f.service, scope: 'resource', resourceTypes: [f.type],
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: `Private ${f.engine} flexible server is not placed in a subnet`,
    description: 'Public access is off, but the server is not inside a subnet, so it cannot be created as a private server.',
    rationale: 'A flexible server with private access is injected into a subnet delegated to its service. Without a subnet the generated Terraform creates it with a public endpoint, contrary to the design.',
    risk: 'The deployed server is public although the design says private.', impact: 'Unexpected public exposure; deployment differs from the design.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Place the server in a subnet that holds nothing but flexible servers.', manualSteps: ['Add a subnet for the database.', 'Drag the server into it.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Needs a subnet with its own address range.', description: 'Manual: place the server in its own subnet.', patch: () => ({}), architectureImpact: 'The server gets a private address.', costImpact: 'NONE' },
    evaluate: (r, ctx) => {
      const evidence = [ev(r, 'publicNetworkAccess', 'Disabled / No')];
      if (isMissing(r.config['publicNetworkAccess'])) return { status: 'INSUFFICIENT_DATA', observation: 'The public access setting is not specified.', evidence, requiredData: 'Set or import: Public Network Access.' };
      if (r.config['publicNetworkAccess'] === true) return { status: 'NOT_APPLICABLE', observation: 'The server is public, so it is not placed in a subnet.', evidence };
      const parent = r.parentId ? ctx.byId.get(r.parentId) : undefined;
      const others = parent ? ctx.resources.filter((x) => x.parentId === parent.id && x.id !== r.id && x.resourceType !== 'azure_nsg' && x.resourceType !== f.type) : [];
      if (!parent || parent.resourceType !== 'azure_subnet') return { status: 'FAIL', observation: 'The server is not inside a subnet.', evidence };
      if (others.length > 0) return { status: 'FAIL', observation: `The subnet also holds ${others.map((o) => o.label).join(', ')}, but a subnet delegated to a flexible server can hold nothing else.`, evidence };
      return { status: 'PASS', observation: 'The server is in a subnet of its own.', evidence };
    },
  }),
];

export const azureServiceRules: RuleDefinition[] = [
  ...FLEX.flatMap(flexRules),

  // ════════════════════════════════════════════════════════════════════════
  // Private endpoints
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-PE-001', service: 'Azure Private Link', scope: 'resource', resourceTypes: Object.keys(PRIVATE_LINK_TARGETS),
    domain: 'SECURITY', category: 'Network exposure', severity: 'HIGH', priority: 'REQUIRED_REMEDIATION',
    title: 'Service has no public endpoint and no Private Endpoint, so nothing can reach it',
    description: 'Public network access is off, but the design has no Private Endpoint giving the application a private path to the service.',
    rationale: 'MCSB NS-2. Turning the public endpoint off is the right security default, but it only works together with a Private Endpoint in the application network and a private DNS zone. Without one the service is unreachable, so the application fails at runtime however secure the design looks.',
    risk: 'The application cannot connect to the service.', impact: 'Application outage after deployment.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Add a Private Endpoint in a subnet of the application network and connect it to the service (CloudCraft creates the private DNS zone and link).', manualSteps: ['Add a Private Endpoint to a subnet.', 'Connect it to the service.'], terraform: 'azurerm_private_endpoint with a private_dns_zone_group' },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Adds a resource and a connection to the diagram.', description: 'Manual: add and connect a Private Endpoint.', patch: () => ({}), architectureImpact: 'The service gets a private address in the subnet.', costImpact: 'POSSIBLE_INCREASE' },
    evaluate: (r, ctx) => {
      const t = PRIVATE_LINK_TARGETS[r.resourceType]!;
      const missing = t.reads.filter((k) => isMissing(r.config[k]));
      const evidence = t.reads.map((k) => ev(r, k));
      if (missing.length > 0) return { status: 'INSUFFICIENT_DATA', observation: 'The settings that decide whether the service is public are not specified.', evidence, requiredData: `Set or import: ${missing.join(', ')}.` };
      if (!needsPrivateEndpoint(r.resourceType, r.config)) return { status: 'PASS', observation: `${t.label} has a public endpoint, so it is reachable without a Private Endpoint (see its own network rules).`, evidence };
      // Only a service something connects to needs a way in. One nobody calls (a bucket being configured, say) is not unreachable, it is unused.
      const callers = ctx.neighbors(r.id).filter((n) => CALLERS.has(n.resourceType));
      if (callers.length === 0) return { status: 'NOT_APPLICABLE', observation: `No application is connected to this ${t.label}, so it does not need a private path yet.`, evidence };
      const endpoints = ctx.neighbors(r.id).filter((n) => n.resourceType === 'azure_private_endpoint');
      const withEvidence = [...evidence, { label: 'Private endpoints', observed: String(endpoints.length), basis: 'TOPOLOGY' as const }];
      return endpoints.length > 0
        ? { status: 'PASS', observation: `Reached privately through ${endpoints.map((e) => e.label).join(', ')}.`, evidence: withEvidence, resourceIds: [r.id, ...endpoints.map((e) => e.id)] }
        : { status: 'FAIL', observation: `${t.label} has public access off and no Private Endpoint.`, evidence: withEvidence };
    },
  }),
  rule({
    ...common,
    id: 'AZ-PE-002', service: 'Azure Private Link', scope: 'resource', resourceTypes: ['azure_private_endpoint'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Private Endpoint is not connected to a service or not placed in a subnet',
    description: 'A Private Endpoint must sit in a subnet and be connected to the service it exposes, or no Terraform is generated for it.',
    rationale: 'The endpoint is a network interface in a subnet that maps to one service. Without both, it does nothing.',
    risk: 'The endpoint does not exist after deployment, so the service stays unreachable.', impact: 'Application outage.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Place the endpoint in a subnet and connect it to one service.', manualSteps: ['Drag the endpoint into a subnet.', 'Connect it to the service it should reach.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Needs a choice of subnet and service.', description: 'Manual: place and connect the endpoint.', patch: () => ({}), architectureImpact: 'The endpoint is created.', costImpact: 'NONE' },
    evaluate: (r, ctx) => {
      const parent = r.parentId ? ctx.byId.get(r.parentId) : undefined;
      const targets = ctx.neighbors(r.id).filter((n) => n.resourceType in PRIVATE_LINK_TARGETS);
      const evidence = [{ label: 'Subnet', observed: parent?.resourceType === 'azure_subnet' ? parent.label : 'None', basis: 'TOPOLOGY' as const }, { label: 'Connected services', observed: targets.length === 0 ? 'None' : targets.map((t) => t.label).join(', '), basis: 'TOPOLOGY' as const }];
      const problems: string[] = [];
      if (parent?.resourceType !== 'azure_subnet') problems.push('it is not inside a subnet');
      if (targets.length === 0) problems.push('it is not connected to a service it can reach');
      if (targets.length > 1) problems.push('it is connected to more than one service (one endpoint reaches one service)');
      return problems.length > 0
        ? { status: 'FAIL', observation: `The endpoint ${problems.join(' and ')}.`, evidence }
        : { status: 'PASS', observation: `The endpoint reaches ${targets[0]!.label} from ${parent!.label}.`, evidence, resourceIds: [r.id, targets[0]!.id] };
    },
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Service Bus
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-SB-001', service: 'Azure Service Bus', scope: 'resource', resourceTypes: ['azure_service_bus'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Service Bus namespace is reachable from the internet',
    description: 'Public network access is on. Access still needs credentials, but the endpoint is open to anyone who has them.',
    rationale: 'MCSB NS-2. Private access (Private Endpoint) needs the Premium tier, which costs about $677 a month per messaging unit, so this is a recommendation and not a defect: Standard with TLS and Entra ID or keys is a common choice for modest workloads.',
    risk: 'Leaked credentials can be used from anywhere.', impact: 'Unauthorized sending or reading of messages.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'For sensitive workloads use the Premium tier with a Private Endpoint and turn public access off.', manualSteps: ['Switch to the Premium tier.', 'Add a Private Endpoint.', 'Turn public network access off.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Needs the Premium tier and a Private Endpoint; turning public access off alone cuts every client off.', description: 'Manual: Premium tier + Private Endpoint.', patch: () => ({}), architectureImpact: 'Private access only.', costImpact: 'POSSIBLE_INCREASE' },
    evaluate: configEvaluator(['publicNetworkAccess', 'sku'], { publicNetworkAccess: 'Disabled / No' }, (c) => c.publicNetworkAccess === false
      ? { status: 'PASS', observation: 'Public network access is disabled.' }
      : { status: 'WARNING', observation: c.sku === 'Premium' ? 'Public network access is enabled on the Premium tier, which supports a Private Endpoint.' : `Public network access is enabled; private access needs the Premium tier (this is the ${String(c.sku)} tier).` }),
  }),
  rule({
    ...common,
    id: 'AZ-SB-002', service: 'Azure Service Bus', scope: 'resource', resourceTypes: ['azure_service_bus'],
    domain: 'SECURITY', category: 'Identity & access', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Service Bus allows shared access keys',
    description: 'Shared access signature keys can send and receive. They do not expire and are hard to scope.',
    rationale: 'MCSB IM-1 / IM-3: prefer Microsoft Entra ID (managed identities) over keys. LOW because turning keys off needs a role assignment for each application, which CloudCraft does not generate.',
    risk: 'A leaked key gives full send and receive access until it is rotated.', impact: 'Unauthorized access to messages.',
    wellArchitected: WA.sec('SE:05 — Identity and access management'),
    references: ['AZ-WA-security', TF],
    soc1: ['SOC1-LA-02'],
    remediation: { recommendation: 'Disable shared access keys and give each application a managed identity with the Azure Service Bus Data Sender / Receiver role.', manualSteps: ['Assign data roles to the applications\' managed identities.', 'Disable shared access keys.'], terraform: 'azurerm_servicebus_namespace.local_auth_enabled = false' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Any client using a connection string stops working until it uses Entra ID.',
      description: 'Disable shared access keys.', patch: () => ({ localAuthEnabled: false }), architectureImpact: 'Only Entra ID authentication is accepted.', costImpact: 'NONE', terraformExpect: /local_auth_enabled\s*=\s*false/,
    },
    evaluate: configEvaluator(['localAuthEnabled'], { localAuthEnabled: 'Disabled / No' }, (c) => c.localAuthEnabled === false
      ? { status: 'PASS', observation: 'Shared access keys are disabled.' }
      : { status: 'WARNING', observation: 'Shared access keys are allowed.' }),
  }),
  rule({
    ...common,
    id: 'AZ-SB-003', service: 'Azure Service Bus', scope: 'resource', resourceTypes: ['azure_service_bus'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Service Bus permits TLS versions older than 1.2',
    description: 'The minimum TLS version is 1.0 or 1.1.',
    rationale: 'MCSB DP-3.',
    risk: 'Clients can negotiate deprecated TLS.', impact: 'Weaker transport encryption.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-3', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Set the minimum TLS version to 1.2.', manualSteps: ['Set minimum TLS version to 1.2.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Legacy clients may not support TLS 1.2.', description: 'Set minimum TLS to 1.2.', patch: () => ({ minimumTlsVersion: '1.2' }),
      architectureImpact: 'TLS < 1.2 refused.', costImpact: 'NONE', terraformExpect: /minimum_tls_version\s*=\s*"1\.2"/,
    },
    evaluate: configEvaluator(['minimumTlsVersion'], { minimumTlsVersion: '1.2' }, (c) => ['1.0', '1.1'].includes(String(c.minimumTlsVersion))
      ? { status: 'FAIL', observation: `Minimum TLS version is ${String(c.minimumTlsVersion)}.` }
      : { status: 'PASS', observation: `Minimum TLS version is ${String(c.minimumTlsVersion)}.` }),
  }),
  rule({
    ...common,
    id: 'AZ-SB-010', service: 'Azure Service Bus', scope: 'resource', resourceTypes: ['azure_service_bus'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Premium Service Bus namespace is not zone-redundant',
    description: 'A Premium namespace can spread across availability zones; this one does not.',
    rationale: 'Azure Well-Architected Reliability (redundancy). Only the Premium tier offers zone redundancy, so other tiers are not evaluated.',
    risk: 'A zone failure interrupts messaging.', impact: 'Outage during zone incidents.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Enable zone redundancy on the Premium namespace.', manualSteps: ['Confirm the region has availability zones.', 'Enable zone redundancy.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Only available in regions with availability zones; cannot be changed on an existing namespace.', description: 'Enable zone redundancy.', patch: () => ({ zoneRedundant: true }),
      architectureImpact: 'Messaging is spread across zones.', costImpact: 'NONE', terraformExpect: /zone_redundant\s*=\s*true/,
    },
    evaluate: configEvaluator(['sku', 'zoneRedundant'], {}, (c) => c.sku !== 'Premium'
      ? { status: 'NOT_APPLICABLE', observation: `Zone redundancy is offered on the Premium tier only (this is the ${String(c.sku)} tier).` }
      : c.zoneRedundant === true ? { status: 'PASS', observation: 'Zone redundancy is enabled.' } : { status: 'WARNING', observation: 'Zone redundancy is disabled.' }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Container Registry
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-ACR-001', service: 'Azure Container Registry', scope: 'resource', resourceTypes: ['azure_acr'],
    domain: 'SECURITY', category: 'Identity & access', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Container Registry admin user is enabled',
    description: 'The admin user is one shared username and password for the whole registry.',
    rationale: 'Microsoft recommends disabling the admin account: it cannot be scoped or audited per person and its password does not expire. Use managed identities or repository-scoped tokens.',
    risk: 'A leaked password gives push and pull access to every image.', impact: 'Image tampering and theft.',
    wellArchitected: WA.sec('SE:05 — Identity and access management'),
    references: ['MCSB-IM-1', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-02'],
    remediation: { recommendation: 'Disable the admin user; let the platform pull images with its managed identity.', manualSteps: ['Grant the AcrPull role to the workload identity.', 'Disable the admin user.'], terraform: 'azurerm_container_registry.admin_enabled = false' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Anything pulling images with the admin credentials stops working.', description: 'Disable the admin user.', patch: () => ({ adminEnabled: false }),
      architectureImpact: 'Admin sign-in is refused.', costImpact: 'NONE', terraformExpect: /admin_enabled\s*=\s*false/,
    },
    evaluate: configEvaluator(['adminEnabled'], { adminEnabled: 'Disabled / No' }, (c) => c.adminEnabled === true
      ? { status: 'FAIL', observation: 'The admin user is enabled.' }
      : { status: 'PASS', observation: 'The admin user is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-ACR-002', service: 'Azure Container Registry', scope: 'resource', resourceTypes: ['azure_acr'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Container Registry is reachable from the internet',
    description: 'Public network access is on. Pulling and pushing still needs credentials.',
    rationale: 'MCSB NS-2. Private access needs the Premium tier (about $50 a month) and a Private Endpoint, so this is a recommendation for sensitive images and not a defect.',
    risk: 'Leaked credentials work from anywhere.', impact: 'Image theft or tampering.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'For sensitive images use the Premium tier with a Private Endpoint and turn public access off.', manualSteps: ['Switch to the Premium tier.', 'Add a Private Endpoint.', 'Turn public network access off.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Needs the Premium tier and a Private Endpoint.', description: 'Manual: Premium tier + Private Endpoint.', patch: () => ({}), architectureImpact: 'Private access only.', costImpact: 'POSSIBLE_INCREASE' },
    evaluate: configEvaluator(['publicNetworkAccess', 'sku'], { publicNetworkAccess: 'Disabled / No' }, (c) => c.publicNetworkAccess === false
      ? { status: 'PASS', observation: 'Public network access is disabled.' }
      : { status: 'WARNING', observation: c.sku === 'Premium' ? 'Public network access is enabled on the Premium tier, which supports a Private Endpoint.' : `Public network access is enabled; private access needs the Premium tier (this is the ${String(c.sku)} tier).` }),
  }),
  rule({
    ...common,
    id: 'AZ-ACR-010', service: 'Azure Container Registry', scope: 'resource', resourceTypes: ['azure_acr'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Premium Container Registry is not zone-redundant',
    description: 'A Premium registry can be zone-redundant at no extra charge; this one is not.',
    rationale: 'Azure Well-Architected Reliability (redundancy). Zone redundancy is a Premium feature, so other tiers are not evaluated.',
    risk: 'A zone failure stops image pulls, so new instances cannot start.', impact: 'Slower recovery and failed scale-out during zone incidents.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Enable zone redundancy on the Premium registry.', manualSteps: ['Confirm the region has availability zones.', 'Enable zone redundancy.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Only available in regions with availability zones and fixed when the registry is created.', description: 'Enable zone redundancy.', patch: () => ({ zoneRedundant: true }),
      architectureImpact: 'The registry is spread across zones.', costImpact: 'NONE', terraformExpect: /zone_redundancy_enabled\s*=\s*true/,
    },
    evaluate: configEvaluator(['sku', 'zoneRedundant'], {}, (c) => c.sku !== 'Premium'
      ? { status: 'NOT_APPLICABLE', observation: `Zone redundancy is offered on the Premium tier only (this is the ${String(c.sku)} tier).` }
      : c.zoneRedundant === true ? { status: 'PASS', observation: 'Zone redundancy is enabled.' } : { status: 'WARNING', observation: 'Zone redundancy is disabled.' }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Azure Firewall
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-FW-001', service: 'Azure Firewall', scope: 'resource', resourceTypes: ['azure_firewall'],
    domain: 'SECURITY', category: 'Threat detection', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Azure Firewall threat intelligence is off',
    description: 'The firewall does not alert on or block traffic to and from known malicious addresses and domains.',
    rationale: 'MCSB NS-1 / LT-1: threat intelligence filtering is a built-in control of the firewall and costs nothing extra. "Alert" is the default; "Alert and deny" blocks as well.',
    risk: 'Traffic with known malicious hosts passes unnoticed.', impact: 'Undetected compromise and data exfiltration.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZ-WA-security', TF],
    soc1: ['SOC1-OP-02'],
    remediation: { recommendation: 'Set threat intelligence to "Alert" (or "Alert and deny").', manualSteps: ['Set the threat intelligence mode on the firewall policy.'], terraform: 'azurerm_firewall_policy.threat_intelligence_mode = "Alert"' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Alerts add log volume; "Alert and deny" can block legitimate traffic to a wrongly listed address.',
      description: 'Turn threat intelligence on in alert mode.', patch: () => ({ threatIntelMode: 'Alert' }),
      architectureImpact: 'Matches against Microsoft threat intelligence are logged.', costImpact: 'NONE', terraformExpect: /threat_intelligence_mode\s*=\s*"Alert"/,
    },
    evaluate: configEvaluator(['threatIntelMode'], { threatIntelMode: 'Alert or Deny' }, (c) => c.threatIntelMode === 'Off'
      ? { status: 'FAIL', observation: 'Threat intelligence is off.' }
      : { status: 'PASS', observation: `Threat intelligence mode is ${String(c.threatIntelMode)}.` }),
  }),
  rule({
    ...common,
    id: 'AZ-FW-010', service: 'Azure Firewall', scope: 'resource', resourceTypes: ['azure_firewall'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Azure Firewall is not spread across availability zones',
    description: 'A firewall deployed without zones is lost with its single zone, and every route through it fails.',
    rationale: 'Azure Well-Architected Reliability (RE:05). Zones add no charge for the firewall itself. Zones are fixed when the firewall is created.',
    risk: 'A zone outage cuts all traffic that is routed through the firewall.', impact: 'Outage during zone incidents.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Deploy the firewall across zones 1, 2 and 3 in a region that offers them.', manualSteps: ['Confirm the region has availability zones.', 'Set the zones setting.'] },
    evaluate: configEvaluator(['zones'], { zones: 'Zones 1, 2 and 3' }, (c) => typeof c.zones === 'string' && c.zones !== ''
      ? { status: 'PASS', observation: `Spread across zones ${String(c.zones).replace(/,/g, ', ')}.` }
      : { status: 'WARNING', observation: 'No availability zones are set.' }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Event Hubs and Event Grid
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-EH-001', service: 'Azure Event Hubs', scope: 'resource', resourceTypes: ['azure_event_hubs'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Event Hubs namespace is reachable from the internet',
    description: 'Public network access is on. Access still needs credentials.',
    rationale: 'MCSB NS-2. Private access needs a private endpoint, available on the Standard and Premium tiers, so this is a recommendation and not a defect.',
    risk: 'Leaked credentials work from anywhere.', impact: 'Unauthorized sending or reading of events.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Add a Private Endpoint and turn public access off.', manualSteps: ['Add a Private Endpoint.', 'Turn public network access off.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Turning public access off without a private endpoint cuts every client off.', description: 'Manual: Private Endpoint.', patch: () => ({}), architectureImpact: 'Private access only.', costImpact: 'POSSIBLE_INCREASE' },
    evaluate: configEvaluator(['publicNetworkAccess', 'sku'], { publicNetworkAccess: 'Disabled / No' }, (c) => c.publicNetworkAccess === false
      ? { status: 'PASS', observation: 'Public network access is disabled.' }
      : { status: 'WARNING', observation: c.sku === 'Basic' ? 'Public network access is enabled; private access needs the Standard or Premium tier (this is the Basic tier).' : 'Public network access is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-EH-002', service: 'Azure Event Hubs', scope: 'resource', resourceTypes: ['azure_event_hubs'],
    domain: 'SECURITY', category: 'Identity & access', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Event Hubs allows shared access keys',
    description: 'Shared access signature keys can send and receive. They do not expire and are hard to scope.',
    rationale: 'MCSB IM-1 / IM-3: prefer Microsoft Entra ID (managed identities). LOW because turning keys off needs a role assignment for each application, which CloudCraft does not generate.',
    risk: 'A leaked key gives full access until it is rotated.', impact: 'Unauthorized access to events.',
    wellArchitected: WA.sec('SE:05 — Identity and access management'),
    references: ['AZ-WA-security', TF],
    soc1: ['SOC1-LA-02'],
    remediation: { recommendation: 'Disable shared access keys and give each application a managed identity with the Azure Event Hubs Data Sender / Receiver role.', manualSteps: ['Assign data roles to the applications\' managed identities.', 'Disable shared access keys.'], terraform: 'azurerm_eventhub_namespace.local_authentication_enabled = false' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Any client using a connection string stops working until it uses Entra ID.',
      description: 'Disable shared access keys.', patch: () => ({ localAuthEnabled: false }), architectureImpact: 'Only Entra ID authentication is accepted.', costImpact: 'NONE', terraformExpect: /local_authentication_enabled\s*=\s*false/,
    },
    evaluate: configEvaluator(['localAuthEnabled'], { localAuthEnabled: 'Disabled / No' }, (c) => c.localAuthEnabled === false
      ? { status: 'PASS', observation: 'Shared access keys are disabled.' }
      : { status: 'WARNING', observation: 'Shared access keys are allowed.' }),
  }),
  rule({
    ...common,
    id: 'AZ-EH-003', service: 'Azure Event Hubs', scope: 'resource', resourceTypes: ['azure_event_hubs'],
    domain: 'SECURITY', category: 'Encryption in transit', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Event Hubs permits TLS versions older than 1.2',
    description: 'The minimum TLS version is 1.0 or 1.1.',
    rationale: 'MCSB DP-3.',
    risk: 'Clients can negotiate deprecated TLS.', impact: 'Weaker transport encryption.',
    wellArchitected: WA.sec('SE:07 — Encrypt data'),
    references: ['MCSB-DP-3', 'AZ-WA-security', TF],
    soc1: ['SOC1-DP-02'],
    remediation: { recommendation: 'Set the minimum TLS version to 1.2.', manualSteps: ['Set minimum TLS version to 1.2.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Legacy clients may not support TLS 1.2.', description: 'Set minimum TLS to 1.2.', patch: () => ({ minimumTlsVersion: '1.2' }),
      architectureImpact: 'TLS < 1.2 refused.', costImpact: 'NONE', terraformExpect: /minimum_tls_version\s*=\s*"1\.2"/,
    },
    evaluate: configEvaluator(['minimumTlsVersion'], { minimumTlsVersion: '1.2' }, (c) => ['1.0', '1.1'].includes(String(c.minimumTlsVersion))
      ? { status: 'FAIL', observation: `Minimum TLS version is ${String(c.minimumTlsVersion)}.` }
      : { status: 'PASS', observation: `Minimum TLS version is ${String(c.minimumTlsVersion)}.` }),
  }),
  rule({
    ...common,
    id: 'AZ-EH-010', service: 'Azure Event Hubs', scope: 'resource', resourceTypes: ['azure_event_hubs'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Event Hubs namespace is not zone-redundant',
    description: 'A zone failure interrupts event ingestion. The Basic tier does not offer zone redundancy, so it is not evaluated.',
    rationale: 'Azure Well-Architected Reliability (RE:05). Zone redundancy is chosen when the namespace is created, in regions that offer zones.',
    risk: 'A zone outage interrupts the event pipeline.', impact: 'Outage during zone incidents.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Enable zone redundancy on the namespace.', manualSteps: ['Confirm the region has availability zones.', 'Enable zone redundancy.'] },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Only available in regions with availability zones and fixed when the namespace is created.', description: 'Enable zone redundancy.', patch: () => ({ zoneRedundant: true }),
      architectureImpact: 'The namespace is spread across zones.', costImpact: 'NONE', terraformExpect: /zone_redundant\s*=\s*true/,
    },
    evaluate: configEvaluator(['sku', 'zoneRedundant'], {}, (c) => c.sku === 'Basic'
      ? { status: 'NOT_APPLICABLE', observation: 'The Basic tier does not offer zone redundancy.' }
      : c.zoneRedundant === true ? { status: 'PASS', observation: 'Zone redundancy is enabled.' } : { status: 'WARNING', observation: 'Zone redundancy is disabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-EG-001', service: 'Azure Event Grid', scope: 'resource', resourceTypes: ['azure_event_grid'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Event Grid topic is reachable from the internet',
    description: 'Public network access is on. Publishing still needs a key or Entra ID token.',
    rationale: 'MCSB NS-2. A private endpoint costs about $7 a month, so this is a recommendation for sensitive topics.',
    risk: 'Leaked keys work from anywhere.', impact: 'Unauthorized publishing of events.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Add a Private Endpoint and turn public access off.', manualSteps: ['Add a Private Endpoint.', 'Turn public network access off.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Turning public access off without a private endpoint cuts every publisher off.', description: 'Manual: Private Endpoint.', patch: () => ({}), architectureImpact: 'Private access only.', costImpact: 'POSSIBLE_INCREASE' },
    evaluate: configEvaluator(['publicNetworkAccess'], { publicNetworkAccess: 'Disabled / No' }, (c) => c.publicNetworkAccess === false
      ? { status: 'PASS', observation: 'Public network access is disabled.' }
      : { status: 'WARNING', observation: 'Public network access is enabled.' }),
  }),
  rule({
    ...common,
    id: 'AZ-EG-002', service: 'Azure Event Grid', scope: 'resource', resourceTypes: ['azure_event_grid'],
    domain: 'SECURITY', category: 'Identity & access', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Event Grid topic allows access keys',
    description: 'Access keys can publish to the topic. They do not expire and are hard to scope.',
    rationale: 'MCSB IM-1 / IM-3: prefer Microsoft Entra ID. LOW because turning keys off needs a role assignment for each publisher, which CloudCraft does not generate.',
    risk: 'A leaked key lets anyone publish events.', impact: 'Unauthorized events trigger downstream work.',
    wellArchitected: WA.sec('SE:05 — Identity and access management'),
    references: ['AZ-WA-security', TF],
    soc1: ['SOC1-LA-02'],
    remediation: { recommendation: 'Disable access keys and give publishers the Event Grid Data Sender role.', manualSteps: ['Assign data roles.', 'Disable access keys.'], terraform: 'azurerm_eventgrid_topic.local_auth_enabled = false' },
    autoFix: {
      safety: 'REVIEW_REQUIRED', safetyReason: 'Any publisher using a key stops working until it uses Entra ID.', description: 'Disable access keys.', patch: () => ({ localAuthEnabled: false }),
      architectureImpact: 'Only Entra ID authentication is accepted.', costImpact: 'NONE', terraformExpect: /local_auth_enabled\s*=\s*false/,
    },
    evaluate: configEvaluator(['localAuthEnabled'], { localAuthEnabled: 'Disabled / No' }, (c) => c.localAuthEnabled === false
      ? { status: 'PASS', observation: 'Access keys are disabled.' }
      : { status: 'WARNING', observation: 'Access keys are allowed.' }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // API Management and Container Apps
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-APIM-001', service: 'Azure API Management', scope: 'resource', resourceTypes: ['azure_api_management'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'API Management is on the Developer tier, which has no SLA',
    description: 'The Developer tier is meant for development and testing: it has no service level agreement and no redundancy.',
    rationale: 'Azure Well-Architected Reliability. LOW because the tier is a deliberate choice for non-production designs. Basic and above carry an SLA.',
    risk: 'The API front end can be down with no recourse.', impact: 'Outage with no availability guarantee.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Use the Basic, Standard or Premium tier (or Consumption) for production.', manualSteps: ['Change the tier.'] },
    evaluate: configEvaluator(['sku'], { sku: 'Basic or higher' }, (c) => c.sku === 'Developer'
      ? { status: 'WARNING', observation: 'The Developer tier has no SLA.' }
      : { status: 'PASS', observation: `The ${String(c.sku)} tier carries an SLA.` }),
  }),
  rule({
    ...common,
    id: 'AZ-APIM-010', service: 'Azure API Management', scope: 'resource', resourceTypes: ['azure_api_management'],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Premium API Management is not spread across availability zones',
    description: 'Only the Premium tier can use zones; this one does not.',
    rationale: 'Azure Well-Architected Reliability (RE:05). Other tiers are not evaluated.',
    risk: 'A zone outage takes the API front end down.', impact: 'Outage during zone incidents.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Set zones 1, 2 and 3 on the Premium instance.', manualSteps: ['Confirm the region has availability zones.', 'Set the zones setting.'] },
    evaluate: configEvaluator(['sku', 'zones'], {}, (c) => c.sku !== 'Premium'
      ? { status: 'NOT_APPLICABLE', observation: `Zones are offered on the Premium tier only (this is the ${String(c.sku)} tier).` }
      : typeof c.zones === 'string' && c.zones !== '' ? { status: 'PASS', observation: `Spread across zones ${String(c.zones).replace(/,/g, ', ')}.` } : { status: 'WARNING', observation: 'No availability zones are set.' }),
  }),
  rule({
    ...common,
    id: 'AZ-CA-001', service: 'Azure Container Apps', scope: 'resource', resourceTypes: ['azure_container_apps'],
    domain: 'RELIABILITY', category: 'Operations', severity: 'MEDIUM', priority: 'REQUIRED_REMEDIATION',
    title: 'Container App is in a subnet smaller than /23',
    description: 'A Container Apps environment placed in a subnet needs an address range of /23 or larger (512 addresses).',
    rationale: 'Azure requires a /23 or larger subnet for the Consumption-only environment type. A smaller subnet makes the deployment fail.',
    risk: 'The environment cannot be created.', impact: 'Failed deployment.',
    wellArchitected: WA.rel('RE:03 — Workload architecture'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: 'Give the app a subnet of its own with a /23 (or larger) address range.', manualSteps: ['Add a subnet with at least 512 addresses.', 'Place the app in it.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Needs a new address range inside the network.', description: 'Manual: a /23 subnet.', patch: () => ({}), architectureImpact: 'The environment can be created.', costImpact: 'NONE' },
    evaluate: (r, ctx) => {
      const parent = r.parentId ? ctx.byId.get(r.parentId) : undefined;
      if (!parent || parent.resourceType !== 'azure_subnet') return { status: 'NOT_APPLICABLE', observation: 'The app is not placed in a subnet, so its environment is not integrated with a network.', evidence: [] };
      const prefix = String(parent.config['addressPrefix'] ?? '');
      const bits = /\/(\d{1,2})$/.exec(prefix)?.[1];
      const evidence = [{ label: 'Subnet range', observed: prefix || 'Not specified', expected: '/23 or larger', basis: 'TOPOLOGY' as const }];
      if (!bits) return { status: 'INSUFFICIENT_DATA', observation: 'The subnet has no address range.', evidence, requiredData: 'Set the subnet address prefix.' };
      const holdsOthers = ctx.resources.some((x) => x.parentId === parent.id && x.id !== r.id && x.resourceType !== 'azure_nsg' && x.resourceType !== 'azure_container_apps');
      if (Number(bits) > 23) return { status: 'FAIL', observation: `The subnet is ${prefix}, smaller than the /23 a Container Apps environment needs.`, evidence };
      if (holdsOthers) return { status: 'FAIL', observation: 'The subnet also holds other resources, but a Container Apps environment needs a subnet of its own.', evidence };
      return { status: 'PASS', observation: `The subnet is ${prefix}.`, evidence };
    },
  }),
  rule({
    ...common,
    id: 'AZ-CA-002', service: 'Azure Container Apps', scope: 'resource', resourceTypes: ['azure_container_apps'],
    domain: 'SECURITY', category: 'Network exposure', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Container App ingress is open to the internet',
    description: 'The app accepts traffic from the internet directly, without a gateway or firewall in front.',
    rationale: 'MCSB NS-1: put a WAF (Front Door or Application Gateway) in front of internet-facing apps and keep the app internal. LOW because a public API or site is often intended.',
    risk: 'The app is exposed to the whole internet without a WAF.', impact: 'Exposure to web attacks and abuse.',
    wellArchitected: WA.sec('SE:06 — Network controls'),
    references: ['MCSB-NS-2', 'AZ-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Put the app in a subnet with internal ingress and a Front Door or Application Gateway with a WAF in front.', manualSteps: ['Place the app in a subnet.', 'Turn internet-facing ingress off.', 'Add a WAF in front.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Needs a subnet and a gateway first; internal ingress alone makes the app unreachable.', description: 'Manual: internal ingress behind a WAF.', patch: () => ({}), architectureImpact: 'Traffic goes through the gateway.', costImpact: 'POSSIBLE_INCREASE' },
    evaluate: configEvaluator(['externalIngress'], { externalIngress: 'Disabled / No' }, (c) => c.externalIngress === false
      ? { status: 'PASS', observation: 'Ingress is internal.' }
      : { status: 'WARNING', observation: 'Ingress is open to the internet.' }),
  }),

  // ════════════════════════════════════════════════════════════════════════
  // Availability zones for the compute and gateway tiers
  // ════════════════════════════════════════════════════════════════════════
  ...([
    ['AZ-VMSS-011', 'Azure Virtual Machine Scale Sets', 'azure_vmss', 'VM scale set', 'the instances'],
    ['AZ-AGW-011', 'Azure Application Gateway', 'azure_app_gateway', 'Application Gateway', 'the gateway'],
  ] as const).map(([id, service, type, what, which]) => rule({
    ...common,
    id, service, scope: 'resource', resourceTypes: [type],
    domain: 'RELIABILITY', category: 'Resilience', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: `${what} is not spread across availability zones`,
    description: `${which[0]!.toUpperCase()}${which.slice(1)} run in one place, so a single availability zone failing takes the tier down.`,
    rationale: 'Azure Well-Architected Reliability (RE:05 redundancy): spread each tier across zones in regions that offer them. LOW because not every region has zones and a design may intentionally run in one.',
    risk: 'A zone outage interrupts the tier.', impact: 'Outage during zone incidents.',
    wellArchitected: WA.rel('RE:05 — Redundancy'),
    references: ['AZ-WA-reliability', TF],
    soc1: ['SOC1-OP-04'],
    remediation: { recommendation: `Set Availability Zones to "Zones 1, 2 and 3" (or two zones) on the ${what.toLowerCase()}, in a region that offers zones.`, manualSteps: ['Confirm the region has availability zones.', 'Set the zones setting.'], terraform: 'zones = ["1", "2", "3"]' },
    evaluate: configEvaluator(['zones'], { zones: 'Zones 1, 2 and 3' }, (c) => typeof c.zones === 'string' && c.zones !== ''
      ? { status: 'PASS', observation: `Spread across zones ${String(c.zones).replace(/,/g, ', ')}.` }
      : { status: 'WARNING', observation: 'No availability zones are set.' }),
  })),

  // ════════════════════════════════════════════════════════════════════════
  // Azure Monitor
  // ════════════════════════════════════════════════════════════════════════
  rule({
    ...common,
    id: 'AZ-MON-001', service: 'Azure Monitor', scope: 'architecture',
    domain: 'OPERATIONAL_EXCELLENCE', category: 'Monitoring', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Workload has no Azure Monitor workspace',
    description: 'The design has compute or data services but no Log Analytics workspace to collect their telemetry.',
    rationale: 'Azure Well-Architected Operational Excellence (OE:07): without a workspace there is nowhere to keep logs and metrics. LOW because the platform keeps basic metrics anyway and a workspace adds cost.',
    risk: 'Failures and attacks cannot be investigated after the fact.', impact: 'Slower incident response.',
    wellArchitected: WA.ops('OE:07 — Monitoring system'),
    references: ['AZ-WA-operational_excellence', 'MCSB-LT-3'],
    soc1: ['SOC1-OP-01', 'SOC1-OP-02'],
    remediation: { recommendation: 'Add an Azure Monitor resource (Log Analytics workspace, with Application Insights for application telemetry) and connect the workloads to it.', manualSteps: ['Add Azure Monitor to the design.', 'Connect compute to it.'] },
    autoFix: { safety: 'MANUAL_ONLY', safetyReason: 'Adds a billable resource.', description: 'Manual: add Azure Monitor.', patch: () => ({}), architectureImpact: 'Telemetry has a destination.', costImpact: 'POSSIBLE_INCREASE' },
    evaluateArchitecture: (ctx) => {
      const workloads = ctx.ofType('azure_vm', 'azure_vmss', 'azure_app_service', 'azure_functions', 'azure_aks', 'azure_container_apps', 'azure_sql', 'azure_postgres', 'azure_mysql', 'azure_cosmos_db');
      if (workloads.length === 0) return [{ status: 'NOT_APPLICABLE', observation: 'No Azure compute or database resources.', evidence: [] }];
      const monitors = ctx.ofType('azure_monitor');
      const evidence = [{ label: 'Workloads', observed: String(workloads.length), basis: 'TOPOLOGY' as const }, { label: 'Azure Monitor workspaces', observed: String(monitors.length), basis: 'TOPOLOGY' as const }];
      return monitors.length > 0
        ? [{ status: 'PASS', observation: 'An Azure Monitor workspace is in the design.', evidence, resourceIds: monitors.map((m) => m.id) }]
        : [{ status: 'WARNING', observation: 'No Azure Monitor workspace is in the design.', evidence, resourceIds: workloads.map((w) => w.id) }];
    },
  }),
];
