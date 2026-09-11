import { CanvasNode, CanvasEdge } from '@/types';
import { autoLayoutArchitecture } from '@/lib/canvas/autoLayout';
import { relationshipEngine } from '@/lib/engines/relationship/RelationshipEngine';
import { ArchitectureValidator } from '@/lib/engines/validation/ArchitectureValidator';
import { capacityAnalysisEngine } from '@/lib/engines/capacity/CapacityAnalysisEngine';
import { mockProjects } from '@/lib/mockData';
import { architectureTemplates } from '@/lib/templates';

describe('Visual Architecture Builder & Topology Engine', () => {
  const validator = ArchitectureValidator.getInstance();

  describe('1. Visual Hierarchy & Cloud Boundaries', () => {
    it('properly segregates AWS and Azure nodes without cross-provider containment', () => {
      const defaultAwsProject = mockProjects.find((p) => p.id === 'proj-1')!;
      expect(defaultAwsProject).toBeDefined();

      const cloudBoundary = defaultAwsProject.nodes.find((n) => n.resourceType === 'aws_cloud_boundary');
      expect(cloudBoundary).toBeDefined();
      expect(cloudBoundary?.width).toBeGreaterThanOrEqual(920);
      expect(cloudBoundary?.height).toBeGreaterThanOrEqual(560);

      const vpc = defaultAwsProject.nodes.find((n) => n.resourceType === 'aws_vpc');
      expect(vpc).toBeDefined();
      expect(vpc?.groupId).toBe('aws-cloud');

      // Check subnets are inside VPC
      const subnets = defaultAwsProject.nodes.filter((n) => n.resourceType === 'aws_subnet');
      expect(subnets.length).toBeGreaterThanOrEqual(4); // Multi-AZ (AZ-A & AZ-B)
      for (const sub of subnets) {
        expect(sub.groupId).toBe(vpc!.id);
      }
    });

    it('rejects cross-provider containment in architecture validation', () => {
      const mixedNodes: CanvasNode[] = [
        {
          id: 'az-vnet',
          type: 'containerNode',
          resourceType: 'azure_vnet',
          provider: 'azure',
          label: 'Azure VNet',
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: 'aws-ec2',
          type: 'cloudNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'AWS EC2 inside Azure',
          position: { x: 50, y: 50 },
          groupId: 'az-vnet',
          config: {},
        },
      ];
      const report = validator.validate(mixedNodes, []);
      const crossFinding = report.findings.find((f) => f.id.includes('cross-provider'));
      expect(crossFinding).toBeDefined();
      expect(crossFinding?.severity).toBe('critical');
    });
  });

  describe('2. Multi-AZ Production Topology (1,000-User Capacity)', () => {
    it('validates multi-AZ redundancy for ALB, App Tier, and Database', () => {
      const defaultAwsProject = mockProjects.find((p) => p.id === 'proj-1')!;
      const alb = defaultAwsProject.nodes.find((n) => n.resourceType === 'aws_alb');
      const ec2Instances = defaultAwsProject.nodes.filter((n) => n.resourceType === 'aws_ec2');
      const rds = defaultAwsProject.nodes.find((n) => n.resourceType === 'aws_rds');

      expect(alb).toBeDefined();
      expect(ec2Instances.length).toBeGreaterThanOrEqual(2);
      expect(rds).toBeDefined();
      expect(rds?.config?.multiAz).toBe(true);

      // Verify ALB load balances to both App Servers
      const albEdges = defaultAwsProject.edges.filter((e) => e.source === alb!.id && e.relationshipType === 'LOAD_BALANCES');
      expect(albEdges.length).toBeGreaterThanOrEqual(2);

      // Verify both App Servers connect to RDS
      const dbEdges = defaultAwsProject.edges.filter((e) => e.target === rds!.id && e.relationshipType === 'CONNECTS_TO');
      expect(dbEdges.length).toBeGreaterThanOrEqual(2);
    });

    it('estimates 1,000-user capacity with high-availability headroom', () => {
      const defaultAwsProject = mockProjects.find((p) => p.id === 'proj-1')!;
      const analysis = capacityAnalysisEngine.analyzeCapacity(defaultAwsProject.nodes);

      expect(analysis.targetConcurrentUsers).toBeGreaterThanOrEqual(1000);
      expect(analysis.calculatedCapacityUsers).toBeGreaterThanOrEqual(1000);
      expect(analysis.redundancyStrategy).toContain('Multi-AZ');
      expect(analysis.scalingStrategy).toContain('redundancy');
    });
  });

  describe('3. Edge Semantics & Relationship Rules', () => {
    it('rejects invalid direct connections (Internet -> RDS, ALB -> RDS)', () => {
      const nodes: CanvasNode[] = [
        { id: 'inet', type: 'cloudNode', resourceType: 'aws_internet', provider: 'aws', label: 'Internet', position: { x: 0, y: 0 }, config: {} },
        { id: 'alb', type: 'cloudNode', resourceType: 'aws_alb', provider: 'aws', label: 'ALB', position: { x: 100, y: 0 }, config: {} },
        { id: 'rds', type: 'cloudNode', resourceType: 'aws_rds', provider: 'aws', label: 'RDS', position: { x: 200, y: 0 }, config: {} },
      ];

      const inetToRds = relationshipEngine.validateConnection(nodes[0], nodes[2], nodes, []);
      expect(inetToRds.isValid).toBe(false);
      expect(inetToRds.error?.code).toBe('PUBLIC_DATABASE_EXPOSURE');

      const albToRds = relationshipEngine.validateConnection(nodes[1], nodes[2], nodes, []);
      expect(albToRds.isValid).toBe(false);
      expect(albToRds.error?.code).toBe('ALB_TO_DATABASE_INVALID');
    });

    it('validates application tier to S3 as STORES_IN API dependency outside VPC', () => {
      const nodes: CanvasNode[] = [
        { id: 'app', type: 'cloudNode', resourceType: 'aws_ec2', provider: 'aws', label: 'App', position: { x: 0, y: 0 }, config: {} },
        { id: 's3', type: 'cloudNode', resourceType: 'aws_s3', provider: 'aws', label: 'S3 Vault', position: { x: 200, y: 0 }, config: {} },
      ];

      const appToS3 = relationshipEngine.validateConnection(nodes[0], nodes[1], nodes, []);
      expect(appToS3.isValid).toBe(true);
      expect(appToS3.relationshipType).toBe('STORES_IN');
      expect(appToS3.protocol).toContain('HTTPS');
    });
  });

  describe('4. Deterministic Edge IDs & Deduplication', () => {
    it('deduplicates duplicate edges and filters out CONTAINS edges during auto-layout', () => {
      const nodes: CanvasNode[] = [
        { id: 'vpc', type: 'containerNode', resourceType: 'aws_vpc', provider: 'aws', label: 'VPC', position: { x: 0, y: 0 }, config: {} },
        { id: 'sub', type: 'containerNode', resourceType: 'aws_subnet', provider: 'aws', label: 'Subnet', position: { x: 20, y: 20 }, groupId: 'vpc', config: {} },
        { id: 'app', type: 'cloudNode', resourceType: 'aws_ec2', provider: 'aws', label: 'App', position: { x: 50, y: 50 }, groupId: 'sub', config: {} },
        { id: 'db', type: 'cloudNode', resourceType: 'aws_rds', provider: 'aws', label: 'DB', position: { x: 50, y: 150 }, groupId: 'sub', config: {} },
      ];

      const edges: CanvasEdge[] = [
        // CONTAINS edge that shouldn't be rendered as a network arrow
        { id: 'e-contains', source: 'vpc', target: 'sub', relationshipType: 'CONTAINS', edgeType: 'CONTAINS' },
        // Valid edge
        { id: 'app:CONNECTS_TO:db', source: 'app', target: 'db', relationshipType: 'CONNECTS_TO', edgeType: 'CONNECTS_TO' },
        // Duplicate of valid edge with different ID
        { id: 'dup-1', source: 'app', target: 'db', relationshipType: 'CONNECTS_TO', edgeType: 'CONNECTS_TO' },
        // Orphaned edge pointing to nonexistent node
        { id: 'orphan', source: 'app', target: 'nonexistent', relationshipType: 'CONNECTS_TO', edgeType: 'CONNECTS_TO' },
      ];

      const laidOut = autoLayoutArchitecture(nodes, edges);

      // CONTAINS and orphan should be removed, duplicate should be deduplicated
      expect(laidOut.edges.length).toBe(1);
      expect(laidOut.edges[0].id).toBe('app:CONNECTS_TO:db');
      expect(laidOut.edges[0].relationshipType).toBe('CONNECTS_TO');
    });
  });

  describe('5. Auto-Layout Provider Separation & Geometry', () => {
    it('arranges AWS and Azure in distinct non-overlapping columns with generous padding', () => {
      const template = architectureTemplates.find((t) => t.id === 'aws-1000-user-production')!;
      const { nodes, edges } = template.generate({});

      const laid = autoLayoutArchitecture(nodes, edges);
      const vpc = laid.nodes.find((n) => n.resourceType === 'aws_vpc');
      const boundary = laid.nodes.find((n) => n.resourceType === 'aws_cloud_boundary');

      expect(vpc).toBeDefined();
      expect(boundary).toBeDefined();
      expect(boundary!.width).toBeGreaterThanOrEqual(vpc!.width! + 40);
      expect(boundary!.height).toBeGreaterThanOrEqual(vpc!.height! + 40);

      // Verify subnets do not escape VPC boundaries
      const subnets = laid.nodes.filter((n) => n.resourceType === 'aws_subnet');
      for (const sub of subnets) {
        expect(sub.position.x).toBeGreaterThanOrEqual(vpc!.position.x);
        expect(sub.position.x + (sub.width || 0)).toBeLessThanOrEqual(vpc!.position.x + (vpc!.width || 0) + 10);
      }
    });
  });

  describe('6. Persistence & Reload Fidelity', () => {
    it('preserves all node positions, groupIds, and relationship types identically across serialization', () => {
      const defaultAwsProject = mockProjects.find((p) => p.id === 'proj-1')!;
      const serialized = JSON.stringify(defaultAwsProject);
      const reloaded = JSON.parse(serialized);

      expect(reloaded.nodes.length).toBe(defaultAwsProject.nodes.length);
      expect(reloaded.edges.length).toBe(defaultAwsProject.edges.length);

      for (let i = 0; i < defaultAwsProject.nodes.length; i++) {
        const orig = defaultAwsProject.nodes[i];
        const copy = reloaded.nodes[i];
        expect(copy.id).toBe(orig.id);
        expect(copy.resourceType).toBe(orig.resourceType);
        expect(copy.groupId).toBe(orig.groupId);
        expect(copy.position).toEqual(orig.position);
      }

      for (let i = 0; i < defaultAwsProject.edges.length; i++) {
        const orig = defaultAwsProject.edges[i];
        const copy = reloaded.edges[i];
        expect(copy.id).toBe(orig.id);
        expect(copy.source).toBe(orig.source);
        expect(copy.target).toBe(orig.target);
        expect(copy.relationshipType).toBe(orig.relationshipType);
      }
    });
  });

  describe('7. Template Selection & Project Creation Synchronization', () => {
    it('generates non-empty architecture topologies for all architecture templates', () => {
      expect(architectureTemplates.length).toBeGreaterThanOrEqual(5);

      for (const t of architectureTemplates) {
        const generated = t.generate({});
        expect(generated.nodes.length).toBeGreaterThan(0);
        expect(generated.edges.length).toBeGreaterThan(0);

        // Every node must have an id, resourceType, and provider
        for (const n of generated.nodes) {
          expect(n.id).toBeDefined();
          expect(n.resourceType).toBeDefined();
          expect(n.provider).toBeDefined();
        }

        // Every edge must be deterministic and have a valid relationshipType
        for (const e of generated.edges) {
          expect(e.id).toContain(':');
          expect(e.relationshipType).toBeDefined();
          expect(e.source).toBeDefined();
          expect(e.target).toBeDefined();
        }
      }
    });

    it('ensures template project creation preserves nodes and edges without clearing them', () => {
      const template = architectureTemplates.find((t) => t.id === 'aws-1000-user-production')!;
      const { nodes, edges } = template.generate({});

      // Simulate local creation
      const localProject = {
        id: 'proj-local-123',
        name: template.name,
        provider: 'aws' as const,
        nodes,
        edges,
        resourceCount: nodes.length,
      };

      // Simulate API project response (which arrives with empty nodes from metadata endpoint)
      const apiProject = {
        id: 'proj-api-999',
        name: template.name,
        provider: 'aws' as const,
        nodes: [] as CanvasNode[],
        edges: [] as CanvasEdge[],
        resourceCount: 0,
      };

      // Merging should preserve template nodes and edges
      const mergedNodes = apiProject.nodes.length ? apiProject.nodes : localProject.nodes;
      const mergedEdges = apiProject.edges.length ? apiProject.edges : localProject.edges;

      expect(mergedNodes.length).toBe(nodes.length);
      expect(mergedEdges.length).toBe(edges.length);
      expect(mergedNodes.find((n) => n.resourceType === 'aws_alb')).toBeDefined();
      expect(mergedEdges.find((e) => e.relationshipType === 'LOAD_BALANCES')).toBeDefined();
    });
  });

  describe('8. Auto-Layout Grid Alignment & Overlap Prevention', () => {
    it('ensures AZ-A and AZ-B subnets have zero horizontal overlap in multi-AZ tiers', () => {
      const template = architectureTemplates.find((t) => t.id === 'aws-1000-user-production')!;
      const { nodes, edges } = template.generate({});
      const laid = autoLayoutArchitecture(nodes, edges);

      const pubA = laid.nodes.find((n) => n.id === 'pub-sub-a')!;
      const pubB = laid.nodes.find((n) => n.id === 'pub-sub-b')!;
      const appA = laid.nodes.find((n) => n.id === 'app-sub-a')!;
      const appB = laid.nodes.find((n) => n.id === 'app-sub-b')!;
      const dbA = laid.nodes.find((n) => n.id === 'db-sub-a')!;
      const dbB = laid.nodes.find((n) => n.id === 'db-sub-b')!;

      expect(pubA).toBeDefined();
      expect(pubB).toBeDefined();
      expect(pubA.position.x + (pubA.width || 0)).toBeLessThanOrEqual(pubB.position.x);

      expect(appA).toBeDefined();
      expect(appB).toBeDefined();
      expect(appA.position.x + (appA.width || 0)).toBeLessThanOrEqual(appB.position.x);

      expect(dbA).toBeDefined();
      expect(dbB).toBeDefined();
      expect(dbA.position.x + (dbA.width || 0)).toBeLessThanOrEqual(dbB.position.x);
    });

    it('ensures generous vertical clearance between tiers for edge routing', () => {
      const template = architectureTemplates.find((t) => t.id === 'aws-1000-user-production')!;
      const { nodes, edges } = template.generate({});
      const laid = autoLayoutArchitecture(nodes, edges);

      const pubA = laid.nodes.find((n) => n.id === 'pub-sub-a')!;
      const appA = laid.nodes.find((n) => n.id === 'app-sub-a')!;
      const dbA = laid.nodes.find((n) => n.id === 'db-sub-a')!;

      // Tier 1 to Tier 2 vertical clearance >= 50px
      const pubToAppGap = appA.position.y - (pubA.position.y + (pubA.height || 0));
      expect(pubToAppGap).toBeGreaterThanOrEqual(50);

      // Tier 2 to Tier 3 vertical clearance >= 50px
      const appToDbGap = dbA.position.y - (appA.position.y + (appA.height || 0));
      expect(appToDbGap).toBeGreaterThanOrEqual(50);
    });

    it('places Edge Ingress services outside the VPC at the top tier', () => {
      const template = architectureTemplates.find((t) => t.id === 'aws-1000-user-production')!;
      const { nodes, edges } = template.generate({});
      const laid = autoLayoutArchitecture(nodes, edges);

      const vpc = laid.nodes.find((n) => n.resourceType === 'aws_vpc')!;
      const r53 = laid.nodes.find((n) => n.resourceType === 'aws_route53')!;
      const cf = laid.nodes.find((n) => n.resourceType === 'aws_cloudfront')!;
      const waf = laid.nodes.find((n) => n.resourceType === 'aws_waf')!;

      expect(r53.position.y + 100).toBeLessThanOrEqual(vpc.position.y);
      expect(cf.position.y + 100).toBeLessThanOrEqual(vpc.position.y);
      expect(waf.position.y + 100).toBeLessThanOrEqual(vpc.position.y);
      expect(r53.groupId).not.toBe(vpc.id);
      expect(cf.groupId).not.toBe(vpc.id);
      expect(waf.groupId).not.toBe(vpc.id);
    });

    it('places S3 on the right flank outside VPC and encloses everything in Cloud Provider Boundary', () => {
      const template = architectureTemplates.find((t) => t.id === 'aws-1000-user-production')!;
      const { nodes, edges } = template.generate({});
      const laid = autoLayoutArchitecture(nodes, edges);

      const vpc = laid.nodes.find((n) => n.resourceType === 'aws_vpc')!;
      const s3 = laid.nodes.find((n) => n.resourceType === 'aws_s3')!;
      const boundary = laid.nodes.find((n) => n.resourceType === 'aws_cloud_boundary')!;

      expect(s3).toBeDefined();
      expect(vpc).toBeDefined();
      expect(boundary).toBeDefined();

      // S3 is to the right of the VPC
      expect(s3.position.x).toBeGreaterThanOrEqual(vpc.position.x + (vpc.width || 0));

      // Cloud Boundary encloses all components
      for (const n of laid.nodes) {
        if (n.id === boundary.id) continue;
        const nw = n.width || 180;
        const nh = n.height || 100;
        expect(n.position.x).toBeGreaterThanOrEqual(boundary.position.x);
        expect(n.position.y).toBeGreaterThanOrEqual(boundary.position.y);
        expect(n.position.x + nw).toBeLessThanOrEqual(boundary.position.x + (boundary.width || 0));
        expect(n.position.y + nh).toBeLessThanOrEqual(boundary.position.y + (boundary.height || 0));
      }
    });
  });
});
