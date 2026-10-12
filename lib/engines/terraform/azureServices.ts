/**
 * Terraform for the Azure managed services in lib/resources/azureServices.ts: PostgreSQL and MySQL flexible servers, Service Bus,
 * Container Registry, Monitor (Log Analytics + Application Insights) and Private Endpoints with their private DNS.
 *
 * Kept apart from TerraformGenerator.ts, but written to the same rules: every value that reaches a file is either (a) already made safe by
 * sanitizeResourcesForHcl (strings cannot close a quote or start an interpolation), (b) a number, a boolean or a choice mapped through a
 * fixed list here, or (c) a name reduced to a strict character set. azurerm ~> 3.0 syntax.
 */
import { dnsZoneFor, subresourceFor, PRIVATE_LINK_TARGETS } from '@/lib/engines/assessment/privateAccess';

type Cfg = Record<string, unknown>;

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const lowerName = (v: unknown, fallback: string, max: number): string => {
  const s = String(v ?? '').toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, max).replace(/-+$/g, '');
  return s || fallback;
};
const tagLines = (cfg: Cfg): string => {
  const tags = cfg['tags'] && typeof cfg['tags'] === 'object' ? (cfg['tags'] as Record<string, string>) : {};
  return Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`).join('\n');
};
const tagsBlock = (name: string, cfg: Cfg): string => `  tags = {\n    Name      = "${name}"\n    ManagedBy = "CloudCraft"${tagLines(cfg) ? `\n${tagLines(cfg)}` : ''}\n  }`;

/** Storage sizes Azure offers for flexible servers, in GB. A requested size is rounded up to the next one. */
const PG_STORAGE_GB = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384] as const;
const roundUpStorage = (gb: number) => PG_STORAGE_GB.find((s) => s >= gb) ?? 16384;

export interface BlockResult { block: string; warnings: string[] }

// ─── PostgreSQL / MySQL flexible servers ─────────────────────────────────────

interface FlexInput { name: string; cfg: Cfg; rgName: string; rgLoc: string; label: string; subnetRef: string | null; vnetIdRef: string | null }

const FLEX = {
  postgres: {
    dnsSuffix: 'postgres.database.azure.com', engine: 'PostgreSQL',
    skus: ['B_Standard_B1ms', 'B_Standard_B2s', 'GP_Standard_D2ds_v5', 'GP_Standard_D4ds_v5', 'MO_Standard_E2ds_v5', 'MO_Standard_E4ds_v5'] as const,
    versions: ['16', '15', '14', '13'] as const,
  },
  mysql: {
    dnsSuffix: 'mysql.database.azure.com', engine: 'MySQL',
    skus: ['B_Standard_B1ms', 'B_Standard_B2s', 'GP_Standard_D2ds_v4', 'GP_Standard_D4ds_v4', 'MO_Standard_E2ds_v4'] as const,
    versions: ['8.0.21', '5.7'] as const,
  },
} as const;

function flexibleServer(kind: 'postgres' | 'mysql', i: FlexInput): BlockResult {
  const k = FLEX[kind];
  // Named here (not only in a template) so the allowed-types guard test sees which resource type this emits.
  const resourceType = kind === 'postgres' ? 'azurerm_postgresql_flexible_server' : 'azurerm_mysql_flexible_server';
  const { name, cfg, rgName, rgLoc, subnetRef, vnetIdRef } = i;
  const warnings: string[] = [];
  const server = lowerName(cfg['name'] ?? name, kind === 'postgres' ? 'pg-server' : 'mysql-server', 50);
  const sku = pick(cfg['skuName'], k.skus, 'B_Standard_B1ms');
  const version = pick(cfg['version'], k.versions, k.versions[0]);
  const burstable = sku.startsWith('B_');
  const priv = cfg['publicNetworkAccess'] !== true;
  const privateOk = priv && !!subnetRef && !!vnetIdRef;
  if (priv && !privateOk) warnings.push(`${k.engine} "${i.label}" has public access off but is not placed in a subnet, so it will be created with a public endpoint. Place it in a subnet reserved for flexible servers.`);
  let ha = cfg['highAvailability'] === 'ZoneRedundant';
  if (ha && burstable) {
    ha = false;
    warnings.push(`${k.engine} "${i.label}" asks for zone-redundant high availability, which Burstable sizes do not support, so it was left out. Choose a General Purpose or Memory Optimized size.`);
  }
  const retention = kind === 'postgres' ? num(cfg['backupRetentionDays'], 7, 7, 35) : num(cfg['backupRetentionDays'], 7, 1, 35);
  const storage = kind === 'postgres' ? roundUpStorage(num(cfg['storageGb'], 32, 32, 16384)) : num(cfg['storageGb'], 20, 20, 16384);
  const dnsName = `${lowerName(name.replace(/_/g, '-'), 'server', 40)}.private.${k.dnsSuffix}`;
  const dnsTf = `${name}_dns`;

  const head: string[] = [];
  if (privateOk) {
    head.push(`resource "azurerm_private_dns_zone" "${dnsTf}" {
  name                = "${dnsName}"
  resource_group_name = ${rgName}
${tagsBlock(name, cfg)}
}`, `resource "azurerm_private_dns_zone_virtual_network_link" "${dnsTf}_link" {
  name                  = "${lowerName(name, 'link', 40)}-link"
  resource_group_name   = ${rgName}
  private_dns_zone_name = azurerm_private_dns_zone.${dnsTf}.name
  virtual_network_id    = ${vnetIdRef}
}`);
  }

  const lines = [
    `resource "${resourceType}" "${name}" {`,
    `  name                   = "${server}-\${local.az_suffix}"`,
    `  resource_group_name    = ${rgName}`,
    `  location               = ${rgLoc}`,
    `  version                = "${version}"`,
    `  administrator_login    = var.sql_admin_login`,
    `  administrator_password = var.sql_admin_password`,
    `  sku_name               = "${sku}"`,
    kind === 'postgres' ? `  storage_mb             = ${storage * 1024}` : '',
    `  backup_retention_days  = ${retention}`,
    `  geo_redundant_backup_enabled = ${cfg['geoRedundantBackup'] === true}`,
  ].filter(Boolean);
  if (kind === 'mysql') lines.push(`  storage {`, `    size_gb = ${storage}`, `  }`);
  if (ha) lines.push(`  zone                   = "1"`, `  high_availability {`, `    mode                      = "ZoneRedundant"`, `    standby_availability_zone = "2"`, `  }`);
  if (privateOk) lines.push(`  delegated_subnet_id    = ${subnetRef}`, `  private_dns_zone_id    = azurerm_private_dns_zone.${dnsTf}.id`, `  depends_on             = [azurerm_private_dns_zone_virtual_network_link.${dnsTf}_link]`);
  lines.push(tagsBlock(name, cfg), `}`);

  const parts = [...head, lines.join('\n')];
  const dbName = lowerName(cfg['databaseName'], 'appdb', 60).replace(/-/g, '_');
  if (kind === 'postgres') {
    parts.push(`resource "azurerm_postgresql_flexible_server_database" "${name}_db" {
  name      = "${dbName}"
  server_id = azurerm_postgresql_flexible_server.${name}.id
  collation = "en_US.utf8"
  charset   = "UTF8"
}`, `resource "azurerm_postgresql_flexible_server_configuration" "${name}_require_tls" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.${name}.id
  value     = "${cfg['requireSecureTransport'] === false ? 'off' : 'on'}"
}`, `resource "azurerm_postgresql_flexible_server_configuration" "${name}_min_tls" {
  name      = "ssl_min_protocol_version"
  server_id = azurerm_postgresql_flexible_server.${name}.id
  value     = "${pick(cfg['minimumTlsVersion'], ['TLSv1.2', 'TLSv1.3'] as const, 'TLSv1.2')}"
}`);
    if (!priv && cfg['allowAzureServices'] === true) {
      parts.push(`resource "azurerm_postgresql_flexible_server_firewall_rule" "${name}_allow_azure_services" {
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.${name}.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}`);
    }
  } else {
    parts.push(`resource "azurerm_mysql_flexible_database" "${name}_db" {
  name                = "${dbName}"
  resource_group_name = ${rgName}
  server_name         = azurerm_mysql_flexible_server.${name}.name
  charset             = "utf8mb4"
  collation           = "utf8mb4_unicode_ci"
}`, `resource "azurerm_mysql_flexible_server_configuration" "${name}_require_tls" {
  name                = "require_secure_transport"
  resource_group_name = ${rgName}
  server_name         = azurerm_mysql_flexible_server.${name}.name
  value               = "${cfg['requireSecureTransport'] === false ? 'OFF' : 'ON'}"
}`, `resource "azurerm_mysql_flexible_server_configuration" "${name}_tls_version" {
  name                = "tls_version"
  resource_group_name = ${rgName}
  server_name         = azurerm_mysql_flexible_server.${name}.name
  value               = "${cfg['minimumTlsVersion'] === 'TLSv1.3' ? 'TLSv1.3' : 'TLSv1.2,TLSv1.3'}"
}`);
    if (!priv && cfg['allowAzureServices'] === true) {
      parts.push(`resource "azurerm_mysql_flexible_server_firewall_rule" "${name}_allow_azure_services" {
  name                = "AllowAzureServices"
  resource_group_name = ${rgName}
  server_name         = azurerm_mysql_flexible_server.${name}.name
  start_ip_address    = "0.0.0.0"
  end_ip_address      = "0.0.0.0"
}`);
    }
  }
  if (!priv && cfg['allowAzureServices'] !== true) {
    parts.push(`# ${k.engine} "${i.label}" has a public endpoint and no firewall rule, so nothing can connect yet. Add a firewall rule for the addresses that need access.`);
  }
  return { block: parts.join('\n\n'), warnings };
}

export const postgresBlocks = (i: FlexInput): BlockResult => flexibleServer('postgres', i);
export const mysqlBlocks = (i: FlexInput): BlockResult => flexibleServer('mysql', i);

/** Subnet delegation a flexible server needs on the subnet it is placed in. */
export const DELEGATION_FOR_TYPE: Record<string, { service: string; name: string }> = {
  azure_postgres: { service: 'Microsoft.DBforPostgreSQL/flexibleServers', name: 'postgres' },
  azure_mysql: { service: 'Microsoft.DBforMySQL/flexibleServers', name: 'mysql' },
};
export const delegationBlock = (type: string): string => {
  const d = DELEGATION_FOR_TYPE[type];
  return d ? `\n  delegation {\n    name = "${d.name}"\n    service_delegation {\n      name    = "${d.service}"\n      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]\n    }\n  }` : '';
};

// ─── Service Bus ─────────────────────────────────────────────────────────────

export function serviceBusBlocks(name: string, cfg: Cfg, rgName: string, rgLoc: string): BlockResult {
  const warnings: string[] = [];
  const sku = pick(cfg['sku'], ['Basic', 'Standard', 'Premium'] as const, 'Standard');
  let ns = lowerName(cfg['name'] ?? name, 'servicebus', 40);
  if (!/^[a-z]/.test(ns)) ns = `sb-${ns}`;
  const premium = sku === 'Premium';
  let publicAccess = cfg['publicNetworkAccess'] !== false;
  if (!publicAccess && !premium) {
    publicAccess = true;
    warnings.push(`Service Bus "${cfg['name'] ?? name}" has public access off, which needs the Premium tier. It was created with public access on: choose Premium or turn public access back on.`);
  }
  const lines = [
    `resource "azurerm_servicebus_namespace" "${name}" {`,
    `  name                          = "${ns}-\${local.az_suffix}"`,
    `  resource_group_name           = ${rgName}`,
    `  location                      = ${rgLoc}`,
    `  sku                           = "${sku}"`,
  ];
  if (premium) {
    lines.push(`  capacity                      = ${pick(String(cfg['capacity']), ['1', '2', '4', '8', '16'] as const, '1')}`, `  premium_messaging_partitions  = 1`);
    if (cfg['zoneRedundant'] === true) lines.push(`  zone_redundant                = true`);
  }
  lines.push(
    `  local_auth_enabled            = ${cfg['localAuthEnabled'] !== false}`,
    `  public_network_access_enabled = ${publicAccess}`,
    `  minimum_tls_version           = "${pick(cfg['minimumTlsVersion'], ['1.0', '1.1', '1.2'] as const, '1.2')}"`,
    tagsBlock(name, cfg), `}`,
  );
  const parts = [lines.join('\n')];
  const seen = new Set<string>();
  const queues = String(cfg['queueNames'] ?? 'jobs').split(',').map((q) => q.trim().replace(/[^A-Za-z0-9._-]/g, '')).filter((q) => q && !seen.has(q) && seen.add(q)).slice(0, 20);
  if (queues.length === 0) queues.push('jobs');
  queues.forEach((q, idx) => {
    parts.push(`resource "azurerm_servicebus_queue" "${name}_q${idx}" {
  name                                 = "${q.slice(0, 260)}"
  namespace_id                         = azurerm_servicebus_namespace.${name}.id
  max_delivery_count                   = ${num(cfg['maxDeliveryCount'], 10, 1, 100)}
  dead_lettering_on_message_expiration = true
}`);
  });
  return { block: parts.join('\n\n'), warnings };
}

// ─── Container Registry ──────────────────────────────────────────────────────

export function acrBlocks(name: string, cfg: Cfg, rgName: string, rgLoc: string): BlockResult {
  const warnings: string[] = [];
  const sku = pick(cfg['sku'], ['Basic', 'Standard', 'Premium'] as const, 'Standard');
  const base = String(cfg['name'] ?? name).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || 'registry';
  let publicAccess = cfg['publicNetworkAccess'] !== false;
  if (!publicAccess && sku !== 'Premium') {
    publicAccess = true;
    warnings.push(`Container Registry "${cfg['name'] ?? name}" has public access off, which needs the Premium tier. It was created with public access on: choose Premium or turn public access back on.`);
  }
  const lines = [
    `resource "azurerm_container_registry" "${name}" {`,
    `  name                          = "${base}\${local.az_suffix}"`,
    `  resource_group_name           = ${rgName}`,
    `  location                      = ${rgLoc}`,
    `  sku                           = "${sku}"`,
    `  admin_enabled                 = ${cfg['adminEnabled'] === true}`,
    `  public_network_access_enabled = ${publicAccess}`,
  ];
  if (sku === 'Premium' && cfg['zoneRedundant'] === true) lines.push(`  zone_redundancy_enabled       = true`);
  lines.push(tagsBlock(name, cfg), `}`);
  return { block: lines.join('\n'), warnings };
}

// ─── Monitor ─────────────────────────────────────────────────────────────────

export function monitorBlocks(name: string, cfg: Cfg, rgName: string, rgLoc: string): BlockResult {
  const ws = lowerName(cfg['name'] ?? name, 'workspace', 55);
  const quota = typeof cfg['dailyQuotaGb'] === 'number' && cfg['dailyQuotaGb'] >= 0 ? Math.max(0.023, cfg['dailyQuotaGb']) : -1;
  const parts = [`resource "azurerm_log_analytics_workspace" "${name}" {
  name                       = "${ws}-\${local.az_suffix}"
  resource_group_name        = ${rgName}
  location                   = ${rgLoc}
  sku                        = "PerGB2018"
  retention_in_days          = ${num(cfg['retentionDays'], 30, 30, 730)}
  daily_quota_gb             = ${quota}
  internet_ingestion_enabled = ${cfg['internetIngestionEnabled'] !== false}
  internet_query_enabled     = ${cfg['internetQueryEnabled'] !== false}
${tagsBlock(name, cfg)}
}`];
  if (cfg['applicationInsightsEnabled'] !== false) {
    parts.push(`resource "azurerm_application_insights" "${name}_appi" {
  name                = "${ws}-appi-\${local.az_suffix}"
  resource_group_name = ${rgName}
  location            = ${rgLoc}
  application_type    = "web"
  workspace_id        = azurerm_log_analytics_workspace.${name}.id
${tagsBlock(name, cfg)}
}`);
  }
  return { block: parts.join('\n\n'), warnings: [] };
}

// ─── Private endpoints and their DNS ─────────────────────────────────────────

/** Keeps one private DNS zone per name and one link per zone and network, however many endpoints use them. */
export class PrivateDnsRegistry {
  private zones = new Map<string, string>();
  private links = new Set<string>();
  readonly blocks: string[] = [];

  zone(zoneName: string, rgName: string, tags: string): string {
    const tf = zoneName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    if (!this.zones.has(zoneName)) {
      this.zones.set(zoneName, tf);
      this.blocks.push(`resource "azurerm_private_dns_zone" "${tf}" {
  name                = "${zoneName}"
  resource_group_name = ${rgName}
${tags}
}`);
    }
    return tf;
  }

  link(zoneTf: string, vnetTf: string, vnetIdRef: string, rgName: string): void {
    const key = `${zoneTf}:${vnetTf}`;
    if (this.links.has(key)) return;
    this.links.add(key);
    this.blocks.push(`resource "azurerm_private_dns_zone_virtual_network_link" "${zoneTf}_${vnetTf}" {
  name                  = "${lowerName(vnetTf.replace(/_/g, '-'), 'vnet', 40)}-link"
  resource_group_name   = ${rgName}
  private_dns_zone_name = azurerm_private_dns_zone.${zoneTf}.name
  virtual_network_id    = ${vnetIdRef}
}`);
  }
}

export interface EndpointInput {
  name: string; cfg: Cfg; label: string; rgName: string; rgLoc: string;
  subnetRef: string | null; vnetTf: string | null; vnetIdRef: string | null;
  target: { type: string; cfg: Cfg; address: string } | null;
}

export function privateEndpointBlocks(i: EndpointInput, dns: PrivateDnsRegistry): BlockResult {
  const warnings: string[] = [];
  const { name, cfg, label, rgName, rgLoc } = i;
  if (!i.target || !(i.target.type in PRIVATE_LINK_TARGETS)) {
    return { block: `# Private Endpoint "${label}" is not connected to a service it can reach (Storage, SQL, Key Vault, Redis, Cosmos DB, Container Registry or Service Bus), so nothing was generated.`, warnings: [`Private Endpoint "${label}" is not connected to a service it can reach, so no Terraform was generated for it.`] };
  }
  if (!i.subnetRef) {
    return { block: `# Private Endpoint "${label}" is not placed in a subnet, so nothing was generated.`, warnings: [`Private Endpoint "${label}" is not placed in a subnet, so no Terraform was generated for it.`] };
  }
  const sub = subresourceFor(i.target.type, i.target.cfg, cfg['subresource']) ?? 'blob';
  const zone = dnsZoneFor(i.target.type, i.target.cfg, cfg['subresource']);
  const epName = lowerName(cfg['name'] ?? name, 'private-endpoint', 60);
  const lines = [
    `resource "azurerm_private_endpoint" "${name}" {`,
    `  name                = "${epName}"`,
    `  resource_group_name = ${rgName}`,
    `  location            = ${rgLoc}`,
    `  subnet_id           = ${i.subnetRef}`,
    ``,
    `  private_service_connection {`,
    `    name                           = "${epName}-connection"`,
    `    private_connection_resource_id = ${i.target.address}.id`,
    `    subresource_names              = ["${sub}"]`,
    `    is_manual_connection           = false`,
    `  }`,
  ];
  if (cfg['privateDns'] !== false && zone) {
    const zoneTf = dns.zone(zone, rgName, tagsBlock(name, cfg));
    if (i.vnetTf && i.vnetIdRef) dns.link(zoneTf, i.vnetTf, i.vnetIdRef, rgName);
    else warnings.push(`Private Endpoint "${label}" is in a subnet whose network could not be found, so its DNS zone was not linked to a network.`);
    lines.push(``, `  private_dns_zone_group {`, `    name                 = "default"`, `    private_dns_zone_ids = [azurerm_private_dns_zone.${zoneTf}.id]`, `  }`);
  }
  lines.push(tagsBlock(name, cfg), `}`);
  return { block: lines.join('\n'), warnings };
}

// ─── Azure Firewall ──────────────────────────────────────────────────────────

const zonesList = (v: unknown): string | null => (v === '1,2' ? '["1", "2"]' : v === '1,2,3' ? '["1", "2", "3"]' : null);

/**
 * A firewall in its own subnet (the subnet is named AzureFirewallSubnet by the generator), with a public address, a policy and a baseline rule
 * that lets the private networks reach the web. A new policy denies everything, so without a rule a route through the firewall would cut off
 * every workload.
 */
export function firewallBlocks(name: string, cfg: Cfg, rgName: string, rgLoc: string, subnetRef: string | null, label: string): BlockResult {
  const warnings: string[] = [];
  if (!subnetRef) warnings.push(`Azure Firewall "${label}" is not placed in a subnet, so the firewall itself was not generated (only its address and policy). Put it in a subnet of its own.`);
  const tier = pick(cfg['sku'], ['Standard', 'Premium'] as const, 'Standard');
  const threat = pick(cfg['threatIntelMode'], ['Off', 'Alert', 'Deny'] as const, 'Alert');
  const fw = lowerName(cfg['name'] ?? name, 'firewall', 50);
  const zones = zonesList(cfg['zones']);
  const parts = [
    `resource "azurerm_public_ip" "${name}_pip" {
  name                = "${fw}-pip"
  resource_group_name = ${rgName}
  location            = ${rgLoc}
  allocation_method   = "Static"
  sku                 = "Standard"${zones ? `\n  zones               = ${zones}` : ''}
${tagsBlock(name, cfg)}
}`,
    `resource "azurerm_firewall_policy" "${name}_policy" {
  name                     = "${fw}-policy"
  resource_group_name      = ${rgName}
  location                 = ${rgLoc}
  sku                      = "${tier}"
  threat_intelligence_mode = "${threat}"

  dns {
    proxy_enabled = ${cfg['dnsProxy'] === true}
  }
${tagsBlock(name, cfg)}
}`,
    `resource "azurerm_firewall_policy_rule_collection_group" "${name}_baseline" {
  name               = "baseline"
  firewall_policy_id = azurerm_firewall_policy.${name}_policy.id
  priority           = 1000

  network_rule_collection {
    name     = "allow-web-outbound"
    priority = 1000
    action   = "Allow"
    rule {
      name                  = "web"
      protocols             = ["TCP"]
      source_addresses      = ["10.0.0.0/8"]
      destination_addresses = ["*"]
      destination_ports     = ["80", "443"]
    }
  }
}`,
    ...(subnetRef ? [`resource "azurerm_firewall" "${name}" {
  name                = "${fw}"
  resource_group_name = ${rgName}
  location            = ${rgLoc}
  sku_name            = "AZFW_VNet"
  sku_tier            = "${tier}"
  firewall_policy_id  = azurerm_firewall_policy.${name}_policy.id${zones ? `\n  zones               = ${zones}` : ''}

  ip_configuration {
    name                 = "configuration"
    subnet_id            = ${subnetRef}
    public_ip_address_id = azurerm_public_ip.${name}_pip.id
  }
${tagsBlock(name, cfg)}
}`] : []),
  ];
  return { block: parts.join('\n\n'), warnings };
}

// ─── Event Hubs ──────────────────────────────────────────────────────────────

export function eventHubsBlocks(name: string, cfg: Cfg, rgName: string, rgLoc: string): BlockResult {
  const warnings: string[] = [];
  const sku = pick(cfg['sku'], ['Basic', 'Standard', 'Premium'] as const, 'Standard');
  let ns = lowerName(cfg['name'] ?? name, 'eventhubs', 40);
  if (!/^[a-z]/.test(ns)) ns = `eh-${ns}`;
  let publicAccess = cfg['publicNetworkAccess'] !== false;
  if (!publicAccess && sku === 'Basic') {
    publicAccess = true;
    warnings.push(`Event Hubs "${cfg['name'] ?? name}" has public access off, which needs the Standard or Premium tier. It was created with public access on.`);
  }
  const capacity = num(cfg['capacity'], 1, 1, sku === 'Premium' ? 16 : 20);
  const retentionMax = sku === 'Basic' ? 1 : sku === 'Standard' ? 7 : 90;
  const retention = num(cfg['retentionDays'], 1, 1, retentionMax);
  if (typeof cfg['retentionDays'] === 'number' && cfg['retentionDays'] > retentionMax) warnings.push(`Event Hubs "${cfg['name'] ?? name}" keeps events up to ${retentionMax} day(s) on the ${sku} tier, so retention was lowered from ${cfg['retentionDays']}.`);
  const lines = [
    `resource "azurerm_eventhub_namespace" "${name}" {`,
    `  name                          = "${ns}-\${local.az_suffix}"`,
    `  resource_group_name           = ${rgName}`,
    `  location                      = ${rgLoc}`,
    `  sku                           = "${sku}"`,
    `  capacity                      = ${capacity}`,
    `  zone_redundant                = ${cfg['zoneRedundant'] === true}`,
    `  local_authentication_enabled  = ${cfg['localAuthEnabled'] !== false}`,
    `  public_network_access_enabled = ${publicAccess}`,
    `  minimum_tls_version           = "${pick(cfg['minimumTlsVersion'], ['1.0', '1.1', '1.2'] as const, '1.2')}"`,
    tagsBlock(name, cfg), `}`,
  ];
  const parts = [lines.join('\n')];
  const seen = new Set<string>();
  const hubs = String(cfg['hubNames'] ?? 'events').split(',').map((h) => h.trim().replace(/[^A-Za-z0-9._-]/g, '')).filter((h) => h && !seen.has(h) && seen.add(h)).slice(0, 20);
  if (hubs.length === 0) hubs.push('events');
  hubs.forEach((h, i) => {
    parts.push(`resource "azurerm_eventhub" "${name}_hub${i}" {
  name                = "${h.slice(0, 50)}"
  namespace_name      = azurerm_eventhub_namespace.${name}.name
  resource_group_name = ${rgName}
  partition_count     = ${num(cfg['partitionCount'], 2, 1, 32)}
  message_retention   = ${retention}
}`);
  });
  return { block: parts.join('\n\n'), warnings };
}

// ─── Event Grid ──────────────────────────────────────────────────────────────

export function eventGridBlocks(name: string, cfg: Cfg, rgName: string, rgLoc: string): BlockResult {
  const topic = lowerName(cfg['name'] ?? name, 'topic', 40);
  return {
    block: `resource "azurerm_eventgrid_topic" "${name}" {
  name                          = "${topic.length < 3 ? `${topic}-topic` : topic}-\${local.az_suffix}"
  resource_group_name           = ${rgName}
  location                      = ${rgLoc}
  input_schema                  = "${pick(cfg['inputSchema'], ['EventGridSchema', 'CloudEventSchemaV1_0'] as const, 'EventGridSchema')}"
  public_network_access_enabled = ${cfg['publicNetworkAccess'] !== false}
  local_auth_enabled            = ${cfg['localAuthEnabled'] !== false}
${tagsBlock(name, cfg)}
}

# Event subscriptions (who receives the events) are not generated: they need the receiving endpoint, for example a function in an app that exists.`,
    warnings: [],
  };
}

// ─── API Management ──────────────────────────────────────────────────────────

const APIM_UNITS: Record<string, [number, number]> = { Consumption: [0, 0], Developer: [1, 1], Basic: [1, 2], Standard: [1, 4], Premium: [1, 12] };

export function apiManagementBlocks(name: string, cfg: Cfg, rgName: string, rgLoc: string): BlockResult {
  const sku = pick(cfg['sku'], ['Consumption', 'Developer', 'Basic', 'Standard', 'Premium'] as const, 'Developer');
  const [lo, hi] = APIM_UNITS[sku]!;
  const units = sku === 'Consumption' ? 0 : num(cfg['capacity'], 1, lo, hi);
  let apim = lowerName(cfg['name'] ?? name, 'apim', 40);
  if (!/^[a-z]/.test(apim)) apim = `apim-${apim}`;
  const zones = sku === 'Premium' ? zonesList(cfg['zones']) : null;
  // Publisher values are free text from the form (already made safe by sanitizeResourcesForHcl); the placeholders stop a deployment until replaced.
  const text = (v: unknown, fallback: string) => String(v ?? fallback).slice(0, 200);
  return {
    block: `resource "azurerm_api_management" "${name}" {
  name                = "${apim}-\${local.az_suffix}"
  resource_group_name = ${rgName}
  location            = ${rgLoc}
  publisher_name      = "${text(cfg['publisherName'], 'REPLACE-WITH-YOUR-ORGANIZATION')}"
  publisher_email     = "${text(cfg['publisherEmail'], 'REPLACE-WITH-YOUR-EMAIL')}"
  sku_name            = "${sku}_${units}"${zones ? `\n  zones               = ${zones}` : ''}
${tagsBlock(name, cfg)}
}`,
    warnings: [],
  };
}

// ─── Container Apps ──────────────────────────────────────────────────────────

export function containerAppBlocks(name: string, cfg: Cfg, rgName: string, rgLoc: string, subnetRef: string | null, workspaceRef: string | null, label: string): BlockResult {
  const warnings: string[] = [];
  const cpu = pick(String(cfg['cpu']), ['0.25', '0.5', '0.75', '1', '1.25', '1.5', '1.75', '2'] as const, '0.5');
  const memory = `${Number(cpu) * 2}Gi`;
  let app = lowerName(cfg['name'] ?? name, 'app', 32);
  if (!/^[a-z]/.test(app)) app = `a-${app}`.slice(0, 32).replace(/-+$/g, '');
  const min = num(cfg['minReplicas'], 1, 0, 30);
  const max = Math.max(min || 1, num(cfg['maxReplicas'], 5, 1, 300));
  const external = cfg['externalIngress'] !== false;
  const zone = cfg['zoneRedundant'] === true;
  if (zone && !subnetRef) warnings.push(`Container App "${label}" asks for zone redundancy, which needs the app to be placed in a subnet (a /23 or larger), so it was left out.`);
  const image = String(cfg['image'] ?? 'REPLACE-WITH-YOUR-CONTAINER-IMAGE').slice(0, 300);
  const env = [
    `resource "azurerm_container_app_environment" "${name}_env" {`,
    `  name                = "${app.slice(0, 28)}-env"`,
    `  resource_group_name = ${rgName}`,
    `  location            = ${rgLoc}`,
    ...(workspaceRef ? [`  log_analytics_workspace_id = ${workspaceRef}`] : []),
    ...(subnetRef ? [`  infrastructure_subnet_id   = ${subnetRef}`, `  internal_load_balancer_enabled = ${!external}`, ...(zone ? [`  zone_redundancy_enabled    = true`] : [])] : []),
    tagsBlock(name, cfg), `}`,
  ].join('\n');
  const appBlock = `resource "azurerm_container_app" "${name}" {
  name                         = "${app}"
  container_app_environment_id = azurerm_container_app_environment.${name}_env.id
  resource_group_name          = ${rgName}
  revision_mode                = "Single"

  template {
    min_replicas = ${min}
    max_replicas = ${max}

    container {
      name   = "${app}"
      image  = "${image}"
      cpu    = ${cpu}
      memory = "${memory}"
    }
  }

  ingress {
    external_enabled = ${external}
    target_port      = ${num(cfg['targetPort'], 80, 1, 65535)}

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
${tagsBlock(name, cfg)}
}`;
  return { block: `${env}\n\n${appBlock}`, warnings };
}
