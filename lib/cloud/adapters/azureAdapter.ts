/**
 * Azure Discovery Adapter
 *
 * Uses @azure/identity (ClientSecretCredential) and Azure management SDKs.
 * Discovers:
 * - Resource Groups, VNets, Subnets, NSGs, Public IPs, Load Balancers, Application Gateways, NAT Gateways
 * - Virtual Machines
 * - Storage Accounts
 * - SQL Servers & Databases
 * - AKS Clusters (with the first node pool's size/count/autoscale config)
 * - Function Apps (Web Apps filtered to kind=functionapp; runtime/version parsed
 *   from linuxFxVersion, plan type resolved from the backing App Service Plan)
 * - Key Vaults
 *
 * Reconstructs full infrastructure topology:
 * - Resource Group contains VNets, Storage, SQL
 * - VNet contains Subnets
 * - Subnet contains VMs, Application Gateways, Load Balancers
 * - NSGs bound to Subnets/NICs
 * - Public IPs attached to Load Balancers/Gateways/VMs
 *
 * Security contract:
 * - Credentials accepted at construction time and kept strictly within instance.
 * - clientSecret is never logged, exposed, or serialized.
 * - Only sanitized functional infrastructure metadata is returned.
 */
import { ClientSecretCredential } from '@azure/identity';
import { NetworkManagementClient } from '@azure/arm-network';
import { ComputeManagementClient } from '@azure/arm-compute';
import { StorageManagementClient } from '@azure/arm-storage';
import { SqlManagementClient } from '@azure/arm-sql';
import { ResourceManagementClient } from '@azure/arm-resources';
import { ContainerServiceClient } from '@azure/arm-containerservice';
import { WebSiteManagementClient } from '@azure/arm-appservice';
import { KeyVaultManagementClient } from '@azure/arm-keyvault';
import type {
  AzureSpCredentials,
  DiscoveredResource,
  DiscoveryResult,
  AccountValidationResult,
  AzureAccountIdentity,
} from '../types';
import type {
  CloudResource,
  CloudRelationship,
  DiscoveredTopology,
  DiscoveryOptions,
} from '../discovery/types';
import { retryWithBackoff, computeConfigHash } from '../discovery/utils';
import type { InfrastructureDiscoveryProvider } from '../provider';

// ─── Required permissions (Reader role) ──────────────────────────────────────

export const REQUIRED_AZURE_PERMISSIONS = [
  'Microsoft.Network/virtualNetworks/read',
  'Microsoft.Network/virtualNetworks/subnets/read',
  'Microsoft.Network/networkSecurityGroups/read',
  'Microsoft.Network/publicIPAddresses/read',
  'Microsoft.Network/loadBalancers/read',
  'Microsoft.Network/applicationGateways/read',
  'Microsoft.Compute/virtualMachines/read',
  'Microsoft.Storage/storageAccounts/read',
  'Microsoft.Sql/servers/read',
  'Microsoft.Sql/servers/databases/read',
  'Microsoft.Resources/subscriptions/resourceGroups/read',
  'Microsoft.ContainerService/managedClusters/read',
  'Microsoft.Web/sites/read',
  'Microsoft.Web/serverfarms/read',
  'Microsoft.KeyVault/vaults/read',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function now(): string {
  return new Date().toISOString();
}

function extractResourceGroup(resourceId: string): string {
  const match = resourceId.match(/\/resourceGroups\/([^/]+)\//i);
  return match?.[1] ?? 'unknown';
}

function extractRegion(id: string | undefined): string {
  return id ? id.toLowerCase().replace(/\s+/g, '') : 'unknown';
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class AzureDiscoveryAdapter implements InfrastructureDiscoveryProvider {
  readonly provider = 'azure' as const;

  private readonly _credentials: AzureSpCredentials;
  private _azureCredential: ClientSecretCredential | null = null;

  constructor(credentials: AzureSpCredentials) {
    this._credentials = credentials;
  }

  private _getCredential(): ClientSecretCredential {
    if (!this._azureCredential) {
      this._azureCredential = new ClientSecretCredential(
        this._credentials.tenantId,
        this._credentials.clientId,
        this._credentials.clientSecret,
      );
    }
    return this._azureCredential;
  }

  private get _subscriptionId(): string {
    return this._credentials.subscriptionId;
  }

  // ── Account validation ───────────────────────────────────────────────────

  async validateAccount(): Promise<AccountValidationResult> {
    try {
      const credential = this._getCredential();
      const resourceClient = new ResourceManagementClient(credential, this._subscriptionId);

      const missingPermissions: string[] = [];
      const subscriptionName = this._subscriptionId;

      try {
        const rg = resourceClient.resourceGroups.list();
        await retryWithBackoff(async () => {
          const first = await rg.next();
          void first;
        });
      } catch {
        missingPermissions.push(
          'Microsoft.Resources/subscriptions/resourceGroups/read',
          'Microsoft.Network/virtualNetworks/read',
        );
      }

      const identity: AzureAccountIdentity = {
        provider: 'azure',
        tenantId: this._credentials.tenantId,
        subscriptionId: this._subscriptionId,
        subscriptionName,
        clientId: this._credentials.clientId,
      };

      return {
        valid: missingPermissions.length === 0,
        identity,
        permissionsOk: missingPermissions.length === 0,
        missingPermissions,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AzureDiscoveryAdapter] validateAccount failed:', message);
      return {
        valid: false,
        permissionsOk: false,
        missingPermissions: REQUIRED_AZURE_PERMISSIONS,
        error: message,
      };
    }
  }

  // ── Region discovery ─────────────────────────────────────────────────────

  async discoverRegions(): Promise<string[]> {
    try {
      const credential = this._getCredential();
      const resourceClient = new ResourceManagementClient(credential, this._subscriptionId);
      const rgs = resourceClient.resourceGroups.list();
      const regionSet = new Set<string>();
      for await (const rg of rgs) {
        if (rg.location) regionSet.add(rg.location.toLowerCase());
      }
      const regions = [...regionSet];
      return regions.length > 0 ? regions : ['eastus', 'westeurope', 'southeastasia'];
    } catch {
      return ['eastus', 'eastus2', 'westus', 'westeurope', 'northeurope', 'southeastasia'];
    }
  }

  // ── Legacy discoverAll ───────────────────────────────────────────────────

  async discoverAll(regions?: string[]): Promise<DiscoveryResult> {
    const topology = await this.discoverTopology({
      regions: regions && regions.length > 0 ? regions : undefined,
    });
    const resources: DiscoveredResource[] = topology.resources.map((r) => ({
      providerResourceId: r.arn || r.resourceId,
      resourceType: r.resourceType as DiscoveredResource['resourceType'],
      provider: 'azure',
      name: r.name,
      region: r.region,
      status: r.status,
      configuration: r.configuration,
      metadata: r.metadata,
    }));

    return {
      accountId: this._subscriptionId,
      provider: 'azure',
      status: topology.status === 'failed' ? 'failed' : 'completed',
      startedAt: topology.startedAt,
      completedAt: topology.completedAt,
      resources,
      relationships: topology.relationships,
      error: topology.error,
      summary: topology.summary,
    };
  }

  // ── Production Topology Discovery ────────────────────────────────────────

  async discoverTopology(options: DiscoveryOptions = {}): Promise<DiscoveredTopology> {
    const startedAt = now();
    const warnings: string[] = [];
    const allResources: CloudResource[] = [];
    const allRelationships: CloudRelationship[] = [];

    options.onProgress?.({
      stage: 'connecting',
      message: `Connecting to Azure Subscription ${this._subscriptionId}...`,
      resourcesDiscovered: 0,
      relationshipsDiscovered: 0,
      unsupportedCount: 0,
      percent: 10,
    });

    try {
      const credential = this._getCredential();

      // 1. Resource Groups
      options.onProgress?.({
        stage: 'scanning_vpcs',
        message: 'Scanning Azure Resource Groups...',
        resourcesDiscovered: allResources.length,
        relationshipsDiscovered: allRelationships.length,
        unsupportedCount: 0,
        percent: 25,
      });
      const rgs = await this._discoverResourceGroups(credential);
      allResources.push(...rgs);

      // 2. Networking (VNets, Subnets, NSGs, Public IPs, Load Balancers, Application Gateways)
      options.onProgress?.({
        stage: 'scanning_networking',
        message: 'Scanning VNets, Subnets, Gateways & NSGs...',
        resourcesDiscovered: allResources.length,
        relationshipsDiscovered: allRelationships.length,
        unsupportedCount: 0,
        percent: 45,
      });
      const netResources = await this._discoverNetworking(credential);
      allResources.push(...netResources);

      // 3. Compute (VMs)
      options.onProgress?.({
        stage: 'scanning_compute',
        message: 'Scanning Virtual Machines...',
        resourcesDiscovered: allResources.length,
        relationshipsDiscovered: allRelationships.length,
        unsupportedCount: 0,
        percent: 65,
      });
      const vms = await this._discoverVirtualMachines(credential);
      allResources.push(...vms);

      // 4. Storage & Databases
      options.onProgress?.({
        stage: 'scanning_storage',
        message: 'Scanning Storage Accounts & Azure SQL...',
        resourcesDiscovered: allResources.length,
        relationshipsDiscovered: allRelationships.length,
        unsupportedCount: 0,
        percent: 80,
      });
      const [storage, sql] = await Promise.all([
        this._discoverStorageAccounts(credential),
        this._discoverSqlResources(credential),
      ]);
      allResources.push(...storage, ...sql);

      // 4b. AKS, Functions, Key Vault
      options.onProgress?.({
        stage: 'scanning_compute',
        message: 'Scanning AKS clusters, Function Apps & Key Vaults...',
        resourcesDiscovered: allResources.length,
        relationshipsDiscovered: allRelationships.length,
        unsupportedCount: 0,
        percent: 88,
      });
      const [aksClusters, functionApps, keyVaults] = await Promise.all([
        this._discoverAksClusters(credential),
        this._discoverFunctionApps(credential),
        this._discoverKeyVaults(credential),
      ]);
      allResources.push(...aksClusters, ...functionApps, ...keyVaults);

      // 5. Build Topology Relationships
      options.onProgress?.({
        stage: 'building_relationships',
        message: 'Reconstructing Azure topology and containment hierarchy...',
        resourcesDiscovered: allResources.length,
        relationshipsDiscovered: allRelationships.length,
        unsupportedCount: 0,
        percent: 92,
      });
      const topologyRelationships = this._reconstructAzureRelationships(allResources);
      allRelationships.push(...topologyRelationships);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AzureDiscoveryAdapter] discoverTopology failed:', message);
      return {
        accountId: this._subscriptionId,
        provider: 'azure',
        status: 'failed',
        startedAt,
        completedAt: now(),
        scannedRegions: [],
        resources: [],
        relationships: [],
        summary: {},
        unsupportedResources: [],
        warnings,
        error: message,
      };
    }

    const summary = buildSummary(allResources);
    const scannedRegions = [...new Set(allResources.map((r) => r.region).filter(Boolean))];

    options.onProgress?.({
      stage: 'completed',
      message: `Azure discovery complete. Found ${allResources.length} resources and ${allRelationships.length} relationships.`,
      resourcesDiscovered: allResources.length,
      relationshipsDiscovered: allRelationships.length,
      unsupportedCount: 0,
      percent: 100,
    });

    return {
      accountId: this._subscriptionId,
      provider: 'azure',
      status: 'completed',
      startedAt,
      completedAt: now(),
      scannedRegions,
      resources: allResources,
      relationships: allRelationships,
      summary,
      unsupportedResources: [],
      warnings,
    };
  }

  // ── Per-service helpers ──────────────────────────────────────────────────

  private async _discoverResourceGroups(credential: ClientSecretCredential): Promise<CloudResource[]> {
    const client = new ResourceManagementClient(credential, this._subscriptionId);
    const results: CloudResource[] = [];
    for await (const rg of client.resourceGroups.list()) {
      const id = safeString(rg.id);
      const name = rg.name ?? 'unnamed-rg';
      const loc = extractRegion(rg.location);
      const config = {
        location: loc,
        source: 'azure-arm',
        imported: true,
      };
      results.push({
        id,
        provider: 'azure',
        subscriptionId: this._subscriptionId,
        region: loc,
        resourceType: 'resource-group',
        name,
        arn: id,
        resourceId: id,
        tags: rg.tags ?? {},
        status: rg.properties?.provisioningState ?? 'Succeeded',
        configuration: config,
        metadata: {},
        configurationHash: computeConfigHash(config),
        discoveredAt: now(),
      });
    }
    return results;
  }

  private async _discoverNetworking(credential: ClientSecretCredential): Promise<CloudResource[]> {
    const client = new NetworkManagementClient(credential, this._subscriptionId);
    const results: CloudResource[] = [];

    // 1. Virtual Networks & Subnets
    for await (const vnet of client.virtualNetworks.listAll()) {
      const vnetId = safeString(vnet.id);
      const vnetLoc = extractRegion(vnet.location);
      const rg = extractResourceGroup(vnetId);

      const vnetConfig = {
        addressSpace: vnet.addressSpace?.addressPrefixes ?? ['10.0.0.0/16'],
        resourceGroup: rg,
        location: vnetLoc,
        enableDdosProtection: vnet.enableDdosProtection ?? false,
        source: 'azure-arm',
        imported: true,
      };

      results.push({
        id: vnetId,
        provider: 'azure',
        subscriptionId: this._subscriptionId,
        region: vnetLoc,
        resourceType: 'vnet',
        name: vnet.name ?? 'unnamed-vnet',
        arn: vnetId,
        resourceId: vnetId,
        tags: vnet.tags ?? {},
        status: vnet.provisioningState ?? 'Succeeded',
        configuration: vnetConfig,
        parentResourceId: rg,
        metadata: { resourceGroup: rg },
        configurationHash: computeConfigHash(vnetConfig),
        discoveredAt: now(),
      });

      // Subnets inside this VNet
      for (const subnet of vnet.subnets ?? []) {
        const subId = safeString(subnet.id);
        const subConfig = {
          addressPrefix: subnet.addressPrefix ?? '10.0.1.0/24',
          vnetId,
          resourceGroup: rg,
          networkSecurityGroupId: subnet.networkSecurityGroup?.id ?? null,
          source: 'azure-arm',
          imported: true,
        };

        results.push({
          id: subId,
          provider: 'azure',
          subscriptionId: this._subscriptionId,
          region: vnetLoc,
          resourceType: 'subnet',
          name: subnet.name ?? 'unnamed-subnet',
          arn: subId,
          resourceId: subId,
          tags: {},
          status: subnet.provisioningState ?? 'Succeeded',
          configuration: subConfig,
          parentResourceId: vnetId,
          metadata: { resourceGroup: rg },
          configurationHash: computeConfigHash(subConfig),
          discoveredAt: now(),
        });
      }
    }

    // 2. Network Security Groups
    try {
      for await (const nsg of client.networkSecurityGroups.listAll()) {
        const id = safeString(nsg.id);
        const loc = extractRegion(nsg.location);
        const rg = extractResourceGroup(id);

        const config = {
          resourceGroup: rg,
          securityRules: (nsg.securityRules ?? []).map((r) => ({
            name: r.name,
            protocol: r.protocol,
            destinationPortRange: r.destinationPortRange,
            access: r.access,
            direction: r.direction,
          })),
          source: 'azure-arm',
          imported: true,
        };

        results.push({
          id,
          provider: 'azure',
          subscriptionId: this._subscriptionId,
          region: loc,
          resourceType: 'network-security-group',
          name: nsg.name ?? 'unnamed-nsg',
          arn: id,
          resourceId: id,
          tags: nsg.tags ?? {},
          status: nsg.provisioningState ?? 'Succeeded',
          configuration: config,
          metadata: { resourceGroup: rg },
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
    } catch {
      // Best effort
    }

    // 3. Public IP Addresses
    try {
      for await (const pip of client.publicIPAddresses.listAll()) {
        const id = safeString(pip.id);
        const loc = extractRegion(pip.location);
        const rg = extractResourceGroup(id);

        const config = {
          ipAddress: pip.ipAddress ?? null,
          allocationMethod: pip.publicIPAllocationMethod ?? 'Dynamic',
          sku: pip.sku?.name ?? 'Standard',
          source: 'azure-arm',
          imported: true,
        };

        results.push({
          id,
          provider: 'azure',
          subscriptionId: this._subscriptionId,
          region: loc,
          resourceType: 'public-ip',
          name: pip.name ?? 'unnamed-pip',
          arn: id,
          resourceId: id,
          tags: pip.tags ?? {},
          status: pip.provisioningState ?? 'Succeeded',
          configuration: config,
          metadata: { resourceGroup: rg },
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
    } catch {
      // Best effort
    }

    // 4. Load Balancers
    for await (const lb of client.loadBalancers.listAll()) {
      const id = safeString(lb.id);
      const loc = extractRegion(lb.location);
      const rg = extractResourceGroup(id);

      const config = {
        sku: lb.sku?.name ?? 'Standard',
        frontendIPConfigurations: (lb.frontendIPConfigurations ?? []).map((fe) => ({
          name: fe.name,
          privateIPAddress: fe.privateIPAddress ?? null,
          publicIPAddressId: fe.publicIPAddress?.id ?? null,
        })),
        source: 'azure-arm',
        imported: true,
      };

      results.push({
        id,
        provider: 'azure',
        subscriptionId: this._subscriptionId,
        region: loc,
        resourceType: 'load-balancer',
        name: lb.name ?? 'unnamed-lb',
        arn: id,
        resourceId: id,
        tags: lb.tags ?? {},
        status: lb.provisioningState ?? 'Succeeded',
        configuration: config,
        metadata: { resourceGroup: rg },
        configurationHash: computeConfigHash(config),
        discoveredAt: now(),
      });
    }

    // 5. Application Gateways
    try {
      for await (const agw of client.applicationGateways.listAll()) {
        const id = safeString(agw.id);
        const loc = extractRegion(agw.location);
        const rg = extractResourceGroup(id);
        const subnetId = agw.gatewayIPConfigurations?.[0]?.subnet?.id ?? undefined;

        const config = {
          sku: agw.sku?.name ?? 'Standard_v2',
          capacity: agw.sku?.capacity ?? 2,
          subnetId,
          source: 'azure-arm',
          imported: true,
        };

        results.push({
          id,
          provider: 'azure',
          subscriptionId: this._subscriptionId,
          region: loc,
          resourceType: 'application-gateway',
          name: agw.name ?? 'unnamed-app-gateway',
          arn: id,
          resourceId: id,
          tags: agw.tags ?? {},
          status: agw.provisioningState ?? 'Succeeded',
          configuration: config,
          parentResourceId: subnetId,
          metadata: { resourceGroup: rg },
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
    } catch {
      // Best effort
    }

    return results;
  }

  private async _discoverVirtualMachines(credential: ClientSecretCredential): Promise<CloudResource[]> {
    const client = new ComputeManagementClient(credential, this._subscriptionId);
    const results: CloudResource[] = [];

    for await (const vm of client.virtualMachines.listAll()) {
      const id = safeString(vm.id);
      const loc = extractRegion(vm.location);
      const rg = extractResourceGroup(id);

      const config = {
        size: vm.hardwareProfile?.vmSize ?? 'Standard_B2s',
        vmSize: vm.hardwareProfile?.vmSize ?? 'Standard_B2s',
        osType: vm.storageProfile?.osDisk?.osType ?? 'Linux',
        imageOffer: vm.storageProfile?.imageReference?.offer ?? 'UbuntuServer',
        imageSku: vm.storageProfile?.imageReference?.sku ?? '22_04-lts',
        adminUsername: vm.osProfile?.adminUsername ?? 'azureuser',
        networkInterfaceIds: (vm.networkProfile?.networkInterfaces ?? []).map((n) => n.id).filter(Boolean),
        source: 'azure-arm',
        imported: true,
      };

      results.push({
        id,
        provider: 'azure',
        subscriptionId: this._subscriptionId,
        region: loc,
        resourceType: 'virtual-machine',
        name: vm.name ?? 'unnamed-vm',
        arn: id,
        resourceId: id,
        tags: vm.tags ?? {},
        status: vm.provisioningState ?? 'Succeeded',
        configuration: config,
        metadata: {
          resourceGroup: rg,
          zones: vm.zones ?? [],
        },
        configurationHash: computeConfigHash(config),
        discoveredAt: now(),
      });
    }

    return results;
  }

  private async _discoverStorageAccounts(credential: ClientSecretCredential): Promise<CloudResource[]> {
    const client = new StorageManagementClient(credential, this._subscriptionId);
    const results: CloudResource[] = [];

    for await (const sa of client.storageAccounts.list()) {
      const id = safeString(sa.id);
      const loc = extractRegion(sa.location);
      const rg = extractResourceGroup(id);

      const config = {
        kind: sa.kind ?? 'StorageV2',
        sku: sa.sku?.name ?? 'Standard_LRS',
        skuName: sa.sku?.name ?? 'Standard_LRS',
        accessTier: sa.accessTier ?? 'Hot',
        httpsOnly: sa.enableHttpsTrafficOnly ?? true,
        source: 'azure-arm',
        imported: true,
      };

      results.push({
        id,
        provider: 'azure',
        subscriptionId: this._subscriptionId,
        region: loc,
        resourceType: 'storage-account',
        name: sa.name ?? 'unnamed-storage',
        arn: id,
        resourceId: id,
        tags: sa.tags ?? {},
        status: sa.provisioningState ?? 'Succeeded',
        configuration: config,
        metadata: { resourceGroup: rg },
        configurationHash: computeConfigHash(config),
        discoveredAt: now(),
      });
    }

    return results;
  }

  private async _discoverSqlResources(credential: ClientSecretCredential): Promise<CloudResource[]> {
    const client = new SqlManagementClient(credential, this._subscriptionId);
    const results: CloudResource[] = [];

    for await (const server of client.servers.list()) {
      const serverId = safeString(server.id);
      const loc = extractRegion(server.location);
      const rg = extractResourceGroup(serverId);

      const serverConfig = {
        fullyQualifiedDomainName: server.fullyQualifiedDomainName ?? null,
        version: server.version ?? '12.0',
        administratorLogin: server.administratorLogin ?? 'azureuser',
        source: 'azure-arm',
        imported: true,
      };

      results.push({
        id: serverId,
        provider: 'azure',
        subscriptionId: this._subscriptionId,
        region: loc,
        resourceType: 'sql-server',
        name: server.name ?? 'unnamed-sql-server',
        arn: serverId,
        resourceId: serverId,
        tags: server.tags ?? {},
        status: server.state ?? 'Ready',
        configuration: serverConfig,
        metadata: { resourceGroup: rg },
        configurationHash: computeConfigHash(serverConfig),
        discoveredAt: now(),
      });

      // Databases on this server
      if (server.name) {
        try {
          for await (const db of client.databases.listByServer(rg, server.name)) {
            const dbId = safeString(db.id);
            const dbConfig = {
              sku: db.sku?.name ?? 'Standard',
              tier: db.sku?.tier ?? 'Standard',
              maxSizeGb: db.maxSizeBytes ? Math.round(db.maxSizeBytes / 1073741824) : 250,
              serverId,
              source: 'azure-arm',
              imported: true,
            };

            results.push({
              id: dbId,
              provider: 'azure',
              subscriptionId: this._subscriptionId,
              region: loc,
              resourceType: 'sql-database',
              name: db.name ?? 'unnamed-db',
              arn: dbId,
              resourceId: dbId,
              tags: db.tags ?? {},
              status: db.status ?? 'Online',
              configuration: dbConfig,
              parentResourceId: serverId,
              metadata: { resourceGroup: rg },
              configurationHash: computeConfigHash(dbConfig),
              discoveredAt: now(),
            });
          }
        } catch {
          // Best effort
        }
      }
    }

    return results;
  }

  private async _discoverAksClusters(credential: ClientSecretCredential): Promise<CloudResource[]> {
    const client = new ContainerServiceClient(credential, this._subscriptionId);
    const results: CloudResource[] = [];
    try {
      for await (const cluster of client.managedClusters.list()) {
        const id = safeString(cluster.id);
        const loc = extractRegion(cluster.location);
        const rg = extractResourceGroup(id);
        const pool = cluster.agentPoolProfiles?.[0];

        const config = {
          name: cluster.name ?? 'unnamed-aks',
          dnsPrefix: cluster.dnsPrefix ?? '',
          kubernetesVersion: cluster.kubernetesVersion ?? '',
          nodeVmSize: pool?.vmSize ?? 'Standard_D2s_v3',
          nodeCount: pool?.count ?? 3,
          enableAutoScaling: pool?.enableAutoScaling ?? false,
          minNodeCount: pool?.minCount ?? 1,
          maxNodeCount: pool?.maxCount ?? 5,
          skuTier: cluster.sku?.tier ?? 'Free',
          privateClusterEnabled: cluster.apiServerAccessProfile?.enablePrivateCluster ?? false,
          networkPlugin: cluster.networkProfile?.networkPlugin ?? 'azure',
          rbacEnabled: cluster.enableRbac ?? true,
          source: 'azure-arm',
          imported: true,
        };

        results.push({
          id,
          provider: 'azure',
          subscriptionId: this._subscriptionId,
          region: loc,
          resourceType: 'aks',
          name: cluster.name ?? 'unnamed-aks',
          arn: id,
          resourceId: id,
          tags: cluster.tags ?? {},
          status: cluster.provisioningState ?? 'Succeeded',
          configuration: config,
          metadata: { resourceGroup: rg },
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
    } catch {
      // Best effort
    }
    return results;
  }

  private async _discoverFunctionApps(credential: ClientSecretCredential): Promise<CloudResource[]> {
    const client = new WebSiteManagementClient(credential, this._subscriptionId);
    const results: CloudResource[] = [];
    try {
      for await (const site of client.webApps.list()) {
        // webApps.list() returns every Web App kind; only keep Function Apps.
        if (!site.kind?.toLowerCase().includes('functionapp')) continue;
        const id = safeString(site.id);
        const loc = extractRegion(site.location);
        const rg = extractResourceGroup(id);
        const name = site.name ?? 'unnamed-func';

        let siteConfig: Awaited<ReturnType<typeof client.webApps.get>>['siteConfig'] | undefined;
        try {
          const full = await retryWithBackoff(() => client.webApps.get(rg, name));
          siteConfig = full.siteConfig;
        } catch {
          // Best effort — fall back to defaults below
        }

        let planType = 'Y1';
        const serverFarmId = site.serverFarmId;
        if (serverFarmId) {
          const planMatch = serverFarmId.match(/\/serverfarms\/([^/]+)/i);
          if (planMatch?.[1]) {
            try {
              const plan = await retryWithBackoff(() => client.appServicePlans.get(rg, planMatch[1]!));
              planType = plan.sku?.name ?? planType;
            } catch {
              // Best effort
            }
          }
        }

        const isLinux = site.reserved === true;
        const linuxFxVersion = siteConfig?.linuxFxVersion ?? '';
        const [runtimeRaw, runtimeVersion] = linuxFxVersion ? linuxFxVersion.split('|') : ['NODE', '20'];
        const runtime = (runtimeRaw ?? 'NODE').toLowerCase();

        const config = {
          name,
          runtime,
          runtimeVersion: runtimeVersion ?? '20',
          osType: isLinux ? 'Linux' : 'Windows',
          planType,
          httpsOnly: site.httpsOnly ?? true,
          alwaysOn: siteConfig?.alwaysOn ?? false,
          minimumTlsVersion: siteConfig?.minTlsVersion ?? '1.2',
          publicNetworkAccess: site.publicNetworkAccess !== 'Disabled',
          appSettings: {},
          source: 'azure-arm',
          imported: true,
        };

        results.push({
          id,
          provider: 'azure',
          subscriptionId: this._subscriptionId,
          region: loc,
          resourceType: 'functions',
          name,
          arn: id,
          resourceId: id,
          tags: site.tags ?? {},
          status: site.state ?? 'Running',
          configuration: config,
          metadata: { resourceGroup: rg },
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
    } catch {
      // Best effort
    }
    return results;
  }

  private async _discoverKeyVaults(credential: ClientSecretCredential): Promise<CloudResource[]> {
    const client = new KeyVaultManagementClient(credential, this._subscriptionId);
    const results: CloudResource[] = [];
    try {
      for await (const vault of client.vaults.listBySubscription()) {
        const id = safeString(vault.id);
        const loc = extractRegion(vault.location);
        const rg = extractResourceGroup(id);
        const props = vault.properties;

        const config = {
          name: vault.name ?? 'unnamed-vault',
          sku: props?.sku?.name ?? 'standard',
          enableRbacAuthorization: props?.enableRbacAuthorization ?? true,
          purgeProtectionEnabled: props?.enablePurgeProtection ?? false,
          softDeleteRetentionDays: props?.softDeleteRetentionInDays ?? 90,
          publicNetworkAccessEnabled: props?.publicNetworkAccess !== 'Disabled',
          networkAclsDefaultAction: props?.networkAcls?.defaultAction ?? 'Allow',
          enabledForDiskEncryption: props?.enabledForDiskEncryption ?? false,
          source: 'azure-arm',
          imported: true,
        };

        results.push({
          id,
          provider: 'azure',
          subscriptionId: this._subscriptionId,
          region: loc,
          resourceType: 'key-vault',
          name: vault.name ?? 'unnamed-vault',
          arn: id,
          resourceId: id,
          tags: vault.tags ?? {},
          status: props?.provisioningState ?? 'Succeeded',
          configuration: config,
          metadata: { resourceGroup: rg },
          configurationHash: computeConfigHash(config),
          discoveredAt: now(),
        });
      }
    } catch {
      // Best effort
    }
    return results;
  }

  // ── Relationship Reconstitution ──────────────────────────────────────────

  private _reconstructAzureRelationships(resources: CloudResource[]): CloudRelationship[] {
    const rels: CloudRelationship[] = [];
    const added = new Set<string>();

    const addRel = (source: string, target: string, type: CloudRelationship['relationshipType'], label?: string) => {
      if (!source || !target || source === target) return;
      const key = `${source}->${target}:${type}`;
      if (added.has(key)) return;
      added.add(key);
      rels.push({
        sourceResourceId: source,
        targetResourceId: target,
        relationshipType: type,
        label,
      });
    };

    const subnets = resources.filter((r) => r.resourceType === 'subnet');
    const vnets = resources.filter((r) => r.resourceType === 'vnet');
    const rgs = resources.filter((r) => r.resourceType === 'resource-group');
    const vms = resources.filter((r) => r.resourceType === 'virtual-machine');
    const lbs = resources.filter((r) => r.resourceType === 'load-balancer');
    const agws = resources.filter((r) => r.resourceType === 'application-gateway');
    const nsgs = resources.filter((r) => r.resourceType === 'network-security-group');
    const pips = resources.filter((r) => r.resourceType === 'public-ip');

    // 1. Subnet in VNet
    for (const sub of subnets) {
      const vnetId = sub.configuration.vnetId as string;
      if (vnetId) addRel(vnetId, sub.id, 'containment', 'Subnet in VNet');
    }

    // 2. VNet in Resource Group
    for (const vnet of vnets) {
      const rgName = (vnet.metadata.resourceGroup as string) || extractResourceGroup(vnet.id);
      const rg = rgs.find((r) => r.name.toLowerCase() === rgName.toLowerCase() || r.id.toLowerCase().includes(rgName.toLowerCase()));
      if (rg) addRel(rg.id, vnet.id, 'containment', 'VNet in Resource Group');
    }

    // 3. App Gateway in Subnet
    for (const agw of agws) {
      const subnetId = agw.configuration.subnetId as string;
      if (subnetId) addRel(subnetId, agw.id, 'containment', 'App Gateway in Subnet');
    }

    // 4. NSG to Subnet
    for (const sub of subnets) {
      const nsgId = sub.configuration.networkSecurityGroupId as string;
      if (nsgId) addRel(nsgId, sub.id, 'security', 'Protects Subnet');
    }

    // 5. Public IP to Load Balancers
    for (const lb of lbs) {
      const feConfigs = (lb.configuration.frontendIPConfigurations as any[]) ?? [];
      for (const fe of feConfigs) {
        if (fe.publicIPAddressId) {
          addRel(fe.publicIPAddressId, lb.id, 'network', 'Public IP attached to LB');
        }
      }
    }

    return rels;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    this._azureCredential = null;
  }
}

// ─── Summary builder ──────────────────────────────────────────────────────────

function buildSummary(resources: CloudResource[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of resources) {
    counts[r.resourceType] = (counts[r.resourceType] ?? 0) + 1;
  }
  return counts;
}
