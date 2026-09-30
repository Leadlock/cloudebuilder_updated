import { CanvasNode, CanvasEdge, CloudProvider } from '@/types';
import { rekeyGraph } from '@/lib/domain/instantiateTemplate';

/** Shape returned by POST /api/ai/generate's `data` field. */
export interface AiRawResource {
  id: string;
  resourceType: string;
  label?: string;
  config?: Record<string, unknown>;
  parentId?: string | null;
}

export interface AiRawConnection {
  sourceId: string;
  targetId: string;
  label?: string;
}

export interface AiRawGraph {
  resources?: AiRawResource[];
  connections?: AiRawConnection[];
}

/**
 * Balances resources across Availability Zones so AZ-B subnets are never left empty
 * when multiple compute/data resources are generated.
 */
function balanceMultiAzTopology(resources: AiRawResource[]): AiRawResource[] {
  const subnets = resources.filter((r) => r.resourceType === 'aws_subnet' || r.resourceType === 'azure_subnet');
  if (subnets.length < 2) return resources;

  // Classify subnets by tier (public, app/compute, data) and AZ (A vs B)
  const getTier = (s: AiRawResource) => {
    const text = `${s.id} ${s.label || ''}`.toLowerCase();
    if (text.includes('pub')) return 'public';
    if (text.includes('data') || text.includes('db')) return 'data';
    return 'app';
  };

  const getAz = (s: AiRawResource) => {
    const text = `${s.id} ${s.label || ''} ${JSON.stringify(s.config || {})}`.toLowerCase();
    if (text.includes('1b') || text.includes('-b') || text.includes('az-b') || text.includes('zone b') || text.includes('eastus2') || text.includes('sub-pub-2') || text.includes('sub-priv-2') || text.includes('sub-data-2')) {
      return 'B';
    }
    return 'A';
  };

  const tiers = ['public', 'app', 'data'] as const;
  const updated = resources.map((r) => ({ ...r }));

  for (const tier of tiers) {
    const tierSubnets = subnets.filter((s) => getTier(s) === tier);
    const subA = tierSubnets.find((s) => getAz(s) === 'A') || tierSubnets[0];
    const subB = tierSubnets.find((s) => getAz(s) === 'B') || (tierSubnets.length > 1 ? tierSubnets[1] : null);

    if (!subA || !subB || subA.id === subB.id) continue;

    const childrenOfA = updated.filter((r) => r.parentId === subA.id);
    const childrenOfB = updated.filter((r) => r.parentId === subB.id);

    // If Subnet B is empty and Subnet A has 2+ children, rebalance
    if (childrenOfB.length === 0 && childrenOfA.length > 1) {
      // Find candidate to move to Subnet B
      const explicitB = childrenOfA.find((c) => {
        const text = `${c.id} ${c.label || ''}`.toLowerCase();
        return text.includes('az-b') || text.includes('az-2') || text.includes('zone b') || text.includes('(b)') || text.includes('redis') || text.includes('cache') || text.includes('standby') || text.includes('replica');
      });

      const toMove = explicitB || childrenOfA[childrenOfA.length - 1];
      if (toMove) {
        toMove.parentId = subB.id;
      }
    }
  }

  return updated;
}

/**
 * Maps the AI generator's validated resource/connection graph onto canvas
 * nodes/edges. Shared by every AI-generation entry point (the in-canvas "AI
 * Architect" panel and the sidebar "AI Generator" page) so the two never
 * drift into different node shapes.
 */
export function mapAiGraphToCanvas(graph: AiRawGraph, provider: CloudProvider): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const balancedResources = balanceMultiAzTopology(graph.resources ?? []);

  const rawNodes: CanvasNode[] = balancedResources.map((r, index) => ({
    id: r.id || `ai-node-${index}`,
    type: 'cloud_node',
    resourceType: r.resourceType,
    provider,
    label: (r.config?.name as string | undefined) || r.label || r.resourceType,
    position: { x: (index % 4) * 220, y: Math.floor(index / 4) * 180 },
    config: r.config || {},
    parentId: r.parentId ?? undefined,
  }));

  const rawEdges: CanvasEdge[] = (graph.connections ?? []).map((c, index) => ({
    id: `ai-edge-${index}`,
    source: c.sourceId,
    target: c.targetId,
    label: c.label,
    provider,
  }));

  const { nodes, edges } = rekeyGraph(rawNodes, rawEdges);
  return { nodes, edges };
}
