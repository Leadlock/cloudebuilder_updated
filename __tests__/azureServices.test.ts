/**
 * Azure managed services and private access: PostgreSQL / MySQL flexible servers, Service Bus, Container Registry, Azure Monitor and Private
 * Endpoints. A design whose public endpoints are off must give the application a private path; the AI repair adds one; Terraform, cost,
 * rules and the service notices all agree about it.
 */
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureConnection, DbArchitectureResource } from '@/lib/repositories/architectureRepository';
import { evaluateSpec, type ArchitectureSpec } from '@/lib/ai/architectureSpec';
import { repairSpecInput } from '@/lib/ai/specRepair';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { relationshipEngine } from '@/lib/engines/relationship/RelationshipEngine';
import { azurePricingProvider } from '@/lib/engines/cost/azurePricing';
import { detectServiceNotices, designTypesOf } from '@/lib/ai/serviceCoverage';
import { getResourceDefinition } from '@/lib/resources';
import { needsPrivateEndpoint, dnsZoneFor, subresourceFor } from '@/lib/engines/assessment/privateAccess';
import { azureThreeTier, azureAppService, azureAks, azureServerless } from '../scripts/ai-dataset/azurePatterns';
import { azureFunctionsPrivateApi } from '../scripts/ai-dataset/morePatterns';
import { azureGatewayAppService } from '../scripts/ai-dataset/extraPatterns';
import type { Database, Requirements } from '../scripts/ai-dataset/requirements';
import type { CanvasNode } from '@/types';

// ─── helpers ─────────────────────────────────────────────────────────────────

const res = (id: string, resourceType: string, config: Record<string, unknown> = {}, groupId: string | null = null): DbArchitectureResource => ({
  id, resourceType, provider: 'azure', label: id, positionX: 0, positionY: 0, configJson: JSON.stringify({ name: id, ...config }), region: null, groupId, locked: false, architectureId: 'a',
} as DbArchitectureResource);
const link = (s: string, t: string): DbArchitectureConnection => ({ id: `${s}-${t}`, label: null, edgeType: null, sourceId: s, targetId: t, architectureId: 'a' });
const tf = (resources: DbArchitectureResource[], connections: DbArchitectureConnection[] = []) => {
  const r = new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections });
  return { main: r.files.find((f) => f.filename === 'main.tf')!.content, vars: r.files.find((f) => f.filename === 'variables.tf')!.content, warnings: r.warnings };
};
const node = (id: string, resourceType: string, config: Record<string, unknown> = {}, parentId?: string): CanvasNode => ({
  id, type: 'cloudNode', resourceType, provider: 'azure', label: id, position: { x: 0, y: 0 },
  config: { ...(getResourceDefinition(resourceType)?.defaultConfig ?? {}), ...config }, ...(parentId ? { parentId, groupId: parentId } : {}),
} as CanvasNode);
const status = (nodes: CanvasNode[], edges: { id: string; source: string; target: string }[], ruleId: string, resourceId?: string) =>
  runAssessment({ nodes, edges }).evaluations.find((e) => e.ruleId === ruleId && (!resourceId || e.resourceIds.includes(resourceId)))?.status;

// ─── catalog ─────────────────────────────────────────────────────────────────

describe('the catalog', () => {
  test.each(['azure_postgres', 'azure_mysql', 'azure_service_bus', 'azure_acr', 'azure_monitor', 'azure_private_endpoint'])('%s exists with a complete definition', (t) => {
    const d = getResourceDefinition(t)!;
    expect(d.provider).toBe('azure');
    for (const k of Object.keys(d.defaultConfig)) expect([t, k, d.configSchema.some((f) => f.key === k)]).toEqual([t, k, true]);
    for (const f of d.configSchema) expect([t, f.key, f.key in d.defaultConfig]).toEqual([t, f.key, true]);
  });
  test('containment: endpoints and flexible servers go in subnets, the other services in the boundary', () => {
    const sub = getResourceDefinition('azure_subnet')!.allowedChildren!;
    expect(sub).toEqual(expect.arrayContaining(['azure_private_endpoint', 'azure_postgres', 'azure_mysql']));
    expect(sub).not.toContain('azure_service_bus');
    expect(getResourceDefinition('azure_cloud_boundary')!.allowedChildren).toEqual(expect.arrayContaining(['azure_service_bus', 'azure_acr', 'azure_monitor']));
  });
  test('the services are no longer reported as unsupported', () => {
    const out = detectServiceNotices('Azure Service Bus, Container Registry, Application Insights and PostgreSQL');
    expect(out.unsupported).toEqual([]);
  });
});

// ─── Terraform ───────────────────────────────────────────────────────────────

describe('Terraform', () => {
  const vnet = res('vnet', 'azure_vnet', { addressSpace: '10.0.0.0/16' });
  const sub = (id: string, prefix: string) => res(id, 'azure_subnet', { addressPrefix: prefix }, 'vnet');

  test('a private PostgreSQL server gets a delegated subnet, its own DNS zone and a link, and uses the shared admin variables', () => {
    const t = tf([vnet, sub('pg-subnet', '10.0.3.0/24'), res('db', 'azure_postgres', { highAvailability: 'ZoneRedundant', skuName: 'GP_Standard_D2ds_v5' }, 'pg-subnet')]);
    expect(t.main).toContain('service_delegation');
    expect(t.main).toContain('Microsoft.DBforPostgreSQL/flexibleServers');
    expect(t.main).toContain('delegated_subnet_id    = azurerm_subnet.pg_subnet.id');
    expect(t.main).toContain('azurerm_private_dns_zone_virtual_network_link');
    expect(t.main).toContain('mode                      = "ZoneRedundant"');
    expect(t.main).toContain('administrator_password = var.sql_admin_password');
    expect(t.vars).toContain('sql_admin_password');
    expect(t.main).not.toMatch(/administrator_password\s*=\s*"/);
    expect(t.warnings).toEqual([]);
  });
  test('MySQL: its own delegation and the storage block', () => {
    const t = tf([vnet, sub('my-subnet', '10.0.4.0/24'), res('m', 'azure_mysql', { storageGb: 64 }, 'my-subnet')]);
    expect(t.main).toContain('Microsoft.DBforMySQL/flexibleServers');
    expect(t.main).toContain('size_gb = 64');
    expect(t.main).toContain('value               = "ON"');
  });
  test('a private server with no subnet is created public and the person is told', () => {
    const t = tf([res('db', 'azure_postgres')]);
    expect(t.main).not.toContain('delegated_subnet_id');
    expect(t.warnings.join(' ')).toMatch(/not placed in a subnet/);
  });
  test('zone-redundant HA on a Burstable size is left out with a warning (Azure would refuse it)', () => {
    const t = tf([vnet, sub('s', '10.0.3.0/24'), res('db', 'azure_postgres', { highAvailability: 'ZoneRedundant' }, 's')]);
    expect(t.main).not.toContain('high_availability');
    expect(t.warnings.join(' ')).toMatch(/Burstable/);
  });
  test('a public server with Azure services allowed gets the firewall rule, and without it a note', () => {
    expect(tf([res('db', 'azure_postgres', { publicNetworkAccess: true, allowAzureServices: true })]).main).toContain('azurerm_postgresql_flexible_server_firewall_rule');
    expect(tf([res('db', 'azure_postgres', { publicNetworkAccess: true, allowAzureServices: false })]).main).toMatch(/no firewall rule/);
  });
  test('two flexible servers of different kinds in one subnet are reported', () => {
    const t = tf([vnet, sub('s', '10.0.3.0/24'), res('a', 'azure_postgres', {}, 's'), res('b', 'azure_mysql', {}, 's')]);
    expect(t.warnings.join(' ')).toMatch(/one service only/);
  });
  test('Service Bus: Premium options, de-duplicated queue names, and public access cannot be turned off below Premium', () => {
    const premium = tf([res('bus', 'azure_service_bus', { sku: 'Premium', capacity: 2, zoneRedundant: true, queueNames: 'jobs, emails,jobs, bad name!', publicNetworkAccess: false })]);
    expect(premium.main).toContain('capacity                      = 2');
    expect(premium.main).toContain('zone_redundant                = true');
    expect((premium.main.match(/resource "azurerm_servicebus_queue"/g) ?? []).length).toBe(3);
    expect(premium.main).toContain('name                                 = "badname"');
    expect(premium.main).toContain('public_network_access_enabled = false');
    const standard = tf([res('bus', 'azure_service_bus', { sku: 'Standard', publicNetworkAccess: false })]);
    expect(standard.main).toContain('public_network_access_enabled = true');
    expect(standard.warnings.join(' ')).toMatch(/Premium/);
    expect(standard.main).not.toContain('capacity');
  });
  test('Container Registry: the name is alphanumeric, Premium zone redundancy, and the Premium-only limits', () => {
    const t = tf([res('reg', 'azure_acr', { name: 'my-reg_1', sku: 'Premium', zoneRedundant: true, adminEnabled: false })]);
    expect(t.main).toContain('name                          = "myreg1${local.az_suffix}"');
    expect(t.main).toContain('zone_redundancy_enabled       = true');
    expect(tf([res('reg', 'azure_acr', { sku: 'Basic', publicNetworkAccess: false })]).warnings.join(' ')).toMatch(/Premium/);
  });
  test('Monitor: workspace, Application Insights on or off, and a valid daily cap', () => {
    const on = tf([res('mon', 'azure_monitor', { retentionDays: 90, dailyQuotaGb: 0.001 })]);
    expect(on.main).toContain('retention_in_days          = 90');
    expect(on.main).toContain('daily_quota_gb             = 0.023');
    expect(on.main).toContain('azurerm_application_insights');
    expect(tf([res('mon', 'azure_monitor', { applicationInsightsEnabled: false })]).main).not.toContain('azurerm_application_insights');
  });
  test('Private Endpoints: one DNS zone per kind of service however many endpoints, linked once per network', () => {
    const t = tf([
      vnet, sub('pe-subnet', '10.0.4.0/24'), res('s1', 'azure_storage', { networkDefaultAction: 'Deny' }), res('s2', 'azure_storage', { networkDefaultAction: 'Deny' }),
      res('sql', 'azure_sql'), res('kv', 'azure_key_vault'),
      res('pe1', 'azure_private_endpoint', {}, 'pe-subnet'), res('pe2', 'azure_private_endpoint', {}, 'pe-subnet'), res('pe3', 'azure_private_endpoint', {}, 'pe-subnet'), res('pe4', 'azure_private_endpoint', {}, 'pe-subnet'),
    ], [link('pe1', 's1'), link('pe2', 's2'), link('pe3', 'sql'), link('pe4', 'kv')]);
    expect((t.main.match(/resource "azurerm_private_dns_zone" "privatelink_blob_core_windows_net"/g) ?? []).length).toBe(1);
    expect((t.main.match(/resource "azurerm_private_dns_zone_virtual_network_link" "privatelink_blob_core_windows_net_vnet"/g) ?? []).length).toBe(1);
    expect((t.main.match(/resource "azurerm_private_endpoint"/g) ?? []).length).toBe(4);
    for (const z of ['privatelink.database.windows.net', 'privatelink.vaultcore.azure.net']) expect(t.main).toContain(`name                = "${z}"`);
    expect(t.main).toContain('private_connection_resource_id = azurerm_mssql_server.sql_server.id');
    expect(t.main).toContain('subresource_names              = ["sqlServer"]');
    expect(t.main).toContain('subresource_names              = ["vault"]');
  });
  test('an endpoint with no service, or no subnet, generates nothing and says why', () => {
    const lonely = tf([vnet, sub('pe-subnet', '10.0.4.0/24'), res('pe', 'azure_private_endpoint', {}, 'pe-subnet')]);
    expect(lonely.main).not.toContain('resource "azurerm_private_endpoint"');
    expect(lonely.warnings.join(' ')).toMatch(/not connected to a service/);
    const homeless = tf([res('s', 'azure_storage'), res('pe', 'azure_private_endpoint')], [link('pe', 's')]);
    expect(homeless.warnings.join(' ')).toMatch(/not placed in a subnet/);
  });
  test('the storage sub-resource can be chosen and picks its own DNS zone', () => {
    const t = tf([vnet, sub('pe-subnet', '10.0.4.0/24'), res('s', 'azure_storage', { networkDefaultAction: 'Deny' }), res('pe', 'azure_private_endpoint', { subresource: 'queue' }, 'pe-subnet')], [link('pe', 's')]);
    expect(t.main).toContain('subresource_names              = ["queue"]');
    expect(t.main).toContain('privatelink.queue.core.windows.net');
  });
  test('a value cannot break out of the file (queue names, names, tags)', () => {
    const t = tf([res('bus', 'azure_service_bus', { name: 'x"\nprovisioner "local-exec" {}', queueNames: 'q"}\nresource "aws_iam_user" "evil" {', tags: { a: 'b"c' } })]);
    expect(t.main).not.toMatch(/provisioner\s+"/);                  // the word survives only inside a cleaned-up name, never as a block
    expect(t.main).not.toContain('resource "aws_iam_user"');
  });
  test('availability zones reach the scale set and the gateway, and only the offered values are written', () => {
    const t = tf([res('vmss', 'azure_vmss', { zones: '1,2,3' }), res('agw', 'azure_app_gateway', { zones: '1,2' })]);
    expect(t.main).toContain('zones                = ["1", "2", "3"]');
    expect(t.main).toContain('zones               = ["1", "2"]');
    expect(tf([res('vmss', 'azure_vmss', { zones: '9;rm' })]).main).not.toMatch(/zones\s+=/);
  });
});

// ─── private access ──────────────────────────────────────────────────────────

describe('private access table', () => {
  test('public settings per service', () => {
    expect(needsPrivateEndpoint('azure_sql', { publicNetworkAccess: false })).toBe(true);
    expect(needsPrivateEndpoint('azure_sql', { publicNetworkAccess: true })).toBe(false);
    expect(needsPrivateEndpoint('azure_storage', { networkDefaultAction: 'Deny' })).toBe(true);
    expect(needsPrivateEndpoint('azure_storage', { networkDefaultAction: 'Allow' })).toBe(false);
    expect(needsPrivateEndpoint('azure_key_vault', { publicNetworkAccessEnabled: false, networkAclsDefaultAction: 'Deny' })).toBe(true);
    expect(needsPrivateEndpoint('azure_key_vault', { publicNetworkAccessEnabled: true, networkAclsDefaultAction: 'Allow' })).toBe(false);
    expect(needsPrivateEndpoint('azure_redis', { publicNetworkAccessEnabled: false })).toBe(true);
    expect(needsPrivateEndpoint('azure_vm', {})).toBe(false);
    expect(needsPrivateEndpoint('azure_postgres', { publicNetworkAccess: false })).toBe(false);     // placed in a subnet instead
  });
  test('sub-resource and DNS zone, including Cosmos DB by API and storage by choice', () => {
    expect(subresourceFor('azure_cosmos_db', { kind: 'MongoDB' })).toBe('MongoDB');
    expect(dnsZoneFor('azure_cosmos_db', { kind: 'GlobalDocumentDB' })).toBe('privatelink.documents.azure.com');
    expect(dnsZoneFor('azure_storage', {}, 'file')).toBe('privatelink.file.core.windows.net');
    expect(dnsZoneFor('azure_storage', {}, 'auto')).toBe('privatelink.blob.core.windows.net');
    expect(dnsZoneFor('azure_sql', {}, 'file')).toBe('privatelink.database.windows.net');
  });
});

// ─── rules ───────────────────────────────────────────────────────────────────

describe('rules', () => {
  const edge = (a: string, b: string) => ({ id: `${a}-${b}`, source: a, target: b });
  const vm = () => node('vm', 'azure_vmss');
  const subnet = () => node('sn', 'azure_subnet');

  test('AZ-PE-001: a private service that an application calls and nothing reaches privately fails; an endpoint or public access passes', () => {
    const sql = node('sql', 'azure_sql', { publicNetworkAccess: false });
    expect(status([vm(), sql], [edge('vm', 'sql')], 'AZ-PE-001', 'sql')).toBe('FAIL');
    const pe = node('pe', 'azure_private_endpoint', {}, 'sn');
    expect(status([vm(), sql, subnet(), pe], [edge('vm', 'sql'), edge('pe', 'sql')], 'AZ-PE-001', 'sql')).toBe('PASS');
    expect(status([vm(), node('sql2', 'azure_sql', { publicNetworkAccess: true })], [edge('vm', 'sql2')], 'AZ-PE-001', 'sql2')).toBe('PASS');
  });
  test('AZ-PE-001: a service nothing calls is not flagged, so changing one setting in isolation is never a regression', () => {
    expect(status([node('sql', 'azure_sql', { publicNetworkAccess: false })], [], 'AZ-PE-001', 'sql')).toBe('NOT_APPLICABLE');
  });
  test('AZ-PE-001: an imported service missing the public settings is "insufficient data", never a pass', () => {
    const kv = node('kv', 'azure_key_vault');
    delete (kv.config as Record<string, unknown>)['publicNetworkAccessEnabled'];
    expect(status([vm(), kv], [edge('vm', 'kv')], 'AZ-PE-001', 'kv')).toBe('INSUFFICIENT_DATA');
  });
  test('AZ-PE-002: an endpoint outside a subnet, or without a service, fails; placed and connected passes', () => {
    const sql = node('sql', 'azure_sql');
    expect(status([node('pe', 'azure_private_endpoint')], [], 'AZ-PE-002')).toBe('FAIL');
    expect(status([subnet(), node('pe', 'azure_private_endpoint', {}, 'sn')], [], 'AZ-PE-002')).toBe('FAIL');
    expect(status([subnet(), sql, node('pe', 'azure_private_endpoint', {}, 'sn')], [edge('pe', 'sql')], 'AZ-PE-002')).toBe('PASS');
  });
  test('flexible servers: public is HIGH, a private one must be alone in its subnet, Burstable is not judged on zone redundancy', () => {
    expect(status([node('db', 'azure_postgres', { publicNetworkAccess: true })], [], 'AZ-PG-001')).toBe('FAIL');
    expect(status([node('db', 'azure_postgres')], [], 'AZ-PG-012')).toBe('FAIL');
    const alone = [subnet(), node('db', 'azure_postgres', {}, 'sn')];
    expect(status(alone, [], 'AZ-PG-012')).toBe('PASS');
    expect(status([subnet(), node('db', 'azure_mysql', {}, 'sn'), node('x', 'azure_vmss', {}, 'sn')], [], 'AZ-MY-012')).toBe('FAIL');
    expect(status([node('db', 'azure_postgres', { highAvailability: 'Disabled' })], [], 'AZ-PG-010')).toBe('NOT_APPLICABLE');
    expect(status([node('db', 'azure_postgres', { skuName: 'GP_Standard_D2ds_v5', highAvailability: 'Disabled' })], [], 'AZ-PG-010')).toBe('FAIL');
    expect(status([node('db', 'azure_mysql', { requireSecureTransport: false })], [], 'AZ-MY-002')).toBe('FAIL');
  });
  test('Service Bus and Container Registry: public access is only a recommendation, never blocking; the admin user is a finding', () => {
    const a = runAssessment({ nodes: [node('bus', 'azure_service_bus'), node('reg', 'azure_acr', { adminEnabled: true })], edges: [] });
    const sev = (id: string) => a.findings.find((f) => f.ruleId === id)?.severity;
    expect(sev('AZ-SB-001')).toBe('LOW');
    expect(sev('AZ-SB-002')).toBe('LOW');
    expect(sev('AZ-ACR-002')).toBe('LOW');
    expect(sev('AZ-ACR-001')).toBe('MEDIUM');
    expect(status([node('bus', 'azure_service_bus', { minimumTlsVersion: '1.0' })], [], 'AZ-SB-003')).toBe('FAIL');
  });
  test('Azure Monitor: absent is a LOW warning when there is a workload, present passes, no workload is not applicable', () => {
    expect(status([vm()], [], 'AZ-MON-001')).toBe('WARNING');
    expect(status([vm(), node('mon', 'azure_monitor')], [], 'AZ-MON-001')).toBe('PASS');
    expect(status([node('mon', 'azure_monitor')], [], 'AZ-MON-001')).toBe('NOT_APPLICABLE');
  });
  test('zones: set passes, unset warns', () => {
    expect(status([node('v', 'azure_vmss', { zones: '1,2,3' })], [], 'AZ-VMSS-011')).toBe('PASS');
    expect(status([node('v', 'azure_vmss')], [], 'AZ-VMSS-011')).toBe('WARNING');
    expect(status([node('g', 'azure_app_gateway')], [], 'AZ-AGW-011')).toBe('WARNING');
  });
});

// ─── relationships ───────────────────────────────────────────────────────────

describe('relationships', () => {
  const ok = (a: CanvasNode, b: CanvasNode) => relationshipEngine.validateConnection(a, b, [a, b], []);
  test('compute reaches the new services with the right protocol and port', () => {
    const vm = node('vm', 'azure_vmss');
    expect(ok(vm, node('d', 'azure_postgres'))).toMatchObject({ isValid: true, port: 5432, relationshipType: 'DATABASE_CONNECTION' });
    expect(ok(vm, node('d', 'azure_mysql'))).toMatchObject({ isValid: true, port: 3306 });
    expect(ok(vm, node('b', 'azure_service_bus'))).toMatchObject({ isValid: true, port: 5671 });
    expect(ok(vm, node('r', 'azure_acr'))).toMatchObject({ isValid: true, port: 443 });
    expect(ok(vm, node('m', 'azure_monitor'))).toMatchObject({ isValid: true });
  });
  test('Service Bus triggers Functions; no other passive service starts a connection to compute', () => {
    expect(ok(node('b', 'azure_service_bus'), node('f', 'azure_functions'))).toMatchObject({ isValid: true, relationshipType: 'TRIGGERS' });
    expect(ok(node('d', 'azure_postgres'), node('vm', 'azure_vmss')).isValid).toBe(false);
    expect(ok(node('r', 'azure_acr'), node('vm', 'azure_vmss')).isValid).toBe(false);
  });
  test('the internet never reaches a database directly', () => {
    expect(ok(node('p', 'azure_public_ip'), node('d', 'azure_postgres')).isValid).toBe(false);
  });
  test('a Private Endpoint connects to a service that supports it, in either direction, and to nothing else', () => {
    const pe = node('pe', 'azure_private_endpoint');
    expect(ok(pe, node('s', 'azure_storage')).isValid).toBe(true);
    expect(ok(node('s', 'azure_storage'), pe).isValid).toBe(true);
    expect(ok(pe, node('vm', 'azure_vmss')).isValid).toBe(false);
    expect(ok(pe, node('d', 'azure_postgres')).isValid).toBe(false);
  });
  test('databases cannot sit directly in the network', () => {
    const v = relationshipEngine.validateContainment('azure_postgres', 'azure_vnet', 'azure', 'azure');
    expect(v.isAllowed).toBe(false);
  });
});

// ─── cost ────────────────────────────────────────────────────────────────────

describe('cost', () => {
  const price = (type: string, config: Record<string, unknown>) => azurePricingProvider.estimateResource({ id: 'r', label: 'r', resourceType: type, provider: 'azure' } as never, { ...(getResourceDefinition(type)!.defaultConfig), ...config }, 'eastus')!;
  test('PostgreSQL: Burstable B1ms plus storage, and zone-redundant HA doubles both', () => {
    const single = price('azure_postgres', { skuName: 'B_Standard_B1ms', storageGb: 32 });
    expect(single.monthlyUsd).toBeCloseTo(0.017 * 730 + 32 * 0.115, 1);
    const ha = price('azure_postgres', { skuName: 'GP_Standard_D2ds_v5', storageGb: 32, highAvailability: 'ZoneRedundant' });
    const noHa = price('azure_postgres', { skuName: 'GP_Standard_D2ds_v5', storageGb: 32, highAvailability: 'Disabled' });
    expect(ha.monthlyUsd).toBeCloseTo(noHa.monthlyUsd * 2, 1);
    expect(noHa.monthlyUsd).toBeCloseTo(2 * 0.089 * 730 + 32 * 0.115, 1);
  });
  test('MySQL: General Purpose per vCore', () => {
    expect(price('azure_mysql', { skuName: 'GP_Standard_D2ds_v4', storageGb: 20 }).monthlyUsd).toBeCloseTo(2 * 0.0855 * 730 + 20 * 0.115, 1);
  });
  test('Service Bus tiers, Container Registry tiers and storage above the allowance', () => {
    expect(price('azure_service_bus', { sku: 'Standard' }).monthlyUsd).toBeCloseTo(10, 1);
    expect(price('azure_service_bus', { sku: 'Premium', capacity: 2 }).monthlyUsd).toBeCloseTo(2 * 0.9275 * 730, 0);
    expect(price('azure_acr', { sku: 'Standard', estimatedStorageGb: 20 }).monthlyUsd).toBeCloseTo(0.6666 * (730 / 24), 1);
    expect(price('azure_acr', { sku: 'Basic', estimatedStorageGb: 30 }).monthlyUsd).toBeCloseTo(0.1666 * (730 / 24) + 20 * 0.1, 1);
  });
  test('Monitor: the first 5 GB are free; a daily cap limits the bill', () => {
    expect(price('azure_monitor', { estimatedIngestionGbPerMonth: 5 }).monthlyUsd).toBe(0);
    expect(price('azure_monitor', { estimatedIngestionGbPerMonth: 10 }).monthlyUsd).toBeCloseTo(5 * 2.3, 1);
    expect(price('azure_monitor', { estimatedIngestionGbPerMonth: 1000, dailyQuotaGb: 1 }).monthlyUsd).toBeCloseTo(25 * 2.3, 1);
  });
  test('Private Endpoint: $0.01 an hour plus data', () => {
    expect(price('azure_private_endpoint', { estimatedDataGbPerMonth: 100 }).monthlyUsd).toBeCloseTo(7.3 + 1, 1);
  });
  test('every line says where its price comes from and that it is an estimate', () => {
    for (const t of ['azure_postgres', 'azure_mysql', 'azure_service_bus', 'azure_acr', 'azure_monitor', 'azure_private_endpoint']) {
      const p = price(t, {});
      expect(p.pricingSource).toMatch(/^azure-/);
      expect(p.confidence).toBe('estimate');
    }
  });
});

// ─── service notices ─────────────────────────────────────────────────────────

describe('service notices', () => {
  test('PostgreSQL asked for but Azure SQL drawn is reported; the right engine is not', () => {
    expect(detectServiceNotices('Azure app with a PostgreSQL database', ['azure_vmss', 'azure_sql']).missing.map((m) => m.service)).toEqual(['PostgreSQL']);
    expect(detectServiceNotices('Azure app with a PostgreSQL database', ['azure_vmss', 'azure_postgres']).missing).toEqual([]);
    expect(detectServiceNotices('a MySQL backend on Azure', ['azure_sql']).missing.map((m) => m.service)).toEqual(['MySQL']);
  });
  test('a message queue asked for in plain words is reported when none is drawn, and satisfied by Service Bus or SQS', () => {
    expect(detectServiceNotices('a web app with a message queue for background jobs', ['azure_vmss']).missing.map((m) => m.service)).toEqual(['Message queue']);
    expect(detectServiceNotices('a web app with a message queue for background jobs', ['azure_vmss', 'azure_service_bus']).missing).toEqual([]);
    expect(detectServiceNotices('job queue on AWS', ['aws_sqs']).missing).toEqual([]);
  });
  test('"without a queue" is not a request', () => {
    expect(detectServiceNotices('a web app without a message queue', ['azure_vmss']).missing).toEqual([]);
  });
  test('a gateway or Front Door with its WAF switched on counts as the WAF that was asked for', () => {
    expect(detectServiceNotices('Application Gateway with WAF', ['azure_app_gateway']).missing.map((m) => m.service)).toEqual(['WAF']);
    const types = designTypesOf([{ resourceType: 'azure_app_gateway', config: { wafEnabled: true } }]);
    expect(detectServiceNotices('Application Gateway with WAF', types).missing).toEqual([]);
    expect(designTypesOf([{ resourceType: 'azure_app_gateway', config: { wafEnabled: false } }])).not.toContain('azure_waf');
  });
});

// ─── AI repair ───────────────────────────────────────────────────────────────

describe('AI design repair adds the private path', () => {
  const spec = (over: { storageDeny?: boolean } = {}): ArchitectureSpec => ({
    name: 'x', summary: 'y',
    resources: [
      { id: 'azure-cloud', type: 'azure_cloud_boundary', label: 'Azure' },
      { id: 'vnet', type: 'azure_vnet', label: 'VNet', parent: 'azure-cloud', config: { addressSpace: '10.0.0.0/16' } },
      { id: 'web-subnet', type: 'azure_subnet', label: 'Web Subnet', parent: 'vnet', config: { addressPrefix: '10.0.0.0/24' } },
      { id: 'app-subnet', type: 'azure_subnet', label: 'App Subnet', parent: 'vnet', config: { addressPrefix: '10.0.10.0/24' } },
      { id: 'data-subnet', type: 'azure_subnet', label: 'Data Subnet', parent: 'vnet', config: { addressPrefix: '10.0.20.0/24' } },
      { id: 'agw', type: 'azure_app_gateway', label: 'Gateway', parent: 'web-subnet', config: { sku: 'WAF_v2', wafEnabled: true, wafMode: 'Prevention', zones: '1,2,3' } },
      { id: 'vmss', type: 'azure_vmss', label: 'App', parent: 'app-subnet', config: { zones: '1,2,3' } },
      { id: 'sql', type: 'azure_sql', label: 'SQL', parent: 'data-subnet', config: { tier: 'GeneralPurpose', zoneRedundant: true, requestedBackupStorageRedundancy: 'Zone', auditingEnabled: true } },
      { id: 'storage', type: 'azure_storage', label: 'Assets', parent: 'azure-cloud', config: { sku: 'Standard_ZRS', networkDefaultAction: over.storageDeny === false ? 'Allow' : 'Deny', blobVersioningEnabled: true, blobSoftDeleteRetentionDays: 14 } },
      { id: 'vault', type: 'azure_key_vault', label: 'Vault', parent: 'azure-cloud' },
      { id: 'mon', type: 'azure_monitor', label: 'Monitor', parent: 'azure-cloud' },
    ],
    connections: [
      { from: 'agw', to: 'vmss' }, { from: 'vmss', to: 'sql' }, { from: 'vmss', to: 'storage' }, { from: 'vmss', to: 'vault' }, { from: 'vmss', to: 'mon' },
    ],
  });

  test('without repair the design fails the gates because nothing can reach its private services', () => {
    const r = evaluateSpec(spec());
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.message).join('\n')).toMatch(/AZ-PE-001/);
  });
  test('the repair adds one endpoint per private service, in the data subnet, connected to the service, and the design then passes', () => {
    const { value, report } = repairSpecInput(spec());
    expect(report.privateEndpoints).toBe(3);               // SQL, the storage account (Deny) and Key Vault (private by default)
    const out = value as ArchitectureSpec;
    const pes = out.resources.filter((r) => r.type === 'azure_private_endpoint');
    expect(pes.map((p) => p.parent)).toEqual(['data-subnet', 'data-subnet', 'data-subnet']);
    for (const t of ['sql', 'storage', 'vault']) expect(out.connections).toEqual(expect.arrayContaining([{ from: `pe-${t}`, to: t }]));
    const r = evaluateSpec(value, { autoRepair: true });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });
  test('a storage account that keeps public access needs no endpoint', () => {
    const { report } = repairSpecInput(spec({ storageDeny: false }));
    expect(report.privateEndpoints).toBe(2);
  });
  test('an endpoint the design drew but never connected is connected to the service it is named after', () => {
    const s = spec();
    s.resources.push({ id: 'pe-storage', type: 'azure_private_endpoint', label: 'Storage Private Endpoint', parent: 'data-subnet' });
    const { value } = repairSpecInput(s);
    expect((value as ArchitectureSpec).connections).toEqual(expect.arrayContaining([{ from: 'pe-storage', to: 'storage' }]));
    expect((value as ArchitectureSpec).resources.filter((r) => r.type === 'azure_private_endpoint').map((r) => r.id).sort()).toEqual(['pe-sql', 'pe-storage', 'pe-vault']);
  });
  test('a design with no network cannot get an endpoint (nowhere to put it), and is left alone', () => {
    const s = spec();
    s.resources = s.resources.filter((r) => !['vnet', 'web-subnet', 'app-subnet', 'data-subnet', 'agw', 'vmss', 'sql'].includes(r.id));
    s.connections = [];
    expect(repairSpecInput(s).report.privateEndpoints).toBe(0);
  });
  test('a private flexible server in a shared subnet is moved to a subnet of its own, with a free address range', () => {
    const s = spec();
    s.resources = s.resources.filter((r) => r.id !== 'sql');
    s.resources.push({ id: 'db', type: 'azure_postgres', label: 'Database', parent: 'app-subnet', config: { skuName: 'GP_Standard_D2ds_v5', highAvailability: 'ZoneRedundant' } });
    s.connections = s.connections.map((c) => (c.to === 'sql' ? { ...c, to: 'db' } : c));
    const { value, report } = repairSpecInput(s);
    expect(report.flexSubnets).toBe(1);
    const out = value as ArchitectureSpec;
    const db = out.resources.find((r) => r.id === 'db')!;
    const sub = out.resources.find((r) => r.id === db.parent)!;
    expect(sub.type).toBe('azure_subnet');
    expect(db.parent).not.toBe('app-subnet');
    const ranges = out.resources.filter((r) => r.type === 'azure_subnet').map((r) => r.config?.['addressPrefix']);
    expect(new Set(ranges).size).toBe(ranges.length);
    expect(evaluateSpec(value, { autoRepair: true }).issues).toEqual([]);
  });
  test('a monitor or registry drawn as calling the application is turned around', () => {
    const s = spec();
    s.connections = s.connections.map((c) => (c.to === 'mon' ? { from: 'mon', to: 'vmss' } : c));
    const { value, report } = repairSpecInput(s);
    expect(report.reversed).toBe(1);
    expect((value as ArchitectureSpec).connections).toEqual(expect.arrayContaining([{ from: 'vmss', to: 'mon' }]));
  });
  test('the repair never adds anything to an AWS design', () => {
    const aws: ArchitectureSpec = { name: 'a', summary: 'b', resources: [{ id: 'cloud', type: 'aws_cloud_boundary', label: 'AWS' }, { id: 'bucket', type: 'aws_s3', label: 'Bucket', parent: 'cloud' }], connections: [] };
    expect(repairSpecInput(aws).report.privateEndpoints).toBe(0);
  });
});

// ─── verified patterns ───────────────────────────────────────────────────────

describe('verified Azure patterns pass every gate for every engine and queue option', () => {
  const base: Requirements = { provider: 'azure', pattern: '', region: 'westeurope', scale: 'medium', db: 'postgres', cache: true, cdn: true, regulated: false, queue: false, app: 'shop' };
  const patterns: Array<[string, (r: Requirements) => ArchitectureSpec, Partial<Requirements>]> = [
    ['three-tier', azureThreeTier, {}], ['app-service', azureAppService, {}], ['aks', azureAks, {}], ['gateway-app-service', azureGatewayAppService, { cdn: false }],
    ['serverless', azureServerless, { db: 'nosql', cache: false }], ['functions-private-api', azureFunctionsPrivateApi, { db: 'sql', cache: false, cdn: false }],
  ];
  const dbs: Database[] = ['postgres', 'mysql', 'sql', 'nosql', 'none'];
  test.each(patterns)('%s', (_n, fn, fixed) => {
    for (const db of fixed.db ? [fixed.db] : dbs) for (const queue of fixed.db === 'nosql' ? [false] : [false, true]) for (const regulated of [false, true]) {
      const r = { ...base, ...fixed, db, queue, regulated };
      const out = evaluateSpec(fn(r));
      expect({ db, queue, regulated, ok: out.ok, issues: out.issues.slice(0, 3).map((i) => i.message) }).toEqual({ db, queue, regulated, ok: true, issues: [] });
    }
  });
  test('the engine that was asked for is the engine that is drawn', () => {
    const types = (db: Database) => azureThreeTier({ ...base, db }).resources.map((r) => r.type);
    expect(types('postgres')).toContain('azure_postgres');
    expect(types('postgres')).not.toContain('azure_sql');
    expect(types('mysql')).toContain('azure_mysql');
    expect(types('sql')).toContain('azure_sql');
  });
  test('the three-tier pattern has separate web and API tiers across zones, and a queue when asked', () => {
    const s = azureThreeTier({ ...base, queue: true });
    expect(s.resources.filter((r) => r.type === 'azure_vmss').map((r) => r.id).sort()).toEqual(['api', 'vmss']);
    expect(s.connections).toEqual(expect.arrayContaining([{ from: 'vmss', to: 'api' }]));
    expect(s.resources.filter((r) => r.type === 'azure_vmss').every((r) => r.config?.['zones'] === '1,2,3')).toBe(true);
    expect(s.resources.some((r) => r.type === 'azure_service_bus')).toBe(true);
  });
});
