/**
 * Architecture templates as rows of the database. Pure functions (no database, no network) so the sync, the API and the gallery share one definition.
 *
 * A built-in template is code: its `generate()` makes the graph. A row keeps what the gallery shows (`meta`), and the graph it makes with its default
 * options. An organization's own template has no code: its row is all there is, and `toTemplate` gives it a `generate()` that returns the saved graph.
 */
import { createHash } from 'crypto';
import { z } from 'zod';
import type { ArchitectureTemplate, CanvasEdge, CanvasNode, CloudProvider } from '@/types';

export type TemplateSource = 'builtin' | 'org';

/** What a template's row holds, with the JSON columns already parsed. */
export interface StoredTemplate {
  id: string;
  orgId: string | null;
  source: TemplateSource;
  name: string;
  description: string;
  provider: CloudProvider;
  category: string;
  complexity: ArchitectureTemplate['complexity'];
  tags: string[];
  features: string[];
  estimatedCost: number;
  resourceCount: number;
  meta: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface StoredTemplateWithGraph extends StoredTemplate { graph: { nodes: CanvasNode[]; edges: CanvasEdge[] } }

/** The descriptive fields the gallery shows beyond the columns. */
const META_KEYS = ['isAdaptive', 'scaleRecommendation', 'isReferenceArchitecture', 'architecturePattern', 'useCases', 'availabilityTarget', 'supportedScale', 'dataFlowSummary', 'sourceReferences'] as const;

export const MAX_ORG_TEMPLATES = 100;
export const MAX_TEMPLATE_NODES = 500;
export const MAX_TEMPLATE_BYTES = 1_000_000;

/** The template's own graph, with its stable ids, for a file or a row. (A canvas is made with instantiateTemplate, which gives every resource a new id.) */
export const masterGraph = (t: ArchitectureTemplate): { nodes: CanvasNode[]; edges: CanvasEdge[] } => t.generate({});

/** What is written for a built-in template (the row, without its timestamps). */
export function builtInRow(t: ArchitectureTemplate) {
  const graph = masterGraph(t);
  const meta: Record<string, unknown> = {};
  for (const k of META_KEYS) if ((t as unknown as Record<string, unknown>)[k] !== undefined) meta[k] = (t as unknown as Record<string, unknown>)[k];
  const row = {
    id: t.id, orgId: null as string | null, source: 'builtin' as TemplateSource, name: t.name, description: t.description, provider: t.provider, category: t.category,
    complexity: t.complexity, tagsJson: JSON.stringify(t.tags), featuresJson: JSON.stringify(t.features), estimatedCost: t.estimatedCost, resourceCount: t.resourceCount,
    metaJson: JSON.stringify(meta), graphJson: JSON.stringify({ nodes: graph.nodes, edges: graph.edges }),
  };
  return { ...row, contentHash: createHash('sha256').update(JSON.stringify(row)).digest('hex') };
}
export type TemplateRowInput = ReturnType<typeof builtInRow>;

const parseList = (s: unknown): string[] => { try { const v = JSON.parse(String(s)); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
const parseObj = (s: unknown): Record<string, unknown> => { try { const v = JSON.parse(String(s)); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; } };

/** A database row (columns as the database returns them) as a template without its graph. */
export function fromRow(r: Record<string, unknown>): StoredTemplate {
  return {
    id: String(r['id']), orgId: r['orgId'] == null ? null : String(r['orgId']), source: r['source'] === 'org' ? 'org' : 'builtin', name: String(r['name']), description: String(r['description']),
    provider: String(r['provider']) as CloudProvider, category: String(r['category']), complexity: String(r['complexity']) as StoredTemplate['complexity'],
    tags: parseList(r['tagsJson']), features: parseList(r['featuresJson']), estimatedCost: Number(r['estimatedCost']), resourceCount: Number(r['resourceCount']),
    meta: parseObj(r['metaJson']), createdBy: r['createdBy'] == null ? null : String(r['createdBy']), createdAt: String(r['createdAt']), updatedAt: String(r['updatedAt']),
  };
}

export function graphOf(r: Record<string, unknown>): { nodes: CanvasNode[]; edges: CanvasEdge[] } | null {
  try {
    const g = JSON.parse(String(r['graphJson'])) as { nodes?: CanvasNode[]; edges?: CanvasEdge[] };
    return Array.isArray(g.nodes) && Array.isArray(g.edges) ? { nodes: g.nodes, edges: g.edges } : null;
  } catch { return null; }
}

/** A stored template as the gallery's template, with a `generate()` that gives (a copy of) the saved graph. */
export function toTemplate(t: StoredTemplate, graph: { nodes: CanvasNode[]; edges: CanvasEdge[] }): ArchitectureTemplate {
  return {
    id: t.id, name: t.name, description: t.description, provider: t.provider, category: t.category, tags: t.tags, complexity: t.complexity,
    estimatedCost: t.estimatedCost, resourceCount: t.resourceCount, features: t.features, ...(t.meta as object),
    generate: () => JSON.parse(JSON.stringify(graph)) as typeof graph,
  } as ArchitectureTemplate;
}

// ─── What a member may save ───────────────────────────────────────────────────

const text = (max: number) => z.string().trim().min(1).max(max);
const NodeSchema = z.object({ id: text(200), type: text(100), label: z.string().max(300), position: z.object({ x: z.number().finite(), y: z.number().finite() }), config: z.record(z.string(), z.unknown()).optional() }).passthrough();
const EdgeSchema = z.object({ id: text(200), source: text(200), target: text(200) }).passthrough();

export const SaveTemplateBody = z.object({
  name: text(80),
  description: z.string().trim().max(500).default(''),
  provider: z.enum(['aws', 'azure', 'multi']),
  category: text(60).default('Custom'),
  tags: z.array(text(30)).max(10).default([]),
  nodes: z.array(NodeSchema).min(1).max(MAX_TEMPLATE_NODES),
  edges: z.array(EdgeSchema).max(MAX_TEMPLATE_NODES * 4),
});
export type SaveTemplateInput = z.infer<typeof SaveTemplateBody>;

/** Problems with a graph that the shape check cannot see: an edge to a node that is not there, a repeated id. */
export function graphProblems(nodes: Array<{ id: string }>, edges: Array<{ source: string; target: string }>): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const out: string[] = [];
  if (ids.size !== nodes.length) out.push('Two resources have the same id.');
  if (edges.some((e) => !ids.has(e.source) || !ids.has(e.target))) out.push('A connection points at a resource that is not in the template.');
  if (Buffer.byteLength(JSON.stringify({ nodes, edges })) > MAX_TEMPLATE_BYTES) out.push('The template is larger than 1 MB.');
  return out;
}
