import { CanvasNode, CanvasEdge, CloudProvider } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { autoLayoutArchitecture } from '@/lib/canvas/autoLayout';

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

import { v4 as uuidv4 } from 'uuid';

/**
 * Maps the AI generator's validated resource/connection graph onto canvas
 * nodes/edges. Shared by every AI-generation entry point (the in-canvas "AI
 * Architect" panel and the sidebar "AI Generator" page) so the two never
 * drift into different node shapes.
 */
export function mapAiGraphToCanvas(graph: AiRawGraph, provider: CloudProvider): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  // Generate unique IDs for all resources to avoid any persistence collision across architectures
  const idMap = new Map<string, string>();

  (graph.resources ?? []).forEach((r, index) => {
    const rawId = r.id || `node-${index}`;
    const cleanPrefix = rawId.replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'res';
    const cleanId = `${cleanPrefix}-${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    idMap.set(rawId, cleanId);
  });

  const rawNodes: CanvasNode[] = (graph.resources ?? []).map((r, index) => {
    const def = getResourceDefinition(r.resourceType);
    const isContainer = def?.isContainer ?? false;
    const rawId = r.id || `node-${index}`;
    const mappedId = idMap.get(rawId) || `${rawId}-${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const mappedParentId = r.parentId ? idMap.get(r.parentId) || r.parentId : undefined;

    return {
      id: mappedId,
      type: isContainer ? 'containerNode' : 'cloud_node',
      resourceType: r.resourceType,
      provider,
      label: (r.config?.name as string | undefined) || r.label || def?.label || r.resourceType,
      position: { x: (index % 4) * 220, y: Math.floor(index / 4) * 180 },
      width: isContainer ? (def?.defaultWidth || 400) : undefined,
      height: isContainer ? (def?.defaultHeight || 250) : undefined,
      config: { ...(def?.defaultConfig || {}), ...(r.config || {}) },
      parentId: mappedParentId,
      groupId: mappedParentId,
    } as CanvasNode;
  });

  const rawEdges: CanvasEdge[] = (graph.connections ?? []).map((c) => {
    const source = idMap.get(c.sourceId) || c.sourceId;
    const target = idMap.get(c.targetId) || c.targetId;
    return {
      id: `ai-edge-${uuidv4().replace(/-/g, '').slice(0, 12)}`,
      source,
      target,
      label: c.label,
      provider,
    };
  });

  try {
    const { nodes: laidOutNodes, edges: laidOutEdges } = autoLayoutArchitecture(rawNodes, rawEdges);
    return { nodes: laidOutNodes, edges: laidOutEdges };
  } catch (err) {
    console.warn('[mapAiGraphToCanvas] AutoLayout failed, falling back to raw grid positioning:', err);
    return { nodes: rawNodes, edges: rawEdges };
  }
}


