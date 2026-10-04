import { applyLoadedCanvas } from '@/lib/domain/applyLoadedCanvas';
import type { Project, CanvasNode, CanvasEdge } from '@/types';

const env = (nodes: CanvasNode[] = []) => ({ id: 'production', label: 'Production', region: 'us-east-1', nodes, edges: [] as CanvasEdge[] });
const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'P', provider: 'aws', description: '', createdAt: '2026-01-01', updatedAt: '2026-01-02T00:00:00.000Z', nodes: [], edges: [], resourceCount: 0,
  securityScore: 0, securityScored: false, securityCoveragePct: null, architectureScore: 0, estimatedMonthlyCost: 0, environment: 'production', region: 'us-east-1',
  versions: [], tags: [], environments: { production: env(), staging: { ...env(), id: 'staging', label: 'Staging' }, development: { ...env(), id: 'development', label: 'Development' } },
  ...over,
} as unknown as Project);
const node = (id: string) => ({ id, type: 'cloudNode', resourceType: 'aws_ec2', label: id, provider: 'aws', position: { x: 0, y: 0 }, config: {} }) as unknown as CanvasNode;

// Stand-in for the app's real scoring: just enough to see that it ran.
const compute = (p: Project, nodes: CanvasNode[], edges: CanvasEdge[]): Project => ({
  ...p, nodes, edges, resourceCount: nodes.length, securityScore: 88, securityScored: true, estimatedMonthlyCost: nodes.length * 10, updatedAt: '2099-01-01T00:00:00.000Z',
});

describe('applyLoadedCanvas (dashboard cards fill in without opening each project)', () => {
  test('the viewed environment gets its resource count, scores and cost', () => {
    const out = applyLoadedCanvas(project(), 'production', 'production', [node('a'), node('b')], [], 7, compute);
    expect(out).toMatchObject({ resourceCount: 2, securityScore: 88, securityScored: true, estimatedMonthlyCost: 20, revision: 7 });
    expect(out.nodes).toHaveLength(2);
    expect(out.environments.production.nodes).toHaveLength(2);
  });

  test('loading is not an edit: the "last updated" time is kept', () => {
    expect(applyLoadedCanvas(project(), 'production', 'production', [node('a')], [], undefined, compute).updatedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  test('another environment is stored but does not change the project shown for the viewed one', () => {
    const out = applyLoadedCanvas(project(), 'staging', 'production', [node('a')], [], undefined, compute);
    expect(out.environments.staging.nodes).toHaveLength(1);
    expect(out.nodes).toEqual([]);
    expect(out.resourceCount).toBe(0);
  });

  test('other environments are left untouched', () => {
    const base = project({ environments: { ...project().environments, development: env([node('keep')]) } as Project['environments'] });
    const out = applyLoadedCanvas(base, 'production', 'production', [node('a')], [], undefined, compute);
    expect(out.environments.development.nodes.map((n) => n.id)).toEqual(['keep']);
  });

  test('a missing revision is not written as undefined over an existing one', () => {
    const out = applyLoadedCanvas(project({ revision: 3 } as Partial<Project>), 'production', 'production', [node('a')], [], undefined, compute);
    expect((out as unknown as { revision?: number }).revision).toBe(3);
  });
});
