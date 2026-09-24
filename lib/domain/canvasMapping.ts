/**
 * Pure mapping from persisted architecture rows to the canvas graph.
 * Shared by the repository, the assessment engine and server routes; has no
 * database dependency so it can be used in client bundles.
 */
import type { CanvasNode, CanvasEdge, Region } from '@/types';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';


export function toCanvas(
  resources: DbArchitectureResource[],
  connections: DbArchitectureConnection[],
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes: CanvasNode[] = resources.map((r) => ({
    id: r.id,
    type: 'cloudNode',
    resourceType: r.resourceType,
    provider: r.provider as 'aws' | 'azure',
    label: r.label,
    position: { x: r.positionX, y: r.positionY },
    config: (() => {
      try { return JSON.parse(r.configJson) as Record<string, unknown>; } catch { return {}; }
    })(),
    ...(r.region ? { region: r.region as Region } : {}),
    ...(r.groupId ? { groupId: r.groupId } : {}),
    importState: (() => {
      try {
        const c = JSON.parse(r.configJson);
        return ((c.importState as string) ?? (c.imported ? 'imported' : undefined)) as CanvasNode['importState'];
      } catch { return undefined; }
    })(),
    locked: r.locked,
  }));

  const edges: CanvasEdge[] = connections.map((c) => ({
    id: c.id,
    source: c.sourceId,
    target: c.targetId,
    ...(c.label ? { label: c.label } : {}),
    ...(c.edgeType ? { edgeType: c.edgeType as CanvasEdge['edgeType'] } : {}),
  }));

  return { nodes, edges };
}
