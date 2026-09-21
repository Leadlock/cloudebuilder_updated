/**
 * Regression test for a severe, previously-silent bug: the canvas save route
 * (app/api/projects/[id]/canvas/route.ts) validated incoming edges against
 * `edgeType: z.enum(['data', 'network', 'security', 'management'])` — a stale
 * 4-value set from an early version of the edge model. Every real relationship
 * type (LOAD_BALANCES, CONNECTS_TO, TRIGGERS, REPLICATES_TO, ...) used by
 * templates, the AI generator, and RelationshipEngine-suggested connections
 * failed this validation with 400 Bad Request. Because the client always
 * wrapped the save call in `.catch(() => {})` (see context/AppContext.tsx),
 * every one of those failures was invisible: the UI showed the architecture
 * fine locally, but nothing had actually persisted. Confirmed live: opening a
 * template showed the full diagram, yet the dashboard reported "0 resources"
 * for the saved project.
 */
import { CanvasEdgeSchema, SaveCanvasSchema } from '@/lib/api/schemas/canvasSchema';
import { architectureTemplates } from '@/lib/templates';
import type { RelationshipType } from '@/lib/domain/relationshipModel';

const ALL_RELATIONSHIP_TYPES: RelationshipType[] = [
  'NETWORK_FLOW', 'DATA_FLOW', 'ROUTES_TO', 'DEPENDS_ON', 'CONNECTS_TO',
  'DATABASE_CONNECTION', 'LOAD_BALANCES', 'SERVES', 'READS_FROM', 'WRITES_TO',
  'STORES_IN', 'TRIGGERS', 'AUTHENTICATES_WITH', 'RESOLVES_TO', 'CONTAINS',
  'ASSOCIATED_WITH', 'PEERS_WITH', 'REPLICATES_TO', 'LOGICAL_DEPENDENCY', 'UNKNOWN',
];

describe('Canvas save API schema', () => {
  it('accepts every real relationship type as an edgeType value', () => {
    for (const rel of ALL_RELATIONSHIP_TYPES) {
      const result = CanvasEdgeSchema.safeParse({ id: 'e1', source: 'a', target: 'b', edgeType: rel });
      expect(result.success).toBe(true);
    }
  });

  it('still accepts the legacy simple edgeType values', () => {
    for (const legacy of ['data', 'network', 'security', 'management']) {
      const result = CanvasEdgeSchema.safeParse({ id: 'e1', source: 'a', target: 'b', edgeType: legacy });
      expect(result.success).toBe(true);
    }
  });

  it('every template\'s generated edges pass the real save-canvas request schema', () => {
    for (const t of architectureTemplates) {
      const { nodes, edges } = t.generate({});
      const result = SaveCanvasSchema.safeParse({ env: 'production', nodes, edges, revision: 1 });
      if (!result.success) {
        throw new Error(`Template "${t.id}" edges fail SaveCanvasSchema: ${JSON.stringify(result.error.issues, null, 2)}`);
      }
    }
  });
});
