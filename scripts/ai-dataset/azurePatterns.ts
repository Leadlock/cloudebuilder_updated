/**
 * Azure blueprints, following the Azure Well-Architected Framework as implemented by
 * CloudCraft's rules: workloads in private subnets behind Application Gateway WAF (or
 * Front Door), data services with public network access disabled, zone redundancy,
 * NSGs on every tier, TLS 1.2 everywhere.
 */
import type { ArchitectureSpec } from '@/lib/ai/architectureSpec';
import { AZURE_REGIONS, SpecBuilder, azureCore, type AzureCore, type Cfg } from './builder';
import type { Requirements, Scale } from './requirements';

export const azureRegionOf = (id: string) => AZURE_REGIONS.find((r) => r.id === id) ?? AZURE_REGIONS[0];

interface AzureSizing {
  vmss: { sku: string; capacity: number; minCapacity: number; maxCapacity: number };
  sql: { tier: string; maxSizeGb: number };
  /** Flexible servers: sizes that support zone-redundant high availability (General Purpose or Memory Optimized). */
  pg: { skuName: string; storageGb: number };
  mysql: { skuName: string; storageGb: number };
  redis: { sku: string; family: string; capacity: number };
  appPlan: { skuName: string };
  aks: { nodeVmSize: string; nodeCount: number; minNodeCount: number; maxNodeCount: number };
  func: { planType: string };
}

export const AZURE_SIZING: Record<Scale, AzureSizing> = {
  small: {
    vmss: { sku: 'Standard_B2s', capacity: 2, minCapacity: 2, maxCapacity: 4 },
    sql: { tier: 'GeneralPurpose', maxSizeGb: 32 },
    pg: { skuName: 'GP_Standard_D2ds_v5', storageGb: 32 }, mysql: { skuName: 'GP_Standard_D2ds_v4', storageGb: 32 },
    redis: { sku: 'Standard', family: 'C', capacity: 1 },
    appPlan: { skuName: 'P1v3' },
    aks: { nodeVmSize: 'Standard_D2s_v3', nodeCount: 2, minNodeCount: 2, maxNodeCount: 4 },
    func: { planType: 'EP1' },
  },
  medium: {
    vmss: { sku: 'Standard_D2s_v3', capacity: 3, minCapacity: 3, maxCapacity: 10 },
    sql: { tier: 'GeneralPurpose', maxSizeGb: 128 },
    pg: { skuName: 'GP_Standard_D4ds_v5', storageGb: 128 }, mysql: { skuName: 'GP_Standard_D4ds_v4', storageGb: 128 },
    redis: { sku: 'Standard', family: 'C', capacity: 2 },
    appPlan: { skuName: 'P1v3' },
    aks: { nodeVmSize: 'Standard_D4s_v3', nodeCount: 3, minNodeCount: 3, maxNodeCount: 8 },
    func: { planType: 'EP1' },
  },
  large: {
    vmss: { sku: 'Standard_D4s_v5', capacity: 4, minCapacity: 4, maxCapacity: 20 },
    sql: { tier: 'BusinessCritical', maxSizeGb: 512 },
    pg: { skuName: 'MO_Standard_E4ds_v5', storageGb: 512 }, mysql: { skuName: 'MO_Standard_E2ds_v4', storageGb: 512 },
    redis: { sku: 'Premium', family: 'P', capacity: 1 },
    appPlan: { skuName: 'P2v3' },
    aks: { nodeVmSize: 'Standard_D4s_v5', nodeCount: 5, minNodeCount: 5, maxNodeCount: 15 },
    func: { planType: 'EP2' },
  },
};

export const cap = (s: string) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
export const slug = (s: string) => s.replace(/[^a-z0-9]/g, '');

/** A Private Endpoint in the data subnet for a service whose public endpoint is off. Without one the application could not reach it. */
export function privateEndpoint(b: SpecBuilder, core: AzureCore, target: string, label: string): void {
  const id = `pe-${target}`;
  b.add(id, 'azure_private_endpoint', `${label} Private Endpoint`, core.data, { name: `${slug(target)}-pe` });
  b.connect(id, target);
}

export interface AzureData { sql: string | null; cache: string | null; cosmos: string | null; bus: string | null }

export function azureData(b: SpecBuilder, r: Requirements, core: AzureCore): AzureData {
  let sql: string | null = null; let cache: string | null = null; let cosmos: string | null = null; let bus: string | null = null;
  const sz = AZURE_SIZING[r.scale];
  if (r.db === 'postgres' || r.db === 'mysql') {
    // A flexible server is placed in a subnet delegated to it, which can hold nothing else: it gets its own, protected by its own NSG.
    const dbSubnet = b.add('db-subnet', 'azure_subnet', 'Database Subnet', core.vnet, { addressPrefix: `10.${core.octet}.40.0/24` });
    nsg(b, core, 'nsg-db', 'Database NSG', dbSubnet, { allowHttp: false, allowHttps: false, sourceCidr: '10.0.0.0/8' });
    const pg = r.db === 'postgres';
    sql = b.add(pg ? 'postgres' : 'mysql', pg ? 'azure_postgres' : 'azure_mysql', pg ? 'Azure PostgreSQL' : 'Azure MySQL', dbSubnet, {
      name: `${slug(r.app)}-${pg ? 'pg' : 'mysql'}`, ...(pg ? sz.pg : sz.mysql), highAvailability: 'ZoneRedundant', publicNetworkAccess: false,
      requireSecureTransport: true, minimumTlsVersion: 'TLSv1.2', geoRedundantBackup: r.regulated,
    });
  }
  if (r.db === 'sql') {
    sql = b.add('sql', 'azure_sql', 'Azure SQL Database', core.data, {
      name: `${slug(r.app)}-sql`, tier: sz.sql.tier, maxSizeGb: sz.sql.maxSizeGb, zoneRedundant: true, publicNetworkAccess: false,
      allowAzureServices: false, minimumTlsVersion: '1.2', auditingEnabled: true, threatDetectionEnabled: true, requestedBackupStorageRedundancy: r.regulated ? 'GeoZone' : 'Zone',
    });
    privateEndpoint(b, core, sql, 'Azure SQL');
  }
  if (r.db === 'nosql') {
    cosmos = b.add('cosmos', 'azure_cosmos_db', 'Cosmos DB Account', undefined, {
      name: `${slug(r.app)}-cosmos`, throughputMode: 'Serverless', publicNetworkAccess: false, backupType: 'Continuous',
    });
    privateEndpoint(b, core, cosmos, 'Cosmos DB');
  }
  if (r.cache) {
    cache = b.add('redis', 'azure_redis', 'Redis Cache', core.data, {
      name: `${slug(r.app)}-redis`, ...sz.redis, enableNonSslPort: false, publicNetworkAccessEnabled: false, minimumTlsVersion: '1.2',
    });
    privateEndpoint(b, core, cache, 'Redis');
  }
  if (r.queue) {
    // Standard tier: private access needs Premium (about $677 a month per unit), so the queue stays on its public endpoint with TLS 1.2.
    bus = b.add('bus', 'azure_service_bus', 'Job Queue (Service Bus)', core.boundary, { name: `${slug(r.app)}-bus`, sku: 'Standard', queueNames: 'jobs', minimumTlsVersion: '1.2' });
  }
  return { sql, cache, cosmos, bus };
}

export function storageAndVault(b: SpecBuilder, r: Requirements, core: AzureCore): { storage: string; vault: string } {
  const storage = b.add('storage', 'azure_storage', 'Assets Storage Account', core.rg, {
    name: `${slug(r.app)}assets`, sku: r.regulated ? 'Standard_GRS' : 'Standard_ZRS', httpsOnly: true, allowBlobPublicAccess: false,
    minimumTlsVersion: 'TLS1_2', networkDefaultAction: 'Deny', blobVersioningEnabled: true, blobSoftDeleteRetentionDays: 14,
  });
  const vault = b.add('vault', 'azure_key_vault', 'Key Vault', core.rg, {
    name: `${slug(r.app)}-kv`, sku: r.regulated ? 'premium' : 'standard', enableRbacAuthorization: true, publicNetworkAccessEnabled: false,
    networkAclsDefaultAction: 'Deny', purgeProtectionEnabled: true, softDeleteRetentionDays: 90,
  });
  privateEndpoint(b, core, storage, 'Storage');
  privateEndpoint(b, core, vault, 'Key Vault');
  return { storage, vault };
}

/** NSG protecting a subnet (association is a diagram connection) and the workload inside it. */
export function nsg(b: SpecBuilder, core: AzureCore, id: string, label: string, subnet: string, cfg?: Cfg): void {
  b.add(id, 'azure_nsg', label, core.vnet, cfg);
  b.connect(id, subnet);
}

export function summary(r: Requirements, region: string, lead: string): string {
  const bits: string[] = [lead];
  bits.push(`Sized for the ${r.scale} tier and deployed in ${region} with zone-redundant data services.`);
  if (r.regulated) bits.push('Regulated-workload posture: geo-zone-redundant backups, premium Key Vault and Web Application Firewall in Prevention mode.');
  return bits.join(' ');
}

function frontDoor(b: SpecBuilder, r: Requirements, core: AzureCore, origin: string): void {
  const fd = b.add('fd', 'azure_front_door', 'Front Door', core.boundary, {
    name: `${slug(r.app)}-fd`, sku: r.regulated ? 'Premium_AzureFrontDoor' : 'Standard_AzureFrontDoor', httpsOnly: true, originHostName: `${slug(r.app)}.example.com`,
  });
  const waf = b.add('fd-waf', 'azure_waf', 'Front Door WAF Policy', core.boundary, { name: `${slug(r.app)}fdwaf`, mode: 'Prevention' });
  b.connect(waf, fd); b.connect(fd, origin);
}

export function azureThreeTier(r: Requirements): ArchitectureSpec {
  const region = azureRegionOf(r.region);
  const b = new SpecBuilder();
  const core = azureCore(b, { region, tiers: { bastion: r.regulated } });
  const sz = AZURE_SIZING[r.scale];
  const agw = b.add('agw', 'azure_app_gateway', 'Application Gateway (WAF v2)', core.web, {
    name: `${slug(r.app)}-agw`, sku: 'WAF_v2', wafEnabled: true, wafMode: 'Prevention', zones: '1,2,3', autoscaleEnabled: true, minCapacity: 2, maxCapacity: r.scale === 'large' ? 10 : 5,
  });
  // Three tiers: web (presentation), API (business logic) and data. Each compute tier is its own scale set, spread over three zones.
  const vmss = b.add('vmss', 'azure_vmss', 'Web VM Scale Set', core.app, {
    name: `${slug(r.app)}-web`, ...sz.vmss, zones: '1,2,3', autoscaleEnabled: true, upgradeMode: 'Rolling', osDiskEncryption: true,
  });
  const api = b.add('api', 'azure_vmss', 'API VM Scale Set', core.app, {
    name: `${slug(r.app)}-api`, ...sz.vmss, zones: '1,2,3', autoscaleEnabled: true, upgradeMode: 'Rolling', osDiskEncryption: true,
  });
  b.connect(agw, vmss);
  b.connect(vmss, api);
  if (r.cdn) frontDoor(b, r, core, agw);
  const data = azureData(b, r, core);
  const { storage, vault } = storageAndVault(b, r, core);
  for (const d of [data.sql, data.cache, data.cosmos, data.bus]) if (d) b.connect(api, d);
  b.connect(api, storage); b.connect(api, vault);
  nsg(b, core, 'nsg-web', 'Web NSG', core.web, { allowHttp: false, allowHttps: true });
  nsg(b, core, 'nsg-app', 'App NSG', core.app, { allowHttp: true, allowHttps: false, sourceCidr: '10.0.0.0/8' });
  nsg(b, core, 'nsg-data', 'Data NSG', core.data, { allowHttp: false, allowHttps: false, sourceCidr: '10.0.0.0/8' });
  if (r.regulated) { nsg(b, core, 'nsg-bastion', 'Bastion NSG', core.bastionSubnet, { allowHttps: true }); }
  if (r.regulated) {
    const bastion = b.add('bastion', 'azure_bastion', 'Azure Bastion', core.vnet, { name: `${slug(r.app)}-bastion`, sku: 'Standard' });
    b.connect(bastion, vmss); b.connect(bastion, api);
  }
  return b.build(`${cap(r.app)} on Azure — three-tier web application`, summary(r, region.id, 'A WAF-enabled Application Gateway distributes traffic to web and API VM Scale Sets spread over three zones in a private app subnet; data services reject public network access.'));
}

export function azureAppService(r: Requirements): ArchitectureSpec {
  const region = azureRegionOf(r.region);
  const b = new SpecBuilder();
  const core = azureCore(b, { region, tiers: { web: false, app: false, bastion: false } });
  const sz = AZURE_SIZING[r.scale];
  const app = b.add('app', 'azure_app_service', 'Web App', undefined, {
    name: `${slug(r.app)}-web`, skuName: sz.appPlan.skuName, alwaysOn: true, httpsOnly: true, minimumTlsVersion: '1.2', ftpsState: 'Disabled', http2Enabled: true, healthCheckPath: '/health',
    publicNetworkAccess: !r.cdn,
  });
  if (r.cdn) frontDoor(b, r, core, app);
  const data = azureData(b, r, core);
  const { storage, vault } = storageAndVault(b, r, core);
  for (const d of [data.sql, data.cache, data.cosmos, data.bus]) if (d) b.connect(app, d);
  b.connect(app, storage); b.connect(app, vault);
  nsg(b, core, 'nsg-data', 'Data NSG', core.data, { allowHttp: false, allowHttps: false, sourceCidr: '10.0.0.0/8' });
  return b.build(`${cap(r.app)} on Azure — App Service web application`, summary(r, region.id, 'App Service serves the application behind Front Door with a WAF policy; data services accept private traffic only.'));
}

export function azureServerless(r: Requirements): ArchitectureSpec {
  const region = azureRegionOf(r.region);
  const b = new SpecBuilder();
  const core = azureCore(b, { region, tiers: { web: false, app: false, bastion: false } });
  const sz = AZURE_SIZING[r.scale];
  const fn = b.add('func', 'azure_functions', 'API Function App', undefined, {
    name: `${slug(r.app)}-api`, runtime: 'node', osType: 'Linux', planType: sz.func.planType, alwaysOn: true, httpsOnly: true, minimumTlsVersion: '1.2', publicNetworkAccess: !r.cdn,
  });
  if (r.cdn) frontDoor(b, r, core, fn);
  const cosmos = b.add('cosmos', 'azure_cosmos_db', 'Cosmos DB Account', undefined, {
    name: `${slug(r.app)}-cosmos`, throughputMode: 'Serverless', publicNetworkAccess: false, backupType: 'Continuous',
  });
  privateEndpoint(b, core, cosmos, 'Cosmos DB');
  const { storage, vault } = storageAndVault(b, r, core);
  b.connect(fn, cosmos); b.connect(fn, storage); b.connect(fn, vault);
  nsg(b, core, 'nsg-data', 'Data NSG', core.data, { allowHttp: false, allowHttps: false, sourceCidr: '10.0.0.0/8' });
  return b.build(`${cap(r.app)} on Azure — serverless API on Azure Functions`, summary(r, region.id, 'Azure Functions handles requests behind Front Door and WAF, persisting state in Cosmos DB with continuous backup.'));
}

export function azureAks(r: Requirements): ArchitectureSpec {
  const region = azureRegionOf(r.region);
  const b = new SpecBuilder();
  const core = azureCore(b, { region, tiers: { bastion: false } });
  const sz = AZURE_SIZING[r.scale];
  const agw = b.add('agw', 'azure_app_gateway', 'Ingress Application Gateway (WAF v2)', core.web, {
    name: `${slug(r.app)}-agw`, sku: 'WAF_v2', wafEnabled: true, wafMode: 'Prevention', zones: '1,2,3', autoscaleEnabled: true, minCapacity: 2, maxCapacity: r.scale === 'large' ? 10 : 5,
  });
  const aks = b.add('aks', 'azure_aks', 'AKS Cluster', core.app, {
    name: `${slug(r.app)}-aks`, dnsPrefix: slug(r.app), ...sz.aks, enableAutoScaling: true, skuTier: 'Standard', privateClusterEnabled: true, networkPlugin: 'azure', rbacEnabled: true,
  });
  b.connect(agw, aks);
  if (r.cdn) frontDoor(b, r, core, agw);
  const data = azureData(b, r, core);
  const { storage, vault } = storageAndVault(b, r, core);
  for (const d of [data.sql, data.cache, data.cosmos, data.bus]) if (d) b.connect(aks, d);
  b.connect(aks, storage); b.connect(aks, vault);
  nsg(b, core, 'nsg-web', 'Web NSG', core.web, { allowHttp: false, allowHttps: true });
  nsg(b, core, 'nsg-app', 'App NSG', core.app, { allowHttp: true, allowHttps: false, sourceCidr: '10.0.0.0/8' });
  nsg(b, core, 'nsg-data', 'Data NSG', core.data, { allowHttp: false, allowHttps: false, sourceCidr: '10.0.0.0/8' });
  return b.build(`${cap(r.app)} on Azure — Kubernetes on AKS`, summary(r, region.id, 'A private AKS cluster with RBAC and autoscaling sits behind a WAF-enabled Application Gateway; data services accept private traffic only.'));
}
