/**
 * Discovery of the Azure managed services CloudCraft models since lib/resources/azureServices.ts: PostgreSQL and MySQL flexible servers,
 * Service Bus namespaces, Container Registries, Log Analytics workspaces and Private Endpoints.
 *
 * One generic reader (the Resource Manager "list by type" call, then "get by id" for the properties) instead of five more SDK packages. Each
 * mapper reads only what the API returned: a setting the API did not return is left out, so the assessment reports it as not evaluated and
 * never fills in a default (see the field-level provenance in lib/engines/assessment).
 */
import type { CloudResource } from '../discovery/types';
import { computeConfigHash } from '../discovery/utils';

/** The two Resource Manager calls used, so tests can stand in for Azure. */
export interface ArmResourceReader {
  list(options: { filter: string }): AsyncIterable<{ id?: string; name?: string; location?: string; tags?: Record<string, string> }>;
  getById(id: string, apiVersion: string): Promise<{ id?: string; name?: string; location?: string; tags?: Record<string, string>; sku?: { name?: string; tier?: string; capacity?: number }; properties?: Record<string, any> }>;
}

type Props = Record<string, any>;
type Resource = { name?: string; sku?: { name?: string; tier?: string; capacity?: number }; properties?: Props };

const enabled = (v: unknown): boolean | undefined => (v === undefined || v === null ? undefined : String(v).toLowerCase() === 'enabled');
/** "Enabled"/"Disabled" public access settings, where anything else (for example SecuredByPerimeter) counts as not public. */
const publicAccess = (v: unknown): boolean | undefined => (v === undefined || v === null ? undefined : String(v).toLowerCase() === 'enabled');
const compact = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const TIER_PREFIX: Record<string, string> = { burstable: 'B', generalpurpose: 'GP', memoryoptimized: 'MO' };
/** "Standard_D2ds_v5" + "GeneralPurpose" -> "GP_Standard_D2ds_v5", the form the Terraform provider and the catalog use. */
export const flexibleSkuName = (sku?: { name?: string; tier?: string }): string | undefined => {
  const prefix = TIER_PREFIX[String(sku?.tier ?? '').toLowerCase()];
  return sku?.name && prefix ? `${prefix}_${sku.name}` : undefined;
};

function flexible(r: Resource, kind: 'postgres' | 'mysql'): Record<string, unknown> {
  const p = r.properties ?? {};
  const subnetId = p.network?.delegatedSubnetResourceId as string | undefined;
  return compact({
    name: r.name,
    version: p.version,
    skuName: flexibleSkuName(r.sku),
    storageGb: p.storage?.storageSizeGB,
    highAvailability: p.highAvailability?.mode === undefined ? undefined : p.highAvailability.mode === 'ZoneRedundant' ? 'ZoneRedundant' : 'Disabled',
    backupRetentionDays: p.backup?.backupRetentionDays,
    geoRedundantBackup: enabled(p.backup?.geoRedundantBackup),
    // Placed in a subnet means private access; otherwise the public setting decides.
    publicNetworkAccess: subnetId ? false : publicAccess(p.network?.publicNetworkAccess),
    subnetId,
    engine: kind,
  });
}

export const MAP_SERVICE_BUS = (r: Resource): Record<string, unknown> => {
  const p = r.properties ?? {};
  return compact({
    name: r.name,
    sku: r.sku?.name,
    capacity: r.sku?.name === 'Premium' ? r.sku.capacity : undefined,
    zoneRedundant: typeof p.zoneRedundant === 'boolean' ? p.zoneRedundant : undefined,
    localAuthEnabled: typeof p.disableLocalAuth === 'boolean' ? !p.disableLocalAuth : undefined,
    minimumTlsVersion: p.minimumTlsVersion,
    publicNetworkAccess: publicAccess(p.publicNetworkAccess),
  });
};

export const MAP_ACR = (r: Resource): Record<string, unknown> => {
  const p = r.properties ?? {};
  return compact({
    name: r.name,
    sku: r.sku?.name,
    adminEnabled: typeof p.adminUserEnabled === 'boolean' ? p.adminUserEnabled : undefined,
    publicNetworkAccess: publicAccess(p.publicNetworkAccess),
    zoneRedundant: enabled(p.zoneRedundancy),
  });
};

export const MAP_LOG_ANALYTICS = (r: Resource): Record<string, unknown> => {
  const p = r.properties ?? {};
  return compact({
    name: r.name,
    retentionDays: p.retentionInDays,
    dailyQuotaGb: typeof p.workspaceCapping?.dailyQuotaGb === 'number' ? p.workspaceCapping.dailyQuotaGb : undefined,
    internetIngestionEnabled: enabled(p.publicNetworkAccessForIngestion),
    internetQueryEnabled: enabled(p.publicNetworkAccessForQuery),
  });
};

export const MAP_PRIVATE_ENDPOINT = (r: Resource): Record<string, unknown> => {
  const p = r.properties ?? {};
  const connections: Props[] = [...(p.privateLinkServiceConnections ?? []), ...(p.manualPrivateLinkServiceConnections ?? [])];
  const groupId = connections[0]?.properties?.groupIds?.[0] as string | undefined;
  const STORAGE = new Set(['blob', 'file', 'queue', 'table', 'dfs']);
  return compact({
    name: r.name,
    subnetId: p.subnet?.id as string | undefined,
    targetResourceIds: connections.map((c) => c.properties?.privateLinkServiceId).filter((x): x is string => typeof x === 'string'),
    subresource: groupId && STORAGE.has(groupId) ? groupId : undefined,
  });
};

const zonesSetting = (zones: unknown): string | undefined => {
  if (!Array.isArray(zones)) return undefined;
  const z = zones.map(String).sort().join(',');
  return z === '1,2' || z === '1,2,3' ? z : '';
};

export const MAP_FIREWALL = (r: Resource): Record<string, unknown> => {
  const p = r.properties ?? {};
  return compact({
    name: r.name,
    sku: r.sku?.tier === 'Premium' ? 'Premium' : r.sku?.tier === 'Standard' ? 'Standard' : undefined,
    // With a firewall policy the threat intelligence mode lives in the policy, which this reader does not follow: left unknown, not assumed.
    threatIntelMode: p.firewallPolicy?.id ? undefined : p.threatIntelMode,
    zones: zonesSetting((r as { zones?: unknown }).zones ?? p.zones),
    subnetId: p.ipConfigurations?.[0]?.properties?.subnet?.id as string | undefined,
  });
};

export const MAP_EVENT_HUBS = (r: Resource): Record<string, unknown> => {
  const p = r.properties ?? {};
  return compact({
    name: r.name,
    sku: r.sku?.name,
    capacity: r.sku?.capacity,
    zoneRedundant: typeof p.zoneRedundant === 'boolean' ? p.zoneRedundant : undefined,
    localAuthEnabled: typeof p.disableLocalAuth === 'boolean' ? !p.disableLocalAuth : undefined,
    minimumTlsVersion: p.minimumTlsVersion,
    publicNetworkAccess: publicAccess(p.publicNetworkAccess),
  });
};

export const MAP_EVENT_GRID = (r: Resource): Record<string, unknown> => {
  const p = r.properties ?? {};
  return compact({
    name: r.name,
    inputSchema: p.inputSchema,
    publicNetworkAccess: publicAccess(p.publicNetworkAccess),
    localAuthEnabled: typeof p.disableLocalAuth === 'boolean' ? !p.disableLocalAuth : undefined,
  });
};

export const MAP_API_MANAGEMENT = (r: Resource): Record<string, unknown> => {
  const p = r.properties ?? {};
  return compact({
    name: r.name,
    sku: r.sku?.name,
    capacity: r.sku?.name && r.sku.name !== 'Consumption' ? r.sku.capacity : undefined,
    publisherName: p.publisherName,
    publisherEmail: p.publisherEmail,
    zones: zonesSetting((r as { zones?: unknown }).zones),
  });
};

export const MAP_CONTAINER_APP = (r: Resource): Record<string, unknown> => {
  const p = r.properties ?? {};
  const container = p.template?.containers?.[0];
  const cpu = typeof container?.resources?.cpu === 'number' ? String(container.resources.cpu) : undefined;
  return compact({
    name: r.name,
    image: container?.image,
    cpu: cpu && ['0.25', '0.5', '0.75', '1', '1.25', '1.5', '1.75', '2'].includes(cpu) ? cpu : undefined,
    minReplicas: p.template?.scale?.minReplicas,
    maxReplicas: p.template?.scale?.maxReplicas,
    targetPort: p.configuration?.ingress?.targetPort,
    externalIngress: typeof p.configuration?.ingress?.external === 'boolean' ? p.configuration.ingress.external : undefined,
  });
};

export interface ArmServiceType {
  armType: string;
  apiVersion: string;
  /** Raw type name the normalizer maps to a CloudCraft resource type (lib/cloud/normalizer.ts). */
  resourceType: string;
  fallbackName: string;
  map: (r: Resource) => Record<string, unknown>;
}

export const ARM_SERVICE_TYPES: ArmServiceType[] = [
  { armType: 'Microsoft.DBforPostgreSQL/flexibleServers', apiVersion: '2023-03-01-preview', resourceType: 'postgres-flexible-server', fallbackName: 'unnamed-postgres', map: (r) => flexible(r, 'postgres') },
  { armType: 'Microsoft.DBforMySQL/flexibleServers', apiVersion: '2023-06-30', resourceType: 'mysql-flexible-server', fallbackName: 'unnamed-mysql', map: (r) => flexible(r, 'mysql') },
  { armType: 'Microsoft.ServiceBus/namespaces', apiVersion: '2022-10-01-preview', resourceType: 'service-bus', fallbackName: 'unnamed-servicebus', map: MAP_SERVICE_BUS },
  { armType: 'Microsoft.ContainerRegistry/registries', apiVersion: '2023-07-01', resourceType: 'container-registry', fallbackName: 'unnamed-registry', map: MAP_ACR },
  { armType: 'Microsoft.OperationalInsights/workspaces', apiVersion: '2022-10-01', resourceType: 'log-analytics', fallbackName: 'unnamed-workspace', map: MAP_LOG_ANALYTICS },
  { armType: 'Microsoft.Network/azureFirewalls', apiVersion: '2023-09-01', resourceType: 'azure-firewall', fallbackName: 'unnamed-firewall', map: MAP_FIREWALL },
  { armType: 'Microsoft.EventHub/namespaces', apiVersion: '2022-10-01-preview', resourceType: 'event-hubs', fallbackName: 'unnamed-eventhubs', map: MAP_EVENT_HUBS },
  { armType: 'Microsoft.EventGrid/topics', apiVersion: '2022-06-15', resourceType: 'event-grid-topic', fallbackName: 'unnamed-topic', map: MAP_EVENT_GRID },
  { armType: 'Microsoft.ApiManagement/service', apiVersion: '2022-08-01', resourceType: 'api-management', fallbackName: 'unnamed-apim', map: MAP_API_MANAGEMENT },
  { armType: 'Microsoft.App/containerApps', apiVersion: '2023-05-01', resourceType: 'container-app', fallbackName: 'unnamed-container-app', map: MAP_CONTAINER_APP },
  { armType: 'Microsoft.Network/privateEndpoints', apiVersion: '2023-09-01', resourceType: 'private-endpoint', fallbackName: 'unnamed-private-endpoint', map: MAP_PRIVATE_ENDPOINT },
];

const resourceGroupOf = (id: string) => id.match(/\/resourceGroups\/([^/]+)\//i)?.[1] ?? 'unknown';

/** Reads every service of the types above. A type that cannot be read (no permission, not registered) is skipped; the others still return. */
export async function discoverAzureServices(reader: ArmResourceReader, subscriptionId: string, now: () => string = () => new Date().toISOString()): Promise<{ resources: CloudResource[]; skipped: string[] }> {
  const resources: CloudResource[] = [];
  const skipped: string[] = [];
  for (const t of ARM_SERVICE_TYPES) {
    try {
      for await (const item of reader.list({ filter: `resourceType eq '${t.armType}'` })) {
        const id = typeof item.id === 'string' ? item.id : '';
        if (!id) continue;
        let full: Awaited<ReturnType<ArmResourceReader['getById']>> | null = null;
        try { full = await reader.getById(id, t.apiVersion); } catch { /* the properties could not be read: keep the resource with what the list gave */ }
        const configuration = { ...t.map(full ?? { name: item.name }), source: 'azure-arm', imported: true };
        resources.push({
          id, provider: 'azure', subscriptionId, region: (full?.location ?? item.location ?? 'unknown').toLowerCase().replace(/\s+/g, ''),
          resourceType: t.resourceType, name: full?.name ?? item.name ?? t.fallbackName, arn: id, resourceId: id,
          tags: full?.tags ?? item.tags ?? {}, status: 'unknown', configuration, metadata: { resourceGroup: resourceGroupOf(id) },
          configurationHash: computeConfigHash(configuration), discoveredAt: now(),
        });
      }
    } catch {
      skipped.push(t.armType);
    }
  }
  return { resources, skipped };
}
