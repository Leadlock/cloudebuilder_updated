/**
 * InfrastructureSyncService — Change Detection & Synchronization Model
 *
 * Implements:
 * - import(): Safe discovery and import of cloud infrastructure into CloudCraft canvas
 * - refresh(): Re-scans previously imported infrastructure from cloud APIs
 * - detectChanges(): Compares live cloud state with canvas architecture, detecting:
 *     - Drift / Modified: Functional configuration diverged in cloud
 *     - Deleted in Cloud: Resources removed out-of-band in cloud console
 *     - New in Cloud: New resources provisioned in cloud account
 *     - User Proposed: Resources designed by user in CloudCraft canvas
 *
 * Safety:
 * - READ-ONLY: Never writes or modifies customer infrastructure in the cloud.
 */
import type { CanvasNode, CanvasEdge } from '@/types';
import type { CloudCredentials } from '../types';
import type {
  CloudResource,
  DiscoveredTopology,
  DiscoveryOptions,
} from '../discovery/types';
import { cloudInfrastructureDiscoveryService } from '../discovery/CloudInfrastructureDiscoveryService';
import { normalizeDiscoveredInfrastructure } from '../normalizer';
import { computeConfigHash, sanitizeResourceId } from '../discovery/utils';

// ─── Drift & Change Types ─────────────────────────────────────────────────────

export type ResourceDriftStatus =
  | 'unchanged'       // In sync between CloudCraft and live cloud
  | 'modified'        // Configuration drift detected in cloud
  | 'deleted_in_cloud'// Resource no longer exists in live cloud
  | 'new_in_cloud'    // Resource was added in cloud outside CloudCraft
  | 'user_proposed';  // Resource added in CloudCraft by user (not yet deployed)

export interface DriftItem {
  nodeId: string;
  resourceType: string;
  label: string;
  provider: import('@/types').CloudProvider;
  status: ResourceDriftStatus;
  cloudResourceId?: string;
  canvasConfigHash?: string;
  cloudConfigHash?: string;
  changedFields?: string[];
  message: string;
}

export interface DriftReport {
  scannedAt: string;
  accountId: string;
  provider: 'aws' | 'azure';
  totalCanvasNodes: number;
  totalCloudResources: number;
  summary: {
    unchanged: number;
    modified: number;
    deletedInCloud: number;
    newInCloud: number;
    userProposed: number;
  };
  items: DriftItem[];
}

export interface SyncImportResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  topology: DiscoveredTopology;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class InfrastructureSyncService {
  /**
   * Import infrastructure from cloud credentials and normalize into canvas architecture.
   */
  async import(
    credentials: CloudCredentials,
    options: DiscoveryOptions = {},
  ): Promise<SyncImportResult> {
    const topology = await cloudInfrastructureDiscoveryService.discoverInfrastructure(credentials, options);
    const { nodes, edges } = normalizeDiscoveredInfrastructure(topology.resources, topology.relationships);
    return { nodes, edges, topology };
  }

  /**
   * Re-scan live cloud infrastructure and compute drift against current canvas nodes.
   */
  async refresh(
    credentials: CloudCredentials,
    currentNodes: CanvasNode[],
    options: DiscoveryOptions = {},
  ): Promise<{
    driftReport: DriftReport;
    freshTopology: DiscoveredTopology;
  }> {
    const freshTopology = await cloudInfrastructureDiscoveryService.discoverInfrastructure(credentials, options);
    const driftReport = this.detectChanges(currentNodes, freshTopology.resources, freshTopology.accountId, freshTopology.provider);
    return { driftReport, freshTopology };
  }

  /**
   * Detects differences and configuration drift between canvas nodes and freshly discovered cloud resources.
   */
  detectChanges(
    currentNodes: CanvasNode[],
    freshCloudResources: CloudResource[],
    accountId: string,
    provider: 'aws' | 'azure',
  ): DriftReport {
    const scannedAt = new Date().toISOString();
    const items: DriftItem[] = [];

    // Build lookup of cloud resources by normalized IDs, raw IDs, and ARNs
    const cloudByLookup = new Map<string, CloudResource>();
    for (const res of freshCloudResources) {
      if (res.id) cloudByLookup.set(res.id, res);
      if (res.arn) cloudByLookup.set(res.arn, res);
      if (res.resourceId) cloudByLookup.set(res.resourceId, res);
      if (res.arn) cloudByLookup.set(sanitizeResourceId(res.arn), res);
      if (res.resourceId) cloudByLookup.set(sanitizeResourceId(res.resourceId), res);
    }

    const matchedCloudResources = new Set<string>();

    // 1. Evaluate current canvas nodes
    for (const node of currentNodes) {
      const cfg = node.config || {};
      const isImported = node.importState === 'imported' || cfg.imported === true;
      const rawId = (cfg.providerResourceId as string) || (cfg.arn as string) || (cfg.resourceId as string) || node.id;
      const cloudRes = cloudByLookup.get(rawId) || cloudByLookup.get(node.id) || cloudByLookup.get(sanitizeResourceId(rawId));

      if (!isImported) {
        // User-added proposed resource
        items.push({
          nodeId: node.id,
          resourceType: node.resourceType,
          label: node.label,
          provider: node.provider,
          status: 'user_proposed',
          message: 'Proposed resource created in CloudCraft canvas (not yet in cloud)',
        });
        continue;
      }

      if (!cloudRes) {
        // Was imported previously, but no longer found in live cloud
        items.push({
          nodeId: node.id,
          resourceType: node.resourceType,
          label: node.label,
          provider: node.provider,
          status: 'deleted_in_cloud',
          cloudResourceId: rawId,
          message: 'Resource exists on canvas but was deleted or is no longer accessible in cloud',
        });
        continue;
      }

      matchedCloudResources.add(cloudRes.id);
      if (cloudRes.arn) matchedCloudResources.add(cloudRes.arn);
      if (cloudRes.resourceId) matchedCloudResources.add(cloudRes.resourceId);

      // Compare configuration hash
      const canvasHash = (cfg.configurationHash as string) || computeConfigHash(cfg);
      const cloudHash = cloudRes.configurationHash || computeConfigHash(cloudRes.configuration);

      if (canvasHash === cloudHash) {
        items.push({
          nodeId: node.id,
          resourceType: node.resourceType,
          label: node.label,
          provider: node.provider,
          status: 'unchanged',
          cloudResourceId: cloudRes.resourceId || cloudRes.id,
          canvasConfigHash: canvasHash,
          cloudConfigHash: cloudHash,
          message: 'In sync with live cloud infrastructure',
        });
      } else {
        // Find changed keys
        const changedFields: string[] = [];
        const cloudCfg = cloudRes.configuration || {};
        for (const k of Object.keys(cloudCfg)) {
          if (!k.startsWith('_') && JSON.stringify(cfg[k]) !== JSON.stringify(cloudCfg[k])) {
            changedFields.push(k);
          }
        }

        items.push({
          nodeId: node.id,
          resourceType: node.resourceType,
          label: node.label,
          provider: node.provider,
          status: 'modified',
          cloudResourceId: cloudRes.resourceId || cloudRes.id,
          canvasConfigHash: canvasHash,
          cloudConfigHash: cloudHash,
          changedFields,
          message: `Configuration drift detected in cloud: ${changedFields.slice(0, 4).join(', ') || 'attributes modified'}`,
        });
      }
    }

    // 2. Discover resources that exist in cloud but not on canvas
    for (const cloudRes of freshCloudResources) {
      const isAlreadyOnCanvas =
        matchedCloudResources.has(cloudRes.id) ||
        (cloudRes.arn && matchedCloudResources.has(cloudRes.arn)) ||
        (cloudRes.resourceId && matchedCloudResources.has(cloudRes.resourceId));

      if (!isAlreadyOnCanvas) {
        items.push({
          nodeId: sanitizeResourceId(cloudRes.arn || cloudRes.resourceId || cloudRes.id),
          resourceType: cloudRes.resourceType,
          label: cloudRes.name,
          provider,
          status: 'new_in_cloud',
          cloudResourceId: cloudRes.resourceId || cloudRes.id,
          cloudConfigHash: cloudRes.configurationHash,
          message: 'Discovered new resource in cloud account not currently represented on canvas',
        });
      }
    }

    const summary = {
      unchanged: items.filter((i) => i.status === 'unchanged').length,
      modified: items.filter((i) => i.status === 'modified').length,
      deletedInCloud: items.filter((i) => i.status === 'deleted_in_cloud').length,
      newInCloud: items.filter((i) => i.status === 'new_in_cloud').length,
      userProposed: items.filter((i) => i.status === 'user_proposed').length,
    };

    return {
      scannedAt,
      accountId,
      provider,
      totalCanvasNodes: currentNodes.length,
      totalCloudResources: freshCloudResources.length,
      summary,
      items,
    };
  }
}

export const infrastructureSyncService = new InfrastructureSyncService();
