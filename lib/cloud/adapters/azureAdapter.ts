/**
 * Azure Discovery Adapter
 *
 * Uses @azure/identity (ClientSecretCredential) and Azure management SDKs.
 * Discovers: Resource Groups, VNets, Subnets, VMs, Storage Accounts, SQL Servers/DBs, Load Balancers.
 *
 * Security contract:
 * - Credentials are accepted at construction time and used only inside this file.
 * - clientSecret is never logged or returned to callers.
 * - Only sanitised resource data is returned in DiscoveredResource objects.
 */
import { ClientSecretCredential } from '@azure/identity';
import { NetworkManagementClient } from '@azure/arm-network';
import { ComputeManagementClient } from '@azure/arm-compute';
import { StorageManagementClient } from '@azure/arm-storage';
import { SqlManagementClient } from '@azure/arm-sql';
import { ResourceManagementClient } from '@azure/arm-resources';
import type {
  AzureSpCredentials,
  DiscoveredResource,
  DiscoveryResult,
  AccountValidationResult,
  AzureAccountIdentity,
} from '../types';
import type { InfrastructureDiscoveryProvider } from '../provider';

// ─── Required permissions (Reader role) ──────────────────────────────────────

const REQUIRED_PERMISSIONS = [
  'Microsoft.Network/virtualNetworks/read',
  'Microsoft.Network/virtualNetworks/subnets/read',
  'Microsoft.Compute/virtualMachines/read',
  'Microsoft.Storage/storageAccounts/read',
  'Microsoft.Sql/servers/read',
  'Microsoft.Sql/servers/databases/read',
  'Microsoft.Network/loadBalancers/read',
  'Microsoft.Resources/subscriptions/resourceGroups/read',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function now(): string {
  return new Date().toISOString();
}

function extractRegion(id: string | undefined): string {
  return id ?? 'unknown';
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
      // clientSecret is never logged — it stays in this instance only
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

      // Attempt to list resource groups as a lightweight permission check
      const missingPermissions: string[] = [];
      let subscriptionName = '';

      try {
        const rg = resourceClient.resourceGroups.list();
        const first = await rg.next();
        void first; // just checking connectivity
      } catch {
        missingPermissions.push(
          'Microsoft.Resources/subscriptions/resourceGroups/read',
          'Microsoft.Network/virtualNetworks/read',
        );
      }

      // Attempt to retrieve subscription details — SubscriptionClient is optional
      // Subscription name lookup is best-effort; use subscriptionId as fallback.
      subscriptionName = this._subscriptionId;

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
      // Log without credentials (no clientSecret)
      console.error('[AzureDiscoveryAdapter] validateAccount failed:', message);
      return {
        valid: false,
        permissionsOk: false,
        missingPermissions: REQUIRED_PERMISSIONS,
        error: message,
      };
    }
  }

  // ── Discovery ────────────────────────────────────────────────────────────

  async discoverAll(): Promise<DiscoveryResult> {
    const startedAt = now();
    const resources: DiscoveredResource[] = [];

    try {
      const credential = this._getCredential();

      const [rgResources, networkResources, computeResources, storageResources, sqlResources] =
        await Promise.all([
          this._discoverResourceGroups(credential),
          this._discoverNetworking(credential),
          this._discoverVirtualMachines(credential),
          this._discoverStorageAccounts(credential),
          this._discoverSqlResources(credential),
        ]);

      resources.push(
        ...rgResources,
        ...networkResources,
        ...computeResources,
        ...storageResources,
        ...sqlResources,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AzureDiscoveryAdapter] discoverAll failed:', message);
      return {
        accountId: this._subscriptionId,
        provider: 'azure',
        status: 'failed',
        startedAt,
        completedAt: now(),
        resources: [],
        error: message,
        summary: {},
      };
    }

    const summary = buildSummary(resources);
    return {
      accountId: this._subscriptionId,
      provider: 'azure',
      status: 'completed',
      startedAt,
      completedAt: now(),
      resources,
      summary,
    };
  }

  // ── Per-service discovery helpers ────────────────────────────────────────

  private async _discoverResourceGroups(
    credential: ClientSecretCredential,
  ): Promise<DiscoveredResource[]> {
    const client = new ResourceManagementClient(credential, this._subscriptionId);
    const results: DiscoveredResource[] = [];
    for await (const rg of client.resourceGroups.list()) {
      results.push({
        providerResourceId: safeString(rg.id),
        resourceType: 'resource-group',
        provider: 'azure',
        name: rg.name ?? 'unnamed-rg',
        region: rg.location ?? 'unknown',
        status: rg.properties?.provisioningState ?? 'unknown',
        configuration: {
          location: rg.location ?? null,
        },
        metadata: {
          tags: rg.tags ?? {},
        },
      });
    }
    return results;
  }

  private async _discoverNetworking(
    credential: ClientSecretCredential,
  ): Promise<DiscoveredResource[]> {
    const client = new NetworkManagementClient(credential, this._subscriptionId);
    const results: DiscoveredResource[] = [];

    // VNets
    for await (const vnet of client.virtualNetworks.listAll()) {
      results.push({
        providerResourceId: safeString(vnet.id),
        resourceType: 'vnet',
        provider: 'azure',
        name: vnet.name ?? 'unnamed-vnet',
        region: vnet.location ?? 'unknown',
        status: vnet.provisioningState ?? 'unknown',
        configuration: {
          addressSpace: vnet.addressSpace?.addressPrefixes ?? [],
          enableDdosProtection: vnet.enableDdosProtection ?? false,
        },
        metadata: {
          tags: vnet.tags ?? {},
          resourceGroup: extractResourceGroup(safeString(vnet.id)),
        },
      });

      // Subnets within each VNet
      for (const subnet of vnet.subnets ?? []) {
        results.push({
          providerResourceId: safeString(subnet.id),
          resourceType: 'subnet',
          provider: 'azure',
          name: subnet.name ?? 'unnamed-subnet',
          region: vnet.location ?? 'unknown',
          status: subnet.provisioningState ?? 'unknown',
          configuration: {
            addressPrefix: subnet.addressPrefix ?? null,
            vnetId: vnet.id ?? null,
          },
          metadata: {
            resourceGroup: extractResourceGroup(safeString(vnet.id)),
          },
        });
      }
    }

    // Load Balancers
    for await (const lb of client.loadBalancers.listAll()) {
      results.push({
        providerResourceId: safeString(lb.id),
        resourceType: 'load-balancer',
        provider: 'azure',
        name: lb.name ?? 'unnamed-lb',
        region: lb.location ?? 'unknown',
        status: lb.provisioningState ?? 'unknown',
        configuration: {
          sku: lb.sku?.name ?? null,
          frontendIPConfigurations: (lb.frontendIPConfigurations ?? []).map((fe) => ({
            name: fe.name,
            privateIPAddress: fe.privateIPAddress ?? null,
            privateIPAllocationMethod: fe.privateIPAllocationMethod ?? null,
          })),
        },
        metadata: {
          tags: lb.tags ?? {},
          resourceGroup: extractResourceGroup(safeString(lb.id)),
        },
      });
    }

    return results;
  }

  private async _discoverVirtualMachines(
    credential: ClientSecretCredential,
  ): Promise<DiscoveredResource[]> {
    const client = new ComputeManagementClient(credential, this._subscriptionId);
    const results: DiscoveredResource[] = [];

    for await (const vm of client.virtualMachines.listAll()) {
      results.push({
        providerResourceId: safeString(vm.id),
        resourceType: 'virtual-machine',
        provider: 'azure',
        name: vm.name ?? 'unnamed-vm',
        region: vm.location ?? 'unknown',
        status: vm.provisioningState ?? 'unknown',
        configuration: {
          vmSize: vm.hardwareProfile?.vmSize ?? null,
          osType: vm.storageProfile?.osDisk?.osType ?? null,
          imageOffer: vm.storageProfile?.imageReference?.offer ?? null,
          imageSku: vm.storageProfile?.imageReference?.sku ?? null,
          adminUsername: vm.osProfile?.adminUsername ?? null,
        },
        metadata: {
          tags: vm.tags ?? {},
          resourceGroup: extractResourceGroup(safeString(vm.id)),
          zones: vm.zones ?? [],
        },
      });
    }
    return results;
  }

  private async _discoverStorageAccounts(
    credential: ClientSecretCredential,
  ): Promise<DiscoveredResource[]> {
    const client = new StorageManagementClient(credential, this._subscriptionId);
    const results: DiscoveredResource[] = [];

    for await (const sa of client.storageAccounts.list()) {
      results.push({
        providerResourceId: safeString(sa.id),
        resourceType: 'storage-account',
        provider: 'azure',
        name: sa.name ?? 'unnamed-storage',
        region: extractRegion(sa.location),
        status: sa.provisioningState ?? 'unknown',
        configuration: {
          kind: sa.kind ?? null,
          skuName: sa.sku?.name ?? null,
          accessTier: sa.accessTier ?? null,
          primaryEndpoints: {
            blob: sa.primaryEndpoints?.blob ?? null,
            file: sa.primaryEndpoints?.file ?? null,
            queue: sa.primaryEndpoints?.queue ?? null,
            table: sa.primaryEndpoints?.table ?? null,
          },
          enableHttpsTrafficOnly: sa.enableHttpsTrafficOnly ?? true,
        },
        metadata: {
          tags: sa.tags ?? {},
          resourceGroup: extractResourceGroup(safeString(sa.id)),
          creationTime: sa.creationTime?.toISOString() ?? null,
        },
      });
    }
    return results;
  }

  private async _discoverSqlResources(
    credential: ClientSecretCredential,
  ): Promise<DiscoveredResource[]> {
    const client = new SqlManagementClient(credential, this._subscriptionId);
    const results: DiscoveredResource[] = [];

    for await (const server of client.servers.list()) {
      results.push({
        providerResourceId: safeString(server.id),
        resourceType: 'sql-server',
        provider: 'azure',
        name: server.name ?? 'unnamed-sql-server',
        region: server.location ?? 'unknown',
        status: server.state ?? 'unknown',
        configuration: {
          fullyQualifiedDomainName: server.fullyQualifiedDomainName ?? null,
          version: server.version ?? null,
          administratorLogin: server.administratorLogin ?? null,
        },
        metadata: {
          tags: server.tags ?? {},
          resourceGroup: extractResourceGroup(safeString(server.id)),
        },
      });

      // Databases within each server
      if (server.name) {
        const resourceGroup = extractResourceGroup(safeString(server.id));
        try {
          for await (const db of client.databases.listByServer(resourceGroup, server.name)) {
            results.push({
              providerResourceId: safeString(db.id),
              resourceType: 'sql-database',
              provider: 'azure',
              name: db.name ?? 'unnamed-db',
              region: db.location ?? server.location ?? 'unknown',
              status: db.status ?? 'unknown',
              configuration: {
                sku: db.sku?.name ?? null,
                tier: db.sku?.tier ?? null,
                maxSizeBytes: db.maxSizeBytes ?? null,
                collation: db.collation ?? null,
              },
              metadata: {
                tags: db.tags ?? {},
                serverId: server.id ?? null,
                resourceGroup,
                creationDate: db.creationDate?.toISOString() ?? null,
              },
            });
          }
        } catch (dbErr) {
          console.error(
            `[AzureDiscoveryAdapter] Failed to list databases for server ${server.name}:`,
            dbErr instanceof Error ? dbErr.message : String(dbErr),
          );
        }
      }
    }
    return results;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    this._azureCredential = null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractResourceGroup(resourceId: string): string {
  const match = resourceId.match(/\/resourceGroups\/([^/]+)\//i);
  return match?.[1] ?? 'unknown';
}

function buildSummary(resources: DiscoveredResource[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of resources) {
    counts[r.resourceType] = (counts[r.resourceType] ?? 0) + 1;
  }
  return counts;
}
