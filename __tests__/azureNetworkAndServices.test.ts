/**
 * What the first round of Azure fixes left out: a static website behind Front Door, network security groups and route tables that really apply to
 * their subnets, Azure Firewall, Event Hubs, Event Grid, API Management and Container Apps, discovery of all the new services, and the
 * AWS-to-Azure cost comparison for them.
 */
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureConnection, DbArchitectureResource } from '@/lib/repositories/architectureRepository';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { relationshipEngine } from '@/lib/engines/relationship/RelationshipEngine';
import { azurePricingProvider } from '@/lib/engines/cost/azurePricing';
import { getResourceDefinition } from '@/lib/resources';
import { CloudCostComparisonService } from '@/lib/engines/comparison/CloudCostComparisonService';
import { discoverAzureServices, flexibleSkuName, ARM_SERVICE_TYPES, type ArmResourceReader } from '@/lib/cloud/adapters/azureServicesDiscovery';
import { normalizeDiscoveredInfrastructure } from '@/lib/cloud/normalizer';
import { evaluateSpec, type ArchitectureSpec } from '@/lib/ai/architectureSpec';
import { repairSpecInput } from '@/lib/ai/specRepair';
import { azureStaticSite } from '../scripts/ai-dataset/morePatterns';
import type { CanvasNode } from '@/types';

const res = (id: string, resourceType: string, config: Record<string, unknown> = {}, groupId: string | null = null): DbArchitectureResource => ({
  id, resourceType, provider: 'azure', label: id, positionX: 0, positionY: 0, configJson: JSON.stringify({ name: id, ...config }), region: null, groupId, locked: false, architectureId: 'a',
} as DbArchitectureResource);
const link = (s: string, t: string): DbArchitectureConnection => ({ id: `${s}-${t}`, label: null, edgeType: null, sourceId: s, targetId: t, architectureId: 'a' });
const tf = (resources: DbArchitectureResource[], connections: DbArchitectureConnection[] = []) => {
  const r = new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections });
  return { main: r.files.find((f) => f.filename === 'main.tf')!.content, warnings: r.warnings };
};
const node = (id: string, resourceType: string, config: Record<string, unknown> = {}, parentId?: string): CanvasNode => ({
  id, type: 'cloudNode', resourceType, provider: 'azure', label: id, position: { x: 0, y: 0 },
  config: { ...(getResourceDefinition(resourceType)?.defaultConfig ?? {}), ...config }, ...(parentId ? { parentId, groupId: parentId } : {}),
} as CanvasNode);
const status = (nodes: CanvasNode[], ruleId: string) => runAssessment({ nodes, edges: [] }).evaluations.find((e) => e.ruleId === ruleId)?.status;
const vnet = res('vnet', 'azure_vnet');
const sub = (id: string, prefix: string) => res(id, 'azure_subnet', { addressPrefix: prefix }, 'vnet');

// ─── static website behind Front Door ───────────────────────────────────────

describe('static website behind Front Door', () => {
  const site = [res('s', 'azure_storage', { staticWebsite: true, networkDefaultAction: 'Allow', indexDocument: 'main.html', errorDocument: 'oops.html' }), res('fd', 'azure_front_door', { sku: 'Premium_AzureFrontDoor' }), res('w', 'azure_waf')];
  const links = [link('fd', 's'), link('w', 'fd')];

  test('the storage account serves the website and Front Door uses its real web host, not an example name', () => {
    const t = tf(site, links);
    expect(t.main).toContain('static_website {');
    expect(t.main).toContain('index_document     = "main.html"');
    expect(t.main).toContain('host_name                     = azurerm_storage_account.s.primary_web_host');
    expect(t.main).toContain('origin_host_header            = azurerm_storage_account.s.primary_web_host');
    expect(t.main).not.toContain('origin.example.com');
  });
  test('a storage account that is not a website is reached on its blob host', () => {
    expect(tf([res('s', 'azure_storage'), res('fd', 'azure_front_door')], [link('fd', 's')]).main).toContain('primary_blob_host');
  });
  test('App Service, Functions and Application Gateway origins are references too', () => {
    expect(tf([res('a', 'azure_app_service'), res('fd', 'azure_front_door')], [link('fd', 'a')]).main).toContain('azurerm_linux_web_app.a.default_hostname');
    expect(tf([res('f', 'azure_functions'), res('fd', 'azure_front_door')], [link('fd', 'f')]).main).toContain('azurerm_linux_function_app.f.default_hostname');
    const agw = tf([res('g', 'azure_app_gateway'), res('fd', 'azure_front_door')], [link('fd', 'g')]).main;
    expect(agw).toContain('azurerm_public_ip.g_pip.ip_address');
    expect(agw).toContain('certificate_name_check_enabled = false');
  });
  test('a Front Door with nothing to serve and the example origin says so', () => {
    expect(tf([res('fd', 'azure_front_door')]).warnings.join(' ')).toMatch(/not connected to anything it can serve/);
  });
  test('the WAF is a Front Door policy attached to the endpoint by a security policy; managed rules only on Premium', () => {
    const premium = tf(site, links);
    expect(premium.main).toContain('resource "azurerm_cdn_frontdoor_firewall_policy" "w"');
    expect(premium.main).toContain('resource "azurerm_cdn_frontdoor_security_policy" "w_attach"');
    expect(premium.main).toContain('Microsoft_DefaultRuleSet');
    expect(premium.main).toContain('cdn_frontdoor_domain_id = azurerm_cdn_frontdoor_endpoint.fd_endpoint.id');
    expect(premium.main).not.toContain('azurerm_web_application_firewall_policy');
    const standard = tf([site[0]!, res('fd', 'azure_front_door'), site[2]!], links);
    expect(standard.main).not.toContain('Microsoft_DefaultRuleSet');
    expect(standard.main).toContain('RateLimitRule');
    expect(standard.warnings.join(' ')).toMatch(/Standard tier/);
  });
  test('a WAF not connected to a Front Door is still the Application Gateway kind', () => {
    expect(tf([res('w', 'azure_waf')]).main).toContain('azurerm_web_application_firewall_policy');
  });
  test('the open network of a static website is not a finding; a normal account still is', () => {
    expect(status([node('s', 'azure_storage', { staticWebsite: true, networkDefaultAction: 'Allow' })], 'AZ-STG-004')).toBe('NOT_APPLICABLE');
    expect(status([node('s', 'azure_storage', { networkDefaultAction: 'Allow' })], 'AZ-STG-004')).toBe('FAIL');
  });
  test('the static-site pattern passes every gate and is a public website with blob access disabled', () => {
    const spec = azureStaticSite({ provider: 'azure', pattern: '', region: 'westeurope', scale: 'small', db: 'none', cache: false, cdn: true, regulated: false, queue: false, app: 'blog' });
    const storage = spec.resources.find((r) => r.type === 'azure_storage')!;
    expect(storage.config).toMatchObject({ staticWebsite: true, networkDefaultAction: 'Allow', allowBlobPublicAccess: false });
    expect(evaluateSpec(spec).issues).toEqual([]);
  });
});

// ─── network security groups and route tables ───────────────────────────────

describe('subnet associations', () => {
  test('a network security group and a route table drawn against a subnet are associated with it', () => {
    const t = tf([vnet, sub('app', '10.0.2.0/24'), res('nsg', 'azure_nsg', {}, 'vnet'), res('rt', 'azure_route_table', {}, 'vnet')], [link('nsg', 'app'), link('rt', 'app')]);
    expect(t.main).toContain('resource "azurerm_subnet_network_security_group_association" "nsg_app"');
    expect(t.main).toContain('network_security_group_id = azurerm_network_security_group.nsg.id');
    expect(t.main).toContain('resource "azurerm_subnet_route_table_association" "rt_app"');
  });
  test('the subnet of an Application Gateway gets the rule Azure needs to manage the gateway', () => {
    const t = tf([vnet, sub('web', '10.0.1.0/24'), res('agw', 'azure_app_gateway', {}, 'web'), res('nsg', 'azure_nsg', {}, 'vnet')], [link('nsg', 'web')]);
    expect(t.main).toContain('destination_port_range      = "65200-65535"');
    expect(t.main).toContain('source_address_prefix       = "GatewayManager"');
  });
  test('a plain subnet does not get that rule', () => {
    expect(tf([vnet, sub('app', '10.0.2.0/24'), res('nsg', 'azure_nsg', {}, 'vnet')], [link('nsg', 'app')]).main).not.toContain('GatewayManager');
  });
  test('Firewall and Bastion subnets take no group (Azure refuses or needs special rules), and the person is told', () => {
    const t = tf([vnet, sub('fw', '10.0.1.0/24'), sub('bas', '10.0.2.0/24'), res('fwx', 'azure_firewall', {}, 'fw'), res('b', 'azure_bastion', {}, 'bas'), res('n1', 'azure_nsg', {}, 'vnet'), res('n2', 'azure_nsg', {}, 'vnet')], [link('n1', 'fw'), link('n2', 'bas')]);
    expect(t.main).not.toContain('azurerm_subnet_network_security_group_association');
    expect(t.warnings.join(' ')).toMatch(/Azure Firewall, which Azure does not allow/);
    expect(t.warnings.join(' ')).toMatch(/Azure Bastion/);
  });
  test('imported groups and subnets are left alone', () => {
    const t = tf([vnet, res('app', 'azure_subnet', { addressPrefix: '10.0.2.0/24', imported: true }, 'vnet'), res('nsg', 'azure_nsg', {}, 'vnet')], [link('nsg', 'app')]);
    expect(t.main).not.toContain('association');
  });
  test('the subnets of a firewall and a Bastion host carry the names Azure requires', () => {
    const t = tf([vnet, sub('fw', '10.0.1.0/24'), sub('bas', '10.0.2.0/24'), res('f', 'azure_firewall', {}, 'fw'), res('b', 'azure_bastion', {}, 'bas')]);
    expect(t.main).toMatch(/resource "azurerm_subnet" "fw" \{\s+name\s+= "AzureFirewallSubnet"/);
    expect(t.main).toMatch(/resource "azurerm_subnet" "bas" \{\s+name\s+= "AzureBastionSubnet"/);
  });
});

// ─── new services ────────────────────────────────────────────────────────────

describe('Azure Firewall', () => {
  test('address, policy with a baseline rule, and the firewall in its subnet; the route table sends traffic through it', () => {
    const t = tf([vnet, sub('fw', '10.0.1.0/24'), res('f', 'azure_firewall', { sku: 'Premium', threatIntelMode: 'Deny', zones: '1,2,3', dnsProxy: true }, 'fw'), res('rt', 'azure_route_table', {}, 'vnet')], [link('rt', 'f')]);
    expect(t.main).toContain('sku_tier            = "Premium"');
    expect(t.main).toContain('threat_intelligence_mode = "Deny"');
    expect(t.main).toContain('proxy_enabled = true');
    expect(t.main).toContain('allow-web-outbound');
    expect(t.main).toContain('zones               = ["1", "2", "3"]');
    expect(t.main).toContain('next_hop_type  = "VirtualAppliance"');
    expect(t.main).toContain('next_hop_in_ip_address = azurerm_firewall.f.ip_configuration[0].private_ip_address');
  });
  test('without a subnet only the address and policy are generated, with a warning', () => {
    const t = tf([res('f', 'azure_firewall')]);
    expect(t.main).not.toContain('resource "azurerm_firewall" ');
    expect(t.main).toContain('azurerm_firewall_policy');
    expect(t.warnings.join(' ')).toMatch(/not placed in a subnet/);
  });
  test('rules: threat intelligence off fails, zones warn', () => {
    expect(status([node('f', 'azure_firewall', { threatIntelMode: 'Off' })], 'AZ-FW-001')).toBe('FAIL');
    expect(status([node('f', 'azure_firewall')], 'AZ-FW-001')).toBe('PASS');
    expect(status([node('f', 'azure_firewall')], 'AZ-FW-010')).toBe('WARNING');
  });
  test('cost: deployment hours plus data', () => {
    const price = (c: Record<string, unknown>) => azurePricingProvider.estimateResource({ id: 'r', label: 'r', resourceType: 'azure_firewall', provider: 'azure' } as never, { ...getResourceDefinition('azure_firewall')!.defaultConfig, ...c }, 'eastus')!;
    expect(price({ sku: 'Standard', estimatedDataGbPerMonth: 100 }).monthlyUsd).toBeCloseTo(1.25 * 730 + 100 * 0.016, 1);
    expect(price({ sku: 'Premium', estimatedDataGbPerMonth: 0 }).monthlyUsd).toBeCloseTo(1.75 * 730, 1);
  });
});

describe('Event Hubs and Event Grid', () => {
  test('Event Hubs: namespace, de-duplicated hubs, limits per tier', () => {
    const t = tf([res('eh', 'azure_event_hubs', { sku: 'Basic', hubNames: 'a, b,a', retentionDays: 30, capacity: 99, publicNetworkAccess: false })]);
    expect((t.main.match(/resource "azurerm_eventhub" /g) ?? []).length).toBe(2);
    expect(t.main).toContain('message_retention   = 1');
    expect(t.main).toContain('capacity                      = 20');
    expect(t.main).toContain('public_network_access_enabled = true');
    expect(t.warnings.join(' ')).toMatch(/Standard or Premium/);
    expect(t.warnings.join(' ')).toMatch(/keeps events up to 1 day/);
  });
  test('Event Hubs Premium keeps events longer and is zone-redundant on request', () => {
    const t = tf([res('eh', 'azure_event_hubs', { sku: 'Premium', retentionDays: 30, zoneRedundant: true })]);
    expect(t.main).toContain('message_retention   = 30');
    expect(t.main).toContain('zone_redundant                = true');
  });
  test('Event Grid: topic with the chosen schema, and a note that subscriptions are not generated', () => {
    const t = tf([res('eg', 'azure_event_grid', { inputSchema: 'CloudEventSchemaV1_0', localAuthEnabled: false })]);
    expect(t.main).toContain('input_schema                  = "CloudEventSchemaV1_0"');
    expect(t.main).toContain('local_auth_enabled            = false');
    expect(t.main).toMatch(/Event subscriptions .* are not generated/);
  });
  test('both can be reached privately: Event Hubs from the Standard tier up, Event Grid on any', () => {
    const t = tf([vnet, sub('pe', '10.0.4.0/24'), res('eh', 'azure_event_hubs', { publicNetworkAccess: false }), res('eg', 'azure_event_grid', { publicNetworkAccess: false }), res('p1', 'azure_private_endpoint', {}, 'pe'), res('p2', 'azure_private_endpoint', {}, 'pe')], [link('p1', 'eh'), link('p2', 'eg')]);
    expect(t.main).toContain('subresource_names              = ["topic"]');
    expect(t.main).toContain('privatelink.eventgrid.azure.net');
    expect(t.main).toContain('azurerm_eventhub_namespace.eh.id');
  });
  test('rules and cost', () => {
    expect(status([node('e', 'azure_event_hubs', { sku: 'Basic' })], 'AZ-EH-010')).toBe('NOT_APPLICABLE');
    expect(status([node('e', 'azure_event_hubs')], 'AZ-EH-010')).toBe('WARNING');
    const price = (t: string, c: Record<string, unknown>) => azurePricingProvider.estimateResource({ id: 'r', label: 'r', resourceType: t, provider: 'azure' } as never, { ...getResourceDefinition(t)!.defaultConfig, ...c }, 'eastus')!;
    expect(price('azure_event_hubs', { sku: 'Standard', capacity: 2, estimatedMillionEventsPerMonth: 10 }).monthlyUsd).toBeCloseTo(0.03 * 2 * 730 + 10 * 0.028, 1);
    expect(price('azure_event_hubs', { sku: 'Premium', capacity: 1 }).monthlyUsd).toBeCloseTo(1.027 * 730, 1);
    expect(price('azure_event_grid', { estimatedMillionOpsPerMonth: 1 }).monthlyUsd).toBeCloseTo(0.9 * 0.6, 2);
  });
});

describe('API Management and Container Apps', () => {
  test('API Management: tier and units form the SKU name, the publisher placeholders stop a deployment, zones only on Premium', () => {
    const t = tf([res('a', 'azure_api_management', { sku: 'Premium', capacity: 99, zones: '1,2,3' }), res('b', 'azure_api_management', { sku: 'Consumption', capacity: 5, zones: '1,2' }), res('c', 'azure_api_management', { sku: 'Developer', capacity: 3 })]);
    expect(t.main).toContain('sku_name            = "Premium_12"');
    expect(t.main).toContain('sku_name            = "Consumption_0"');
    expect(t.main).toContain('sku_name            = "Developer_1"');
    expect((t.main.match(/zones               =/g) ?? []).length).toBe(1);
    expect(t.main).toContain('REPLACE-WITH-YOUR-EMAIL');
  });
  test('API Management rules and cost', () => {
    expect(status([node('a', 'azure_api_management')], 'AZ-APIM-001')).toBe('WARNING');
    expect(status([node('a', 'azure_api_management', { sku: 'Standard' })], 'AZ-APIM-001')).toBe('PASS');
    expect(status([node('a', 'azure_api_management', { sku: 'Premium' })], 'AZ-APIM-010')).toBe('WARNING');
    const price = (c: Record<string, unknown>) => azurePricingProvider.estimateResource({ id: 'r', label: 'r', resourceType: 'azure_api_management', provider: 'azure' } as never, { ...getResourceDefinition('azure_api_management')!.defaultConfig, ...c }, 'eastus')!;
    expect(price({ sku: 'Developer' }).monthlyUsd).toBeCloseTo(0.0658 * 730, 1);
    expect(price({ sku: 'Standard', capacity: 2 }).monthlyUsd).toBeCloseTo(0.9407 * 2 * 730, 1);
    expect(price({ sku: 'Consumption', estimatedMillionCallsPerMonth: 3 }).monthlyUsd).toBeCloseTo(7, 1);
  });
  test('Container Apps: environment and app, memory twice the vCPU, the Log Analytics workspace it is connected to', () => {
    const t = tf([res('m', 'azure_monitor'), res('c', 'azure_container_apps', { cpu: '1.25', image: 'r.azurecr.io/a:1', minReplicas: 2, maxReplicas: 1 })], [link('c', 'm')]);
    expect(t.main).toContain('cpu    = 1.25');
    expect(t.main).toContain('memory = "2.5Gi"');
    expect(t.main).toContain('log_analytics_workspace_id = azurerm_log_analytics_workspace.m.id');
    expect(t.main).toContain('max_replicas = 2');                           // never below the minimum
    expect(t.main).toContain('image  = "r.azurecr.io/a:1"');
  });
  test('Container Apps in a subnet are integrated with it; zone redundancy needs the subnet', () => {
    const placed = tf([vnet, sub('aca', '10.0.4.0/23'), res('c', 'azure_container_apps', { zoneRedundant: true, externalIngress: false }, 'aca')]);
    expect(placed.main).toContain('infrastructure_subnet_id   = azurerm_subnet.aca.id');
    expect(placed.main).toContain('internal_load_balancer_enabled = true');
    expect(placed.main).toContain('zone_redundancy_enabled    = true');
    const loose = tf([res('c', 'azure_container_apps', { zoneRedundant: true })]);
    expect(loose.main).not.toContain('zone_redundancy_enabled');
    expect(loose.warnings.join(' ')).toMatch(/needs the app to be placed in a subnet/);
  });
  test('Container Apps rules: the subnet must be a /23 or larger and its own; internet ingress is only a recommendation', () => {
    expect(status([node('s', 'azure_subnet', { addressPrefix: '10.0.4.0/24' }), node('c', 'azure_container_apps', {}, 's')], 'AZ-CA-001')).toBe('FAIL');
    expect(status([node('s', 'azure_subnet', { addressPrefix: '10.0.4.0/23' }), node('c', 'azure_container_apps', {}, 's')], 'AZ-CA-001')).toBe('PASS');
    expect(status([node('s', 'azure_subnet', { addressPrefix: '10.0.4.0/23' }), node('c', 'azure_container_apps', {}, 's'), node('v', 'azure_vmss', {}, 's')], 'AZ-CA-001')).toBe('FAIL');
    expect(status([node('c', 'azure_container_apps')], 'AZ-CA-001')).toBe('NOT_APPLICABLE');
    const a = runAssessment({ nodes: [node('c', 'azure_container_apps')], edges: [] });
    expect(a.findings.find((f) => f.ruleId === 'AZ-CA-002')?.severity).toBe('LOW');
  });
  test('Container Apps cost: always-on replicas at the active/idle mix, requests after the free 2 million', () => {
    const price = (c: Record<string, unknown>) => azurePricingProvider.estimateResource({ id: 'r', label: 'r', resourceType: 'azure_container_apps', provider: 'azure' } as never, { ...getResourceDefinition('azure_container_apps')!.defaultConfig, ...c }, 'eastus')!;
    const secs = 730 * 3600;
    expect(price({ cpu: '1', minReplicas: 1, estimatedActivePercent: 100, estimatedMillionRequestsPerMonth: 0 }).monthlyUsd).toBeCloseTo(secs * 0.000024 + 2 * secs * 0.000003, 1);
    expect(price({ minReplicas: 0, estimatedMillionRequestsPerMonth: 12 }).monthlyUsd).toBeCloseTo(10 * 0.4, 2);
  });
  test('a Container App connects like an App Service; Event Hubs trigger Functions; a route table reaches a firewall', () => {
    const ok = (a: CanvasNode, b: CanvasNode) => relationshipEngine.validateConnection(a, b, [a, b], []);
    expect(ok(node('c', 'azure_container_apps'), node('d', 'azure_postgres'))).toMatchObject({ isValid: true, port: 5432 });
    expect(ok(node('c', 'azure_container_apps'), node('b', 'azure_service_bus'))).toMatchObject({ isValid: true });
    expect(ok(node('e', 'azure_event_hubs'), node('f', 'azure_functions'))).toMatchObject({ isValid: true, relationshipType: 'TRIGGERS' });
    expect(ok(node('e', 'azure_event_hubs'), node('v', 'azure_vmss')).isValid).toBe(false);
    expect(ok(node('f', 'azure_functions'), node('e', 'azure_event_hubs'))).toMatchObject({ isValid: true, port: 5671 });
    expect(ok(node('g', 'azure_event_grid'), node('f', 'azure_functions'))).toMatchObject({ isValid: true, relationshipType: 'TRIGGERS' });
    expect(ok(node('a', 'azure_app_gateway'), node('m', 'azure_api_management'))).toMatchObject({ isValid: true, port: 443 });
    expect(ok(node('m', 'azure_api_management'), node('f', 'azure_functions'))).toMatchObject({ isValid: true });
    expect(ok(node('r', 'azure_route_table'), node('w', 'azure_firewall'))).toMatchObject({ isValid: true, relationshipType: 'ROUTES_TO' });
  });
});

// ─── discovery ───────────────────────────────────────────────────────────────

describe('discovery of the new services', () => {
  const SUB = '/subscriptions/s1/resourceGroups/rg1/providers';
  const fixtures: Record<string, { item: Record<string, unknown>; full: Record<string, unknown> }> = {
    'Microsoft.DBforPostgreSQL/flexibleServers': {
      item: { id: `${SUB}/Microsoft.DBforPostgreSQL/flexibleServers/pg1`, name: 'pg1', location: 'West Europe' },
      full: { id: `${SUB}/Microsoft.DBforPostgreSQL/flexibleServers/pg1`, name: 'pg1', location: 'westeurope', sku: { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' },
        properties: { version: '16', storage: { storageSizeGB: 128 }, backup: { backupRetentionDays: 14, geoRedundantBackup: 'Enabled' }, highAvailability: { mode: 'ZoneRedundant' }, network: { delegatedSubnetResourceId: `${SUB}/Microsoft.Network/virtualNetworks/v/subnets/db`, publicNetworkAccess: 'Disabled' } } },
    },
    'Microsoft.ServiceBus/namespaces': {
      item: { id: `${SUB}/Microsoft.ServiceBus/namespaces/sb1`, name: 'sb1' },
      full: { id: `${SUB}/Microsoft.ServiceBus/namespaces/sb1`, name: 'sb1', location: 'westeurope', sku: { name: 'Premium', capacity: 2 }, properties: { zoneRedundant: true, disableLocalAuth: true, minimumTlsVersion: '1.2', publicNetworkAccess: 'Disabled' } },
    },
    'Microsoft.Network/privateEndpoints': {
      item: { id: `${SUB}/Microsoft.Network/privateEndpoints/pe1`, name: 'pe1' },
      full: { id: `${SUB}/Microsoft.Network/privateEndpoints/pe1`, name: 'pe1', location: 'westeurope', properties: { subnet: { id: `${SUB}/Microsoft.Network/virtualNetworks/v/subnets/pe` }, privateLinkServiceConnections: [{ properties: { privateLinkServiceId: `${SUB}/Microsoft.Storage/storageAccounts/st1`, groupIds: ['blob'] } }] } },
    },
    'Microsoft.App/containerApps': {
      item: { id: `${SUB}/Microsoft.App/containerApps/ca1`, name: 'ca1' },
      full: { id: `${SUB}/Microsoft.App/containerApps/ca1`, name: 'ca1', location: 'westeurope', properties: { template: { containers: [{ image: 'r.azurecr.io/a:1', resources: { cpu: 0.5 } }], scale: { minReplicas: 1, maxReplicas: 4 } }, configuration: { ingress: { external: false, targetPort: 8080 } } } },
    },
  };
  const reader = (failOn: string[] = [], noProps = false): ArmResourceReader => ({
    list: async function* ({ filter }) { const t = /'(.+)'/.exec(filter)![1]!; if (failOn.includes(t)) throw new Error('AuthorizationFailed'); const f = fixtures[t]; if (f) yield f.item as never; },
    getById: async (id) => { if (noProps) throw new Error('boom'); const f = Object.values(fixtures).find((x) => x.item['id'] === id)!; return f.full as never; },
  });

  test('flexible servers, Service Bus, private endpoints and Container Apps are mapped from what the API returned', async () => {
    const { resources } = await discoverAzureServices(reader(), 's1', () => '2026-10-12T00:00:00Z');
    const by = (type: string) => resources.find((r) => r.resourceType === type)!;
    expect(by('postgres-flexible-server').configuration).toMatchObject({ skuName: 'GP_Standard_D2ds_v5', storageGb: 128, highAvailability: 'ZoneRedundant', geoRedundantBackup: true, publicNetworkAccess: false, backupRetentionDays: 14 });
    expect(by('service-bus').configuration).toMatchObject({ sku: 'Premium', capacity: 2, localAuthEnabled: false, publicNetworkAccess: false, zoneRedundant: true });
    expect(by('private-endpoint').configuration).toMatchObject({ subresource: 'blob', targetResourceIds: [`${SUB}/Microsoft.Storage/storageAccounts/st1`] });
    expect(by('container-app').configuration).toMatchObject({ cpu: '0.5', minReplicas: 1, maxReplicas: 4, externalIngress: false, targetPort: 8080, image: 'r.azurecr.io/a:1' });
    expect(by('postgres-flexible-server').region).toBe('westeurope');
    expect(by('postgres-flexible-server').metadata).toMatchObject({ resourceGroup: 'rg1' });
  });
  test('a setting the API did not return is left out, never filled in', async () => {
    const { resources } = await discoverAzureServices(reader(), 's1');
    const sb = resources.find((r) => r.resourceType === 'service-bus')!;
    expect(Object.keys(sb.configuration)).not.toContain('queueNames');
    const noProps = await discoverAzureServices(reader([], true), 's1');
    const pg = noProps.resources.find((r) => r.resourceType === 'postgres-flexible-server')!;
    expect(pg.configuration).not.toHaveProperty('skuName');
    expect(pg.name).toBe('pg1');
  });
  test('a type that cannot be read is reported and does not stop the others', async () => {
    const out = await discoverAzureServices(reader(['Microsoft.ServiceBus/namespaces']), 's1');
    expect(out.skipped).toEqual(['Microsoft.ServiceBus/namespaces']);
    expect(out.resources.some((r) => r.resourceType === 'service-bus')).toBe(false);
    expect(out.resources.some((r) => r.resourceType === 'private-endpoint')).toBe(true);
  });
  test('every discovered kind becomes a CloudCraft type with the config keys that type has', async () => {
    const { resources } = await discoverAzureServices(reader(), 's1');
    const { nodes } = normalizeDiscoveredInfrastructure(resources, []);
    expect(nodes.map((n) => n.resourceType).sort()).toEqual(['azure_container_apps', 'azure_postgres', 'azure_private_endpoint', 'azure_service_bus']);
    for (const t of ARM_SERVICE_TYPES) expect(getResourceDefinition(t.resourceType === 'postgres-flexible-server' ? 'azure_postgres' : 'azure_vm')).toBeDefined();
  });
  test('SKU names are written the way the catalog and Terraform spell them', () => {
    expect(flexibleSkuName({ name: 'Standard_B1ms', tier: 'Burstable' })).toBe('B_Standard_B1ms');
    expect(flexibleSkuName({ name: 'Standard_E4ds_v5', tier: 'MemoryOptimized' })).toBe('MO_Standard_E4ds_v5');
    expect(flexibleSkuName({ name: 'x' })).toBeUndefined();
  });
});

// ─── AWS <-> Azure cost comparison ───────────────────────────────────────────

describe('cost comparison', () => {
  const aws = (id: string, resourceType: string, config: Record<string, unknown>): CanvasNode => ({ id, type: 'cloudNode', resourceType, provider: 'aws', label: id, position: { x: 0, y: 0 }, config } as CanvasNode);
  test('an RDS PostgreSQL or MySQL instance becomes the Azure flexible server of the same engine; other engines stay Azure SQL', () => {
    const out = CloudCostComparisonService.translateNodes([
      aws('a', 'aws_rds', { engine: 'postgres', instanceClass: 'db.m5.large', allocatedStorage: 100, multiAz: true }),
      aws('b', 'aws_rds', { engine: 'mysql', instanceClass: 'db.t3.micro', allocatedStorage: 10 }),
      aws('c', 'aws_rds', { engine: 'sqlserver-se', instanceClass: 'db.m5.large' }),
    ], 'azure');
    expect(out.map((n) => n.resourceType)).toEqual(['azure_postgres', 'azure_mysql', 'azure_sql']);
    expect(out[0]!.config).toMatchObject({ skuName: 'GP_Standard_D2ds_v5', storageGb: 100, highAvailability: 'ZoneRedundant' });
    expect(out[0]!.config).not.toHaveProperty('instanceClass');
    expect(out[1]!.config).toMatchObject({ skuName: 'B_Standard_B1ms', highAvailability: 'Disabled', storageGb: 20 });   // the Azure minimum
    expect(out[2]!.config).toHaveProperty('tier');
  });
  test('a Multi-AZ source never lands on a Burstable size, which has no zone-redundant HA', () => {
    const [n] = CloudCostComparisonService.translateNodes([aws('a', 'aws_rds', { engine: 'postgres', instanceClass: 'db.t3.micro', multiAz: true })], 'azure');
    expect(String(n!.config['skuName']).startsWith('GP_')).toBe(true);
  });
  test('and back: both flexible servers become RDS with their engine, and Service Bus is SQS', () => {
    const azure = (id: string, resourceType: string, config: Record<string, unknown>): CanvasNode => ({ ...aws(id, resourceType, config), provider: 'azure' });
    const out = CloudCostComparisonService.translateNodes([
      azure('p', 'azure_postgres', { skuName: 'GP_Standard_D4ds_v5', storageGb: 128, highAvailability: 'ZoneRedundant' }),
      azure('m', 'azure_mysql', { skuName: 'B_Standard_B2s', storageGb: 40 }),
      azure('s', 'azure_service_bus', { name: 'jobs' }),
    ], 'aws');
    expect(out.map((n) => n.resourceType)).toEqual(['aws_rds', 'aws_rds', 'aws_sqs']);
    expect(out[0]!.config).toMatchObject({ engine: 'postgres', multiAz: true, allocatedStorage: 128 });
    expect(out[1]!.config).toMatchObject({ engine: 'mysql', multiAz: false });
    expect(out[0]!.config).not.toHaveProperty('skuName');
  });
  test('SQS becomes a Service Bus queue namespace', () => {
    const [n] = CloudCostComparisonService.translateNodes([aws('q', 'aws_sqs', { name: 'orders' })], 'azure');
    expect(n!.resourceType).toBe('azure_service_bus');
    expect(n!.config).toMatchObject({ sku: 'Standard' });
  });
  test('server-side rows are translated the same way', () => {
    const rows = CloudCostComparisonService.translateResources([{ resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ engine: 'postgres', instanceClass: 'db.t3.medium' }), label: 'RDS PostgreSQL', region: 'us-east-1' }], 'azure');
    expect(rows[0]!.resourceType).toBe('azure_postgres');
    expect(JSON.parse(rows[0]!.configJson!)).toHaveProperty('skuName');
    expect(rows[0]!.label).toBe('Azure PostgreSQL');
  });
});

// ─── AI repair around the firewall ──────────────────────────────────────────

describe('AI repair: Azure Firewall', () => {
  const spec = (): ArchitectureSpec => ({
    name: 'x', summary: 'y',
    resources: [
      { id: 'azure-cloud', type: 'azure_cloud_boundary', label: 'Azure' },
      { id: 'vnet', type: 'azure_vnet', label: 'VNet', parent: 'azure-cloud', config: { addressSpace: '10.0.0.0/16' } },
      { id: 'fw-subnet', type: 'azure_subnet', label: 'Firewall Subnet', parent: 'vnet', config: { addressPrefix: '10.0.0.0/24' } },
      { id: 'app-subnet', type: 'azure_subnet', label: 'App Subnet', parent: 'vnet', config: { addressPrefix: '10.0.10.0/24' } },
      { id: 'web-subnet', type: 'azure_subnet', label: 'Web Subnet', parent: 'vnet', config: { addressPrefix: '10.0.20.0/24' } },
      { id: 'fw', type: 'azure_firewall', label: 'Firewall', parent: 'fw-subnet', config: { zones: '1,2,3' } },
      { id: 'agw', type: 'azure_app_gateway', label: 'Gateway', parent: 'web-subnet', config: { sku: 'WAF_v2', wafEnabled: true, wafMode: 'Prevention', zones: '1,2,3' } },
      { id: 'func', type: 'azure_functions', label: 'API', parent: 'app-subnet' },
      { id: 'nsg-fw', type: 'azure_nsg', label: 'Firewall NSG', parent: 'vnet', config: { allowHttps: true } },
    ],
    connections: [{ from: 'agw', to: 'func' }, { from: 'fw', to: 'func' }, { from: 'nsg-fw', to: 'fw-subnet' }],
  });
  test('a firewall is not a caller, its subnet takes no group, and a route table sends the workload subnets through it', () => {
    const { value, report } = repairSpecInput(spec());
    expect(report.firewalls).toBeGreaterThan(0);
    const out = value as ArchitectureSpec;
    expect(out.connections).not.toEqual(expect.arrayContaining([{ from: 'fw', to: 'func' }]));
    expect(out.resources.find((r) => r.id === 'nsg-fw')).toBeUndefined();
    const rt = out.resources.find((r) => r.type === 'azure_route_table')!;
    expect(out.connections).toEqual(expect.arrayContaining([{ from: rt.id, to: 'fw' }, { from: rt.id, to: 'app-subnet' }]));
    // never the firewall's own subnet or the gateway's, whose management traffic must not be rerouted
    expect(out.connections).not.toEqual(expect.arrayContaining([{ from: rt.id, to: 'fw-subnet' }]));
    expect(out.connections).not.toEqual(expect.arrayContaining([{ from: rt.id, to: 'web-subnet' }]));
  });
  test('the repaired design passes every gate and the standard group is not added to the firewall subnet', () => {
    const { value } = repairSpecInput(spec());
    const out = value as ArchitectureSpec;
    expect(evaluateSpec(value, { autoRepair: true }).issues).toEqual([]);
    const nsgFor = (subnet: string) => out.connections.some((c) => c.to === subnet && out.resources.find((r) => r.id === c.from)?.type === 'azure_nsg');
    expect(nsgFor('fw-subnet')).toBe(false);
    expect(nsgFor('app-subnet')).toBe(true);
  });
  test('a firewall already routed is left alone', () => {
    const s = spec();
    s.resources.push({ id: 'rt', type: 'azure_route_table', label: 'RT', parent: 'vnet' });
    s.connections.push({ from: 'rt', to: 'fw' }, { from: 'rt', to: 'app-subnet' });
    const out = repairSpecInput(s).value as ArchitectureSpec;
    expect(out.resources.filter((r) => r.type === 'azure_route_table')).toHaveLength(1);
  });
});
