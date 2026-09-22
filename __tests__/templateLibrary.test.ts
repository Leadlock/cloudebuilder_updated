/**
 * Automated template library validation (Phase 24 of the architecture/template
 * quality effort). Every template in the catalog — the parameterized
 * quick-start variations AND the hand-built reference architectures — must
 * pass these checks. This is what protects the library from regressing back
 * into "looks fine until someone actually opens it."
 */
import { architectureTemplates } from '@/lib/templates';
import { allReferenceArchitectures, awsReferenceArchitectures, azureReferenceArchitectures, multiCloudReferenceArchitectures } from '@/lib/templates/referenceArchitectures';
import { getResourceDefinition } from '@/lib/resources';
import { toCanonicalGraph, validateCanonicalArchitecture } from '@/lib/domain/canonicalArchitecture';
import { runSecurityScan, calculateCosts } from '@/lib/analysis';
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { CanvasNode, CanvasEdge } from '@/types';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';

function toDbResources(nodes: CanvasNode[]): DbArchitectureResource[] {
  return nodes.map((n) => ({
    id: n.id,
    architectureId: 'test-arch',
    resourceType: n.resourceType,
    provider: n.provider,
    label: n.label,
    positionX: n.position.x,
    positionY: n.position.y,
    configJson: JSON.stringify(n.config ?? {}),
    region: (n.config?.region as string) ?? null,
    groupId: n.groupId ?? null,
    locked: Boolean(n.locked),
  }));
}

function toDbConnections(edges: CanvasEdge[]): DbArchitectureConnection[] {
  return edges.map((e) => ({
    id: e.id,
    architectureId: 'test-arch',
    sourceId: e.source,
    targetId: e.target,
    label: e.label ?? null,
    edgeType: e.relationshipType ?? e.edgeType ?? null,
  }));
}

describe('Template library validation', () => {
  const allIds = architectureTemplates.map((t) => t.id);

  it('has no duplicate template IDs across the whole catalog', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of allIds) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    expect(dupes).toEqual([]);
  });

  it('every template has the required non-empty metadata fields', () => {
    for (const t of architectureTemplates) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(['aws', 'azure', 'multi']).toContain(t.provider);
      expect(t.category).toBeTruthy();
      expect(['simple', 'moderate', 'complex']).toContain(t.complexity);
      expect(typeof t.estimatedCost).toBe('number');
      expect(t.estimatedCost).toBeGreaterThanOrEqual(0);
      expect(typeof t.generate).toBe('function');
    }
  });

  it('every reference architecture declares provenance and pattern metadata', () => {
    for (const t of allReferenceArchitectures) {
      expect(t.isReferenceArchitecture).toBe(true);
      expect(t.architecturePattern).toBeTruthy();
      expect(t.useCases?.length ?? 0).toBeGreaterThan(0);
      expect(t.availabilityTarget).toBeTruthy();
      expect(t.dataFlowSummary).toBeTruthy();
      expect(t.sourceReferences?.length ?? 0).toBeGreaterThan(0);
    }
  });

  describe.each(architectureTemplates.map((t) => [t.id, t] as const))('%s', (_id, template) => {
    let generated: { nodes: CanvasNode[]; edges: CanvasEdge[] };

    beforeAll(() => {
      generated = template.generate({});
    });

    it('generates at least one resource', () => {
      expect(generated.nodes.length).toBeGreaterThan(0);
    });

    it('has no duplicate node IDs', () => {
      const ids = generated.nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('has no duplicate edge IDs', () => {
      const ids = generated.edges.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('has no dangling edges (every source/target refers to a real node)', () => {
      const nodeIds = new Set(generated.nodes.map((n) => n.id));
      for (const edge of generated.edges) {
        expect(nodeIds.has(edge.source)).toBe(true);
        expect(nodeIds.has(edge.target)).toBe(true);
      }
    });

    it('every node references a resource type that exists in the RDE', () => {
      for (const node of generated.nodes) {
        const def = getResourceDefinition(node.resourceType);
        expect(def).toBeDefined();
      }
    });

    it('every node with a groupId/parentId points at a real container node in the same graph', () => {
      const nodeIds = new Set(generated.nodes.map((n) => n.id));
      for (const node of generated.nodes) {
        if (node.groupId) expect(nodeIds.has(node.groupId)).toBe(true);
        if (node.parentId) expect(nodeIds.has(node.parentId)).toBe(true);
      }
    });

    it('passes canonical graph conversion and strict validation with no errors', () => {
      const canonical = toCanonicalGraph({
        id: template.id,
        name: template.name,
        provider: template.provider,
        nodes: generated.nodes,
        edges: generated.edges,
      });
      const validation = validateCanonicalArchitecture(canonical);
      if (!validation.isValid || validation.errors.length > 0) {
        // Surface the actual reasons in the failure output instead of just "false".
        throw new Error(`Canonical validation failed for "${template.id}":\n${JSON.stringify(validation.errors, null, 2)}`);
      }
      expect(validation.isValid).toBe(true);
    });

    it('runs the security engine without throwing', () => {
      expect(() => runSecurityScan(generated.nodes)).not.toThrow();
    });

    it('runs the cost engine without throwing and produces a non-negative total', () => {
      const items = calculateCosts(generated.nodes);
      const total = items.reduce((sum, i) => sum + i.monthlyCost, 0);
      expect(Number.isFinite(total)).toBe(true);
      expect(total).toBeGreaterThanOrEqual(0);
    });

    it('generates Terraform without throwing, for single-provider templates', () => {
      if (template.provider === 'multi') return; // cross-cloud Terraform (multiple provider blocks) is out of scope here
      const generator = new TerraformGenerator();
      const result = generator.generate({
        architectureId: 'test-arch',
        projectId: 'test-project',
        projectName: template.name,
        resources: toDbResources(generated.nodes),
        connections: toDbConnections(generated.edges),
      });
      expect(result.files.length).toBeGreaterThan(0);
      // Every generated file should contain actual HCL, not be empty.
      for (const file of result.files) {
        expect(file.content.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Reference architecture provider counts', () => {
    it('has at least one AWS, Azure, and Multi-Cloud reference architecture', () => {
      expect(awsReferenceArchitectures.length).toBeGreaterThan(0);
      expect(azureReferenceArchitectures.length).toBeGreaterThan(0);
      expect(multiCloudReferenceArchitectures.length).toBeGreaterThan(0);
    });

    it('every AWS reference architecture uses only aws_* resource types', () => {
      for (const t of awsReferenceArchitectures) {
        const { nodes } = t.generate({});
        for (const n of nodes) expect(n.resourceType.startsWith('aws_')).toBe(true);
      }
    });

    it('every Azure reference architecture uses only azure_* resource types', () => {
      for (const t of azureReferenceArchitectures) {
        const { nodes } = t.generate({});
        for (const n of nodes) expect(n.resourceType.startsWith('azure_')).toBe(true);
      }
    });

    it('every Multi-Cloud reference architecture uses both aws_* and azure_* resource types', () => {
      for (const t of multiCloudReferenceArchitectures) {
        const { nodes } = t.generate({});
        const providers = new Set(nodes.map((n) => n.provider));
        expect(providers.has('aws')).toBe(true);
        expect(providers.has('azure')).toBe(true);
      }
    });
  });
});
