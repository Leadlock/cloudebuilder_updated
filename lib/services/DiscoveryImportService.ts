/**
 * DiscoveryImportService — bridges a completed discovery run into a CloudCraft
 * architecture canvas, persisting discovered resources as ArchitectureResources.
 *
 * Security: discovery runs contain only sanitised resource data (no credentials).
 * This service never reads cloud credentials.
 */
import { architectureRepository, toCanvas } from '@/lib/repositories/architectureRepository';
import { discoveryRepository } from '@/lib/repositories/discoveryRepository';
import { environmentRepository } from '@/lib/repositories/projectRepository';
import { normalizeDiscoveredInfrastructure } from '@/lib/cloud/normalizer';
import type { CanvasNode, CanvasEdge } from '@/types';

export interface ImportDiscoveryResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  resourceCount: number;
  summary: Record<string, number>;
}

export const discoveryImportService = {
  /**
   * Import a completed discovery run into the given architecture environment.
   * Merges discovered resources with any existing canvas nodes (deduplicates by id).
   *
   * @param runId          - ID of the completed DiscoveryRun
   * @param environmentId  - Architecture environment to write into (Environment ID or Project ID)
   * @param merge          - If true, merge with existing nodes; if false, replace
   */
  async importRun(
    runId: string,
    environmentId: string,
    merge = false,
  ): Promise<ImportDiscoveryResult | null> {
    // Load the discovery run
    const run = await discoveryRepository.findById(runId);
    if (!run) return null;
    if (run.status !== 'completed') return null;

    // Resolve target environment ID
    let targetEnvId = environmentId;
    const existingArch = await architectureRepository.findByEnvironment(environmentId);
    if (!existingArch) {
      // Check if environmentId was a projectId
      const prodEnv = await environmentRepository.findByKey(environmentId, 'production');
      if (prodEnv) {
        targetEnvId = prodEnv.id;
      }
    }

    // Convert discovered resources to canvas nodes and real relationships
    const { nodes: newNodes, edges: newEdges } = normalizeDiscoveredInfrastructure(run.resources);

    let finalNodes: CanvasNode[];
    let finalEdges: CanvasEdge[];

    if (merge) {
      // Load existing canvas and merge, deduplicating by node id
      const existing = await architectureRepository.findByEnvironment(targetEnvId);
      const existingResources = existing?.resources ?? [];
      const existingConnections = existing?.connections ?? [];

      const { nodes: currentNodes, edges: currentEdges } = toCanvas(existingResources, existingConnections);

      // Deduplicate: new nodes override existing ones with same id
      const nodeMap = new Map<string, CanvasNode>();
      for (const n of currentNodes) nodeMap.set(n.id, n);
      for (const n of newNodes) nodeMap.set(n.id, n);

      const edgeMap = new Map<string, CanvasEdge>();
      for (const e of currentEdges) edgeMap.set(`${e.source}->${e.target}`, e);
      for (const e of newEdges) edgeMap.set(`${e.source}->${e.target}`, e);

      finalNodes = [...nodeMap.values()];
      finalEdges = [...edgeMap.values()];
    } else {
      finalNodes = newNodes;
      finalEdges = newEdges;
    }

    // Persist to architecture canvas
    await architectureRepository.saveCanvas(targetEnvId, finalNodes, finalEdges);

    return {
      nodes: finalNodes,
      edges: finalEdges,
      resourceCount: newNodes.length,
      summary: run.summary,
    };
  },
};
