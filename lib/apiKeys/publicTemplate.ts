/** A template as the read-only API gives it: the descriptive fields, never who saved it or which organization it belongs to. */
import type { StoredTemplate } from '@/lib/templates/stored';
import type { CanvasEdge, CanvasNode } from '@/types';

export interface PublicTemplate {
  id: string; name: string; description: string; provider: string; category: string; complexity: string; tags: string[]; features: string[];
  estimatedCostUsd: number; resourceCount: number; source: 'builtin' | 'org'; details: Record<string, unknown>; updatedAt: string;
  graph?: { nodes: CanvasNode[]; edges: CanvasEdge[] };
}

export function publicTemplate(t: StoredTemplate, graph: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null): PublicTemplate {
  return {
    id: t.id, name: t.name, description: t.description, provider: t.provider, category: t.category, complexity: t.complexity, tags: t.tags, features: t.features,
    estimatedCostUsd: t.estimatedCost, resourceCount: t.resourceCount, source: t.source, details: t.meta, updatedAt: t.updatedAt,
    ...(graph ? { graph } : {}),
  };
}
