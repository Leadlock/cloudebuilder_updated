/**
 * Template instantiation with instance-unique resource IDs.
 *
 * Template `generate()` returns the master template graph with stable, human-readable
 * node IDs (e.g. "ref-azure-three-tier-vmss-sql"). Those IDs are the template's own
 * identity and must never be persisted as architecture resource IDs: resource IDs are a
 * global primary key, so the same template used in two projects — or twice in one — would
 * collide on save.
 *
 * `instantiateTemplate` / `rekeyGraph` give every node and edge a fresh ID
 * (`<templateNodeId>-<16 hex>`), remap all references (parentId, groupId, edge endpoints,
 * and config values that point at another node), and record the stable template node ID
 * in `config.templateNodeId` for traceability.
 */
import type { ArchitectureTemplate, CanvasEdge, CanvasNode } from '@/types';

type GenerateOptions = Parameters<ArchitectureTemplate['generate']>[0];

function randomSuffix(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '').slice(0, 16);
  // Fallback for environments without WebCrypto (not expected in supported browsers/Node).
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** Replace string references to old node IDs inside a config value. */
function remapRefs(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === 'string') return idMap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remapRefs(v, idMap));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, remapRefs(v, idMap)]));
  }
  return value;
}

export function rekeyGraph(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  newId: (oldId: string) => string = (oldId) => `${oldId}-${randomSuffix()}`,
): { nodes: CanvasNode[]; edges: CanvasEdge[]; idMap: Map<string, string> } {
  const idMap = new Map(nodes.map((n) => [n.id, newId(n.id)]));
  const outNodes = nodes.map((n) => {
    const config = remapRefs(n.config ?? {}, idMap) as Record<string, unknown>;
    return {
      ...n,
      id: idMap.get(n.id)!,
      ...(n.parentId ? { parentId: idMap.get(n.parentId) ?? n.parentId } : {}),
      ...(n.groupId ? { groupId: idMap.get(n.groupId) ?? n.groupId } : {}),
      config: { ...config, templateNodeId: (n.config?.templateNodeId as string | undefined) ?? n.id },
      position: { ...n.position },
    } as CanvasNode;
  });
  const outEdges = edges
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({ ...e, id: `${e.id}-${randomSuffix()}`, source: idMap.get(e.source)!, target: idMap.get(e.target)! }));
  return { nodes: outNodes, edges: outEdges, idMap };
}

/** Generate a template and return an instance graph with unique IDs. */
export function instantiateTemplate(template: ArchitectureTemplate, opts: GenerateOptions = {} as GenerateOptions): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const { nodes, edges } = template.generate(opts);
  const r = rekeyGraph(nodes, edges);
  return { nodes: r.nodes, edges: r.edges };
}
