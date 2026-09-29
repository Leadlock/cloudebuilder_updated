import { CanvasNode, CanvasEdge, CloudProvider } from '@/types';

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
 * Maps the AI generator's validated resource/connection graph onto canvas
 * nodes/edges. Shared by every AI-generation entry point (the in-canvas "AI
 * Architect" panel and the sidebar "AI Generator" page) so the two never
 * drift into different node shapes.
 */
export function mapAiGraphToCanvas(graph: AiRawGraph, provider: CloudProvider): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes: CanvasNode[] = (graph.resources ?? []).map((r, index) => ({
    id: r.id || `ai-node-${Date.now()}-${index}`,
    type: 'cloud_node',
    resourceType: r.resourceType,
    provider,
    label: (r.config?.name as string | undefined) || r.label || r.resourceType,
    position: { x: (index % 4) * 220, y: Math.floor(index / 4) * 180 },
    config: r.config || {},
    parentId: r.parentId ?? undefined,
  }));

  const edges: CanvasEdge[] = (graph.connections ?? []).map((c, index) => ({
    id: `ai-edge-${Date.now()}-${index}`,
    source: c.sourceId,
    target: c.targetId,
    label: c.label,
    provider,
  }));

  return { nodes, edges };
}
