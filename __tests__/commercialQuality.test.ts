import { architectureAutoFixEngine } from '@/lib/engines/autofix/ArchitectureAutoFixEngine';
import { adaptiveScaleEngine } from '@/lib/engines/capacity/AdaptiveScaleEngine';
import { architectureTemplates } from '@/lib/templates';
import { toCanonicalGraph, validateCanonicalArchitecture, fromCanonicalGraph } from '@/lib/domain/canonicalArchitecture';
import { CanvasNode, CanvasEdge } from '@/types';

describe('CloudBuilder Commercial Quality & Enterprise Robustness', () => {
  describe('Template Catalog Integrity', () => {
    it('contains the parameterized 240-template catalog plus the hand-built reference architectures', () => {
      // 240 parameterized quick-start variations (lib/templates/catalogData.ts)
      // + 11 hand-built, structurally distinct reference architectures
      // (lib/templates/referenceArchitectures.ts) — see templateLibrary.test.ts
      // for the checks specific to the reference architectures themselves.
      expect(architectureTemplates.length).toBeGreaterThanOrEqual(251);

      const originalEightCategories = [
        'Web Applications',
        'High Availability',
        'SaaS',
        'E-Commerce',
        'Microservices',
        'Data & Analytics',
        'Disaster Recovery',
        'Multi-cloud',
      ];

      for (const cat of originalEightCategories) {
        const catTemplates = architectureTemplates.filter((t) => t.category === cat);
        // At least the original 30 (10 aws + 10 azure + 10 multi) from the
        // parameterized catalog; some categories now have additional
        // reference architectures on top of that baseline.
        expect(catTemplates.length).toBeGreaterThanOrEqual(30);

        const aws = catTemplates.filter((t) => t.provider === 'aws');
        const azure = catTemplates.filter((t) => t.provider === 'azure');
        const multi = catTemplates.filter((t) => t.provider === 'multi');

        expect(aws.length).toBeGreaterThanOrEqual(10);
        expect(azure.length).toBeGreaterThanOrEqual(10);
        expect(multi.length).toBeGreaterThanOrEqual(10);
      }
    });

    it('every template converts to a canonical graph and passes strict validation', () => {
      for (const t of architectureTemplates) {
        const { nodes, edges } = t.generate({});
        const canonical = toCanonicalGraph({
          id: t.id,
          name: t.name,
          provider: t.provider,
          nodes,
          edges,
        });

        const validation = validateCanonicalArchitecture(canonical);
        expect(validation.isValid).toBe(true);
        expect(validation.errors).toHaveLength(0);
      }
    });
  });

  describe('Auto-Fix Deterministic Multi-Pass Repair Engine', () => {
    it('repairs dangling edges automatically', () => {
      const nodes: CanvasNode[] = [
        { id: 'vpc-1', type: 'containerNode', resourceType: 'aws_vpc', provider: 'aws', label: 'VPC', position: { x: 0, y: 0 }, config: {} },
        { id: 'sub-1', type: 'containerNode', resourceType: 'aws_subnet', provider: 'aws', label: 'Subnet', position: { x: 50, y: 50 }, groupId: 'vpc-1', config: {} },
        { id: 'ec2-1', type: 'cloudNode', resourceType: 'aws_ec2', provider: 'aws', label: 'App Server', position: { x: 80, y: 80 }, groupId: 'sub-1', config: {} },
      ];
      const edges: CanvasEdge[] = [
        { id: 'e1', source: 'ec2-1', target: 'deleted-node-999', edgeType: 'network' },
        { id: 'e2', source: 'deleted-node-888', target: 'ec2-1', edgeType: 'network' },
      ];

      const repair = architectureAutoFixEngine.repairArchitecture(nodes, edges);
      expect(repair.changesApplied.length).toBeGreaterThan(0);
      expect(repair.edges).toHaveLength(0);
      expect(repair.changesApplied.some((r) => r.includes('dangling edge'))).toBe(true);
      expect(repair.isValid).toBe(true);
    });

    it('repairs orphaned resources with non-existent groupId parent pointers', () => {
      const nodes: CanvasNode[] = [
        { id: 'vpc-1', type: 'containerNode', resourceType: 'aws_vpc', provider: 'aws', label: 'VPC', position: { x: 0, y: 0 }, config: {} },
        { id: 'sub-1', type: 'containerNode', resourceType: 'aws_subnet', provider: 'aws', label: 'Subnet', position: { x: 50, y: 50 }, groupId: 'deleted-vpc-parent', config: {} },
        { id: 'ec2-1', type: 'cloudNode', resourceType: 'aws_ec2', provider: 'aws', label: 'App Server', position: { x: 80, y: 80 }, groupId: 'sub-1', config: {} },
      ];

      const repair = architectureAutoFixEngine.repairArchitecture(nodes, []);
      expect(repair.changesApplied.length).toBeGreaterThan(0);
      const repairedSub = repair.nodes.find((n) => n.id === 'sub-1');
      expect(repairedSub?.groupId).toBe('vpc-1');
      expect(repair.isValid).toBe(true);
    });

    it('synthesizes missing database subnet for naked uncontained RDS instance', () => {
      const nodes: CanvasNode[] = [
        { id: 'vpc-1', type: 'containerNode', resourceType: 'aws_vpc', provider: 'aws', label: 'VPC', position: { x: 0, y: 0 }, config: {} },
        { id: 'rds-1', type: 'cloudNode', resourceType: 'aws_rds', provider: 'aws', label: 'Postgres DB', position: { x: 80, y: 80 }, config: {} },
      ];

      const repair = architectureAutoFixEngine.repairArchitecture(nodes, []);
      expect(repair.changesApplied.length).toBeGreaterThan(0);
      const rds = repair.nodes.find((n) => n.id === 'rds-1');
      expect(rds?.groupId).toBeDefined();

      const parentSubnet = repair.nodes.find((n) => n.id === rds?.groupId);
      expect(parentSubnet?.resourceType).toBe('aws_subnet');
      expect(parentSubnet?.groupId).toBe('vpc-1');
      expect(repair.isValid).toBe(true);
    });

    it('repairs cross-cloud containment into valid cross-cloud connection', () => {
      const nodes: CanvasNode[] = [
        { id: 'az-vnet', type: 'containerNode', resourceType: 'azure_vnet', provider: 'azure', label: 'Azure VNet', position: { x: 0, y: 0 }, config: {} },
        { id: 'az-sub', type: 'containerNode', resourceType: 'azure_subnet', provider: 'azure', label: 'Azure Subnet', position: { x: 50, y: 50 }, groupId: 'az-vnet', config: {} },
        { id: 'ec2-1', type: 'cloudNode', resourceType: 'aws_ec2', provider: 'aws', label: 'AWS EC2', position: { x: 80, y: 80 }, groupId: 'az-sub', config: {} },
      ];

      const repair = architectureAutoFixEngine.repairArchitecture(nodes, []);
      expect(repair.changesApplied.length).toBeGreaterThan(0);
      const ec2 = repair.nodes.find((n) => n.id === 'ec2-1');
      expect(ec2?.groupId).not.toBe('az-sub');
      expect(repair.changesApplied.some((r) => r.includes('cross-cloud containment'))).toBe(true);
      expect(repair.isValid).toBe(true);
    });

    it('removes duplicate edges and self-connections', () => {
      const nodes: CanvasNode[] = [
        { id: 'vpc-1', type: 'containerNode', resourceType: 'aws_vpc', provider: 'aws', label: 'VPC', position: { x: 0, y: 0 }, config: {} },
        { id: 'sub-1', type: 'containerNode', resourceType: 'aws_subnet', provider: 'aws', label: 'Subnet', position: { x: 50, y: 50 }, groupId: 'vpc-1', config: {} },
        { id: 'ec2-1', type: 'cloudNode', resourceType: 'aws_ec2', provider: 'aws', label: 'EC2', position: { x: 80, y: 80 }, groupId: 'sub-1', config: {} },
        { id: 'rds-1', type: 'cloudNode', resourceType: 'aws_rds', provider: 'aws', label: 'RDS', position: { x: 280, y: 80 }, groupId: 'sub-1', config: {} },
      ];
      const edges: CanvasEdge[] = [
        { id: 'self-1', source: 'ec2-1', target: 'ec2-1', edgeType: 'network' },
        { id: 'dup-1', source: 'ec2-1', target: 'rds-1', edgeType: 'network', relationshipType: 'CONNECTS_TO' },
        { id: 'dup-2', source: 'ec2-1', target: 'rds-1', edgeType: 'network', relationshipType: 'CONNECTS_TO' },
      ];

      const repair = architectureAutoFixEngine.repairArchitecture(nodes, edges);
      expect(repair.changesApplied.length).toBeGreaterThan(0);
      expect(repair.edges).toHaveLength(1);
      expect(repair.edges[0].source).toBe('ec2-1');
      expect(repair.edges[0].target).toBe('rds-1');
      expect(repair.isValid).toBe(true);
    });
  });

  describe('Adaptive User Scale Engine', () => {
    it('scales AWS compute, database, caching, and WAF proportionally across scale tiers', () => {
      const baseTemplate = architectureTemplates.find((t) => t.id === 'web-applications-aws-01')!;
      const { nodes, edges } = baseTemplate.generate({});

      // Scale 100 users
      const scale100 = adaptiveScaleEngine.adaptArchitectureScale(nodes, edges, { expectedUsers: 100 });
      const ec2_100 = scale100.nodes.find((n) => n.resourceType === 'aws_ec2');
      const rds_100 = scale100.nodes.find((n) => n.resourceType === 'aws_rds');
      expect(ec2_100?.config.instanceType).toBe('t4g.small');
      expect(rds_100?.config.instanceClass).toBe('db.t4g.micro');
      expect(rds_100?.config.multiAz).toBe(false);

      // Scale 10,000 users (HA + Caching)
      const scale10k = adaptiveScaleEngine.adaptArchitectureScale(nodes, edges, { expectedUsers: 10000 });
      const ec2_10k = scale10k.nodes.find((n) => n.resourceType === 'aws_ec2');
      const rds_10k = scale10k.nodes.find((n) => n.resourceType === 'aws_rds');
      const cache_10k = scale10k.nodes.find((n) => n.resourceType === 'aws_elasticache');
      expect(ec2_10k?.config.instanceType).toBe('c6g.xlarge');
      expect(rds_10k?.config.instanceClass).toBe('db.r6g.xlarge');
      expect(rds_10k?.config.multiAz).toBe(true);
      expect(cache_10k).toBeDefined();

      // Scale 1,000,000 users (Enterprise Tier)
      const scale1m = adaptiveScaleEngine.adaptArchitectureScale(nodes, edges, { expectedUsers: 1000000 });
      const ec2_1m = scale1m.nodes.find((n) => n.resourceType === 'aws_ec2');
      const rds_1m = scale1m.nodes.find((n) => n.resourceType === 'aws_rds');
      const waf_1m = scale1m.nodes.find((n) => n.resourceType === 'aws_waf');
      expect(ec2_1m?.config.instanceType).toBe('c6g.4xlarge');
      expect(rds_1m?.config.instanceClass).toBe('db.r6g.4xlarge');
      expect(rds_1m?.config.readReplicas).toBe(4);
      expect(waf_1m).toBeDefined();
    });

    it('scales Azure compute and database appropriately across scale tiers', () => {
      const baseTemplate = architectureTemplates.find((t) => t.id === 'web-applications-azure-01')!;
      const { nodes, edges } = baseTemplate.generate({});

      // Scale 500 users
      const scale500 = adaptiveScaleEngine.adaptArchitectureScale(nodes, edges, { expectedUsers: 500 });
      const vm_500 = scale500.nodes.find((n) => n.resourceType === 'azure_vm');
      const sql_500 = scale500.nodes.find((n) => n.resourceType === 'azure_sql');
      // config.size / config.tier are the RDE's actual field names for
      // azure_vm/azure_sql (see lib/resources/azure.ts and
      // TerraformGenerator._vm/_sql, which read cfg['size']/cfg['tier']).
      // The engine previously wrote to config.vmSize/config.sku instead —
      // values nothing in the product ever read — so scale changes never
      // reached the stored config, the Properties Panel, or Terraform
      // generation. This test was pinned to that dead-key bug; corrected
      // to assert on the keys the rest of the system actually consumes.
      expect(vm_500?.config.size).toBe('Standard_B2s');
      expect(sql_500?.config.tier).toBe('GP_Gen5_2');

      // Scale 100,000 users
      const scale100k = adaptiveScaleEngine.adaptArchitectureScale(nodes, edges, { expectedUsers: 100000 });
      const vm_100k = scale100k.nodes.find((n) => n.resourceType === 'azure_vm');
      const sql_100k = scale100k.nodes.find((n) => n.resourceType === 'azure_sql');
      const redis_100k = scale100k.nodes.find((n) => n.resourceType === 'azure_redis');
      expect(vm_100k?.config.size).toBe('Standard_D8s_v5');
      expect(sql_100k?.config.tier).toBe('BC_Gen5_16');
      expect(sql_100k?.config.zoneRedundant).toBe(true);
      expect(redis_100k).toBeDefined();
    });
  });

  describe('Save / Reload Canonical Graph Equivalence', () => {
    it('preserves resources, relationships, scale profile, and IDs identically', () => {
      const template = architectureTemplates[0];
      const { nodes, edges } = template.generate({});

      const originalCanonical = toCanonicalGraph({
        id: 'test-project-save-load',
        name: 'Production System',
        provider: template.provider,
        nodes,
        edges,
        scaleProfile: {
          expectedUsers: 50000,
          requestsPerSecond: 1200,
          peakRequestsPerSecond: 3600,
          availabilityTarget: '99.99%',
          geographicDistribution: 'multi-region',
          dataGrowth: '1TB/month',
          trafficPattern: 'steady-with-spikes',
        },
      });

      // Serialized representation (like DB JSON column)
      const serialized = JSON.stringify(originalCanonical);
      const parsedCanonical = JSON.parse(serialized);

      // Convert back to canvas
      const rehydratedCanvas = fromCanonicalGraph(parsedCanonical);
      const roundTripCanonical = toCanonicalGraph({
        id: parsedCanonical.projectId,
        name: parsedCanonical.metadata.name,
        provider: parsedCanonical.provider,
        nodes: rehydratedCanvas.nodes,
        edges: rehydratedCanvas.edges,
        scaleProfile: parsedCanonical.scaleProfile,
      });

      expect(roundTripCanonical.resources.length).toBe(originalCanonical.resources.length);
      expect(roundTripCanonical.relationships.length).toBe(originalCanonical.relationships.length);
      expect(roundTripCanonical.scaleProfile).toEqual(originalCanonical.scaleProfile);
      expect(roundTripCanonical.hash).toBe(originalCanonical.hash);
    });
  });

  describe('High Resource Scale Stress Test (250 Resources)', () => {
    it('validates, repairs, scales, and computes canonical hash efficiently for 250 resources', () => {
      const nodes: CanvasNode[] = [
        { id: 'stress-vpc', type: 'containerNode', resourceType: 'aws_vpc', provider: 'aws', label: 'Stress VPC', position: { x: 0, y: 0 }, config: {} },
        { id: 'stress-sub-app', type: 'containerNode', resourceType: 'aws_subnet', provider: 'aws', label: 'App Subnet', position: { x: 50, y: 50 }, groupId: 'stress-vpc', config: {} },
        { id: 'stress-sub-db', type: 'containerNode', resourceType: 'aws_subnet', provider: 'aws', label: 'DB Subnet', position: { x: 50, y: 350 }, groupId: 'stress-vpc', config: {} },
      ];

      const edges: CanvasEdge[] = [];

      // Generate 247 compute and database resources
      for (let i = 0; i < 200; i++) {
        const id = `stress-ec2-${i}`;
        nodes.push({
          id,
          type: 'cloudNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: `Worker ${i}`,
          position: { x: 100 + (i % 10) * 80, y: 100 + Math.floor(i / 10) * 60 },
          groupId: 'stress-sub-app',
          config: {},
        });
      }

      for (let i = 0; i < 47; i++) {
        const id = `stress-rds-${i}`;
        nodes.push({
          id,
          type: 'cloudNode',
          resourceType: 'aws_rds',
          provider: 'aws',
          label: `Database ${i}`,
          position: { x: 100 + (i % 5) * 100, y: 400 + Math.floor(i / 5) * 70 },
          groupId: 'stress-sub-db',
          config: {},
        });
        edges.push({
          id: `stress-edge-${i}`,
          source: `stress-ec2-${i}`,
          target: id,
          edgeType: 'network',
          relationshipType: 'CONNECTS_TO',
        });
      }

      expect(nodes.length).toBe(250);

      const startTime = Date.now();
      const canonical = toCanonicalGraph({
        id: 'stress-250',
        name: 'Stress Test 250',
        provider: 'aws',
        nodes,
        edges,
      });

      const val = validateCanonicalArchitecture(canonical);
      const durationMs = Date.now() - startTime;

      expect(val.isValid).toBe(true);
      expect(durationMs).toBeLessThan(1000); // Must be under 1 second for 250 resources
    });
  });
});
