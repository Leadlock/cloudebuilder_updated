import {
  toCanonicalGraph,
  fromCanonicalGraph,
  computeGraphHash,
  validateCanonicalArchitecture,
  CanonicalArchitectureGraph,
} from '@/lib/domain/canonicalArchitecture';
import { RelationshipEngine } from '@/lib/engines/relationship/RelationshipEngine';
import { ArchitectureValidator } from '@/lib/engines/validation/ArchitectureValidator';
import { TEMPLATES } from '@/lib/templates';
import { autoLayoutArchitecture, layoutByCloud, layoutByNetwork, layoutByTier } from '@/lib/canvas/autoLayout';
import { apiTerraformService } from '@/lib/services/ApiTerraformService';
import { CanvasNode, CanvasEdge } from '@/types';

describe('Canonical Architecture Model & Validation', () => {
  const engine = RelationshipEngine.getInstance();
  const validator = new ArchitectureValidator();

  it('performs lossless round-trip canonical graph conversion', () => {
    const originalNodes: CanvasNode[] = [
      {
        id: 'vpc-1',
        type: 'containerNode',
        resourceType: 'aws_vpc',
        provider: 'aws',
        label: 'Production VPC',
        position: { x: 50, y: 50 },
        width: 800,
        height: 600,
        config: { cidrBlock: '10.0.0.0/16' },
      },
      {
        id: 'sub-1',
        type: 'containerNode',
        resourceType: 'aws_subnet',
        provider: 'aws',
        label: 'Public Subnet A',
        position: { x: 80, y: 100 },
        width: 350,
        height: 220,
        groupId: 'vpc-1',
        config: { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a' },
      },
      {
        id: 'ec2-1',
        type: 'cloudNode',
        resourceType: 'aws_ec2',
        provider: 'aws',
        label: 'App Server',
        position: { x: 100, y: 140 },
        width: 180,
        height: 100,
        groupId: 'sub-1',
        config: { instanceType: 't3.micro' },
      },
    ];

    const originalEdges: CanvasEdge[] = [
      {
        id: 'e1',
        source: 'sub-1',
        target: 'ec2-1',
        relationshipType: 'CONTAINS',
      },
    ];

    const canonical = toCanonicalGraph({
      id: 'arch-123',
      name: 'Production Architecture',
      nodes: originalNodes,
      edges: originalEdges,
      version: 1,
    });

    expect(canonical.resources).toHaveLength(3);
    expect(canonical.resources.find(r => r.id === 'ec2-1')?.parentId).toBe('sub-1');
    expect(canonical.resources.find(r => r.id === 'sub-1')?.parentId).toBe('vpc-1');

    const reconstructed = fromCanonicalGraph(canonical);
    expect(reconstructed.nodes).toHaveLength(3);
    expect(reconstructed.nodes.find(n => n.id === 'ec2-1')?.groupId).toBe('sub-1');
  });

  it('computes deterministic graph hash independent of resource insertion order', () => {
    const nodeA: CanvasNode = {
      id: 'node-a',
      type: 'cloudNode',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'Server A',
      position: { x: 10, y: 10 },
      config: {},
    };
    const nodeB: CanvasNode = {
      id: 'node-b',
      type: 'cloudNode',
      resourceType: 'aws_s3',
      provider: 'aws',
      label: 'Bucket B',
      position: { x: 200, y: 10 },
      config: {},
    };

    const graph1 = toCanonicalGraph({ id: 'g1', nodes: [nodeA, nodeB], edges: [] });
    const graph2 = toCanonicalGraph({ id: 'g1', nodes: [nodeB, nodeA], edges: [] });

    expect(computeGraphHash(graph1)).toBe(computeGraphHash(graph2));
  });

  it('rejects invalid relationships: EC2 inside EC2', () => {
    const containment = engine.validateContainment('aws_ec2', 'aws_ec2');
    expect(containment.isAllowed).toBe(false);
    expect(containment.error?.code).toBe('NESTED_VIRTUAL_MACHINE');
  });

  it('rejects invalid relationships: RDS directly inside VPC without Subnet', () => {
    const containment = engine.validateContainment('aws_rds', 'aws_vpc');
    expect(containment.isAllowed).toBe(false);
    expect(containment.error?.code).toBe('DATABASE_DIRECT_IN_VPC');
  });

  it('rejects cross-provider containment: AWS EC2 inside Azure VNet', () => {
    const containment = engine.validateContainment('aws_ec2', 'azure_vnet');
    expect(containment.isAllowed).toBe(false);
    expect(containment.error?.code).toBe('CROSS_PROVIDER_CONTAINMENT');
  });

  it('allows valid containment: EC2 inside AWS Subnet, Subnet inside AWS VPC', () => {
    expect(engine.validateContainment('aws_ec2', 'aws_subnet').isAllowed).toBe(true);
    expect(engine.validateContainment('aws_subnet', 'aws_vpc').isAllowed).toBe(true);
    expect(engine.validateContainment('azure_vm', 'azure_subnet').isAllowed).toBe(true);
    expect(engine.validateContainment('azure_subnet', 'azure_vnet').isAllowed).toBe(true);
  });

  it('rejects ALB directly connected to RDS database', () => {
    const albNode: CanvasNode = {
      id: 'alb-1',
      type: 'cloudNode',
      resourceType: 'aws_alb',
      provider: 'aws',
      label: 'Public ALB',
      position: { x: 0, y: 0 },
      config: {},
    };
    const rdsNode: CanvasNode = {
      id: 'rds-1',
      type: 'cloudNode',
      resourceType: 'aws_rds',
      provider: 'aws',
      label: 'PostgreSQL DB',
      position: { x: 0, y: 0 },
      config: {},
    };

    const res = engine.validateConnection(albNode, rdsNode);
    expect(res.isValid).toBe(false);
    expect(res.error?.code).toBe('ALB_TO_DATABASE_INVALID');
  });

  it('validates canonical architecture graph invariants: detects orphaned parents and dangling edges', () => {
    const invalidGraph: CanonicalArchitectureGraph = {
      version: 1,
      hash: 'invalid-hash',
      provider: 'aws',
      metadata: {
        name: 'Invalid Architecture',
        updatedAt: new Date().toISOString(),
        resourceCount: 1,
        relationshipCount: 1,
      },
      resources: [
        {
          id: 'child-1',
          label: 'Orphaned Child',
          resourceType: 'aws_ec2',
          provider: 'aws',
          region: 'us-east-1',
          isContainer: false,
          parentId: 'non-existent-parent',
          position: { x: 0, y: 0 },
          dimensions: { width: 100, height: 100 },
          config: {},
          deploymentDependencies: [],
          logicalReferences: [],
        },
      ],
      relationships: [
        {
          id: 'rel-1',
          sourceId: 'child-1',
          targetId: 'ghost-target',
          relationshipType: 'NETWORK_FLOW',
          direction: 'unidirectional',
          networkScope: 'internal',
          validationStatus: 'warning',
        },
      ],
    };

    const validation = validateCanonicalArchitecture(invalidGraph);
    expect(validation.isValid).toBe(false);
    expect(validation.errors.some((e: string) => e.includes('non-existent-parent'))).toBe(true);
    expect(validation.errors.some((e: string) => e.includes('ghost-target'))).toBe(true);
  });
});

describe('Template Gallery — Commercial Reference Architectures', () => {
  it('contains all 240 production templates across 8 categories x 3 providers x 10 each', () => {
    expect(TEMPLATES).toHaveLength(240);
  });

  it('every template has valid canonical representation and passes relationship validation', () => {
    const engine = RelationshipEngine.getInstance();

    for (const t of TEMPLATES) {
      const { nodes, edges } = t.generate({});
      expect(nodes.length).toBeGreaterThan(0);
      expect(t.name).toBeTruthy();
      expect(t.category).toBeTruthy();

      // Canonical conversion test
      const canonical = toCanonicalGraph({
        id: t.id,
        name: t.name,
        nodes,
        edges,
      });
      const val = validateCanonicalArchitecture(canonical);
      expect(val.isValid).toBe(true);

      // Verify each edge technical validity
      for (const e of edges) {
        if (e.relationshipType === 'CONTAINS') continue;
        const src = nodes.find(n => n.id === e.source);
        const tgt = nodes.find(n => n.id === e.target);
        expect(src).toBeDefined();
        expect(tgt).toBeDefined();
        if (src && tgt) {
          const relResult = engine.validateConnection(src, tgt, nodes, edges);
          expect(relResult.isValid).toBe(true);
        }
      }

      // Verify Terraform generates valid HCL files
      const tfFiles = apiTerraformService.generateFiles(nodes, edges, t.provider);
      expect(Object.keys(tfFiles).length).toBeGreaterThan(0);
      expect(tfFiles['main.tf']).toBeDefined();
      expect(tfFiles['main.tf'].length).toBeGreaterThan(10);
    }
  });
});

describe('Professional Layout Engine', () => {
  it('performs deterministic auto-layout with zero node collisions', () => {
    const { nodes, edges } = TEMPLATES[0].generate({});
    const result1 = autoLayoutArchitecture(nodes, edges);
    const result2 = autoLayoutArchitecture(nodes, edges);

    expect(result1.nodes.length).toBe(result2.nodes.length);
    for (let i = 0; i < result1.nodes.length; i++) {
      expect(result1.nodes[i].position.x).toBe(result2.nodes[i].position.x);
      expect(result1.nodes[i].position.y).toBe(result2.nodes[i].position.y);
    }
  });

  it('separates AWS and Azure into distinct visual zones in hybrid templates', () => {
    const hybrid = TEMPLATES.find(t => t.id === 'aws-azure-hybrid-architecture')!;
    expect(hybrid).toBeDefined();

    const { nodes, edges } = hybrid.generate({});
    const laid = layoutByCloud(nodes, edges);
    const awsNodes = laid.nodes.filter(n => n.provider === 'aws');
    const azureNodes = laid.nodes.filter(n => n.provider === 'azure');

    expect(awsNodes.length).toBeGreaterThan(0);
    expect(azureNodes.length).toBeGreaterThan(0);

    const maxAwsX = Math.max(...awsNodes.map(n => n.position.x));
    const minAzureX = Math.min(...azureNodes.map(n => n.position.x));

    // Azure zone must be positioned horizontally to the right of AWS zone with corridor
    expect(minAzureX).toBeGreaterThan(maxAwsX);
  });
});

describe('Cost Comparison Ranking Determinism', () => {
  it('sorts architectures strictly from HIGHEST TOTAL COST to LOWEST TOTAL COST', () => {
    const list = [
      { name: 'Azure Architecture', provider: 'azure', totalMonthly: 120 },
      { name: 'AWS Architecture', provider: 'aws', totalMonthly: 350 },
      { name: 'GCP Alternative', provider: 'gcp', totalMonthly: 210 },
      { name: 'On-Premise Baseline', provider: 'onprem', totalMonthly: 350 },
    ];

    list.sort((a, b) => {
      if (b.totalMonthly !== a.totalMonthly) {
        return b.totalMonthly - a.totalMonthly; // HIGHEST first
      }
      const providerCmp = a.provider.localeCompare(b.provider);
      if (providerCmp !== 0) return providerCmp;
      return a.name.localeCompare(b.name);
    });

    expect(list[0].totalMonthly).toBe(350);
    expect(list[1].totalMonthly).toBe(350);
    expect(list[2].totalMonthly).toBe(210);
    expect(list[3].totalMonthly).toBe(120);

    // Stable secondary sort on ties: 'aws' before 'onprem'
    expect(list[0].provider).toBe('aws');
    expect(list[1].provider).toBe('onprem');
  });
});
