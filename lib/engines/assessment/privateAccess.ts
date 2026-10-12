/**
 * Which Azure services are reached privately through a Private Endpoint, and when a design leaves one unreachable.
 *
 * A service with its public endpoint switched off can only be reached over a private address. For Storage, SQL, Key Vault, Redis,
 * Cosmos DB, Container Registry and Service Bus that address comes from a Private Endpoint (a network interface in a subnet) plus a
 * private DNS zone. A design that turns the public endpoint off but has no endpoint cannot be reached by its own application, however
 * secure it looks. PostgreSQL and MySQL flexible servers are different: they are placed in a subnet instead of using an endpoint.
 *
 * One table drives the assessment rule, the AI spec repair that adds the missing endpoints, and the Terraform generator (which
 * sub-resource and DNS zone each target needs), so they cannot disagree.
 */

export interface PrivateLinkTarget {
  /** Private Link sub-resource name. */
  subresource: string | ((cfg: Record<string, unknown>) => string);
  /** Private DNS zone that resolves the service name to the endpoint's address. */
  dnsZone: string | ((cfg: Record<string, unknown>) => string);
  /** True when the service accepts connections from the internet (so it needs no endpoint to be reachable). */
  isPublic: (cfg: Record<string, unknown>) => boolean;
  /** The settings isPublic reads, so a rule can report "not enough data" for an imported resource that lacks them. */
  reads: string[];
  /** Tier the service must be on for a Private Endpoint to be possible (it is not offered on lower tiers). */
  requires?: { key: string; values: string[]; label: string };
  label: string;
}

export const PRIVATE_LINK_TARGETS: Record<string, PrivateLinkTarget> = {
  azure_sql: { label: 'Azure SQL', subresource: 'sqlServer', dnsZone: 'privatelink.database.windows.net', isPublic: (c) => c['publicNetworkAccess'] === true, reads: ['publicNetworkAccess'] },
  azure_storage: { label: 'Storage account', subresource: 'blob', dnsZone: 'privatelink.blob.core.windows.net', isPublic: (c) => c['networkDefaultAction'] !== 'Deny', reads: ['networkDefaultAction'] },
  azure_key_vault: { label: 'Key Vault', subresource: 'vault', dnsZone: 'privatelink.vaultcore.azure.net', isPublic: (c) => c['publicNetworkAccessEnabled'] === true && c['networkAclsDefaultAction'] === 'Allow', reads: ['publicNetworkAccessEnabled', 'networkAclsDefaultAction'] },
  azure_redis: { label: 'Azure Cache for Redis', subresource: 'redisCache', dnsZone: 'privatelink.redis.cache.windows.net', isPublic: (c) => c['publicNetworkAccessEnabled'] !== false, reads: ['publicNetworkAccessEnabled'] },
  azure_cosmos_db: {
    label: 'Cosmos DB',
    subresource: (c) => (c['kind'] === 'MongoDB' ? 'MongoDB' : 'Sql'),
    dnsZone: (c) => (c['kind'] === 'MongoDB' ? 'privatelink.mongo.cosmos.azure.com' : 'privatelink.documents.azure.com'),
    isPublic: (c) => c['publicNetworkAccess'] === true,
    reads: ['publicNetworkAccess'],
  },
  azure_acr: {
    label: 'Container Registry', subresource: 'registry', dnsZone: 'privatelink.azurecr.io', isPublic: (c) => c['publicNetworkAccess'] !== false, reads: ['publicNetworkAccess'],
    requires: { key: 'sku', values: ['Premium'], label: 'the Premium tier' },
  },
  azure_service_bus: {
    label: 'Service Bus', subresource: 'namespace', dnsZone: 'privatelink.servicebus.windows.net', isPublic: (c) => c['publicNetworkAccess'] !== false, reads: ['publicNetworkAccess'],
    requires: { key: 'sku', values: ['Premium'], label: 'the Premium tier' },
  },
};

/** Flexible servers are reached through the subnet they are placed in, not through an endpoint. */
export const SUBNET_INJECTED_TYPES = new Set(['azure_postgres', 'azure_mysql']);

const resolve = <T>(v: T | ((cfg: Record<string, unknown>) => T), cfg: Record<string, unknown>): T => (typeof v === 'function' ? (v as (c: Record<string, unknown>) => T)(cfg) : v);

export const subresourceFor = (type: string, cfg: Record<string, unknown>, chosen?: unknown): string | undefined => {
  const t = PRIVATE_LINK_TARGETS[type];
  if (!t) return undefined;
  const explicit = typeof chosen === 'string' && chosen !== 'auto' && type === 'azure_storage' ? chosen : undefined;
  return explicit ?? resolve(t.subresource, cfg);
};
export const dnsZoneFor = (type: string, cfg: Record<string, unknown>, chosen?: unknown): string | undefined => {
  const t = PRIVATE_LINK_TARGETS[type];
  if (!t) return undefined;
  if (type === 'azure_storage' && typeof chosen === 'string' && chosen !== 'auto') return `privatelink.${chosen}.core.windows.net`;
  return resolve(t.dnsZone, cfg);
};

/** True when the service has its public endpoint off, so something must give the application a private path to it. */
export function needsPrivateEndpoint(type: string, cfg: Record<string, unknown>): boolean {
  const t = PRIVATE_LINK_TARGETS[type];
  return !!t && !t.isPublic(cfg);
}

/** Nodes and edges in the shape the rule and the repair both have. */
interface N { id: string; resourceType: string; config?: Record<string, unknown> }
interface E { source: string; target: string }

/** Private endpoints attached to a service: every endpoint connected to it, whichever way the line was drawn. */
export function endpointsOf(targetId: string, nodes: N[], edges: E[]): N[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: N[] = [];
  for (const e of edges) {
    const other = e.source === targetId ? e.target : e.target === targetId ? e.source : null;
    const n = other ? byId.get(other) : undefined;
    if (n && n.resourceType === 'azure_private_endpoint') out.push(n);
  }
  return out;
}
