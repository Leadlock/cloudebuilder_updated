/**
 * Turns the body of POST /api/export into a bounded, well-typed ExportInput.
 *
 * The export renders PNG/PDF/SVG on the server, so its cost grows with what it is given: an unbounded node list, or a node
 * placed at x = 1e9 (which makes the canvas a billion pixels wide), is a cheap way to exhaust memory. Text is cut to length
 * and positions are clamped. (SVG text is escaped by ExportService; coercing the numbers here closes the one place values
 * were written into attributes without escaping.)
 */
import type { CanvasNode } from '@/types';
import type { ExportInput } from '@/lib/services/ExportService';

export const EXPORT_LIMITS = { nodes: 500, edges: 2000, title: 200, label: 200, id: 200, coordinate: 20_000 } as const;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number, fallback = ''): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : fallback).slice(0, max);
const coord = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-EXPORT_LIMITS.coordinate, Math.min(EXPORT_LIMITS.coordinate, n)) : 0;
};

export function sanitizeExportInput(body: Raw): { ok: true; input: ExportInput } | { ok: false; error: string } {
  const { nodes, edges } = body;
  if (!Array.isArray(nodes)) return { ok: false, error: 'nodes must be an array of CanvasNode' };
  if (nodes.length === 0) return { ok: false, error: 'Cannot export an empty canvas. Add at least one resource.' };
  if (nodes.length > EXPORT_LIMITS.nodes) return { ok: false, error: `Too many resources to export (${nodes.length}; the limit is ${EXPORT_LIMITS.nodes}).` };
  if (Array.isArray(edges) && edges.length > EXPORT_LIMITS.edges) return { ok: false, error: `Too many connections to export (${edges.length}; the limit is ${EXPORT_LIMITS.edges}).` };

  const cleanNodes: CanvasNode[] = [];
  for (const n of nodes) {
    if (!isObj(n) || (typeof n.id !== 'string' && typeof n.id !== 'number')) return { ok: false, error: 'Every node needs an id.' };
    const pos = isObj(n.position) ? n.position : {};
    cleanNodes.push({
      id: text(n.id, EXPORT_LIMITS.id),
      resourceType: text(n.resourceType, 100),
      provider: text(n.provider, 20),
      label: text(n.label, EXPORT_LIMITS.label),
      position: { x: coord(pos.x), y: coord(pos.y) },
    } as unknown as CanvasNode);
  }
  const known = new Set(cleanNodes.map((n) => n.id));
  const cleanEdges = (Array.isArray(edges) ? edges : []).filter(isObj)
    .map((e, i) => ({ id: text(e.id, EXPORT_LIMITS.id, `edge-${i}`), source: text(e.source, EXPORT_LIMITS.id), target: text(e.target, EXPORT_LIMITS.id), label: e.label ? text(e.label, EXPORT_LIMITS.label) : undefined }))
    .filter((e) => known.has(e.source) && known.has(e.target));

  return {
    ok: true,
    input: {
      nodes: cleanNodes,
      edges: cleanEdges,
      title: text(body.title, EXPORT_LIMITS.title) || 'Architecture',
      version: body.version ? text(body.version, 50) : undefined,
      theme: body.theme === 'dark' ? 'dark' : 'light',
    },
  };
}
