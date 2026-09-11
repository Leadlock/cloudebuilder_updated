import { relationshipEngine } from '@/lib/engines/relationship/RelationshipEngine';
import { networkPathValidator } from '@/lib/engines/validation/NetworkPathValidator';
import { architectureValidator } from '@/lib/engines/validation/ArchitectureValidator';
import { capacityAnalysisEngine } from '@/lib/engines/capacity/CapacityAnalysisEngine';
import { TEMPLATES } from '@/lib/templates';
import { generateTerraform } from '@/lib/analysis';
import { CanvasNode, CanvasEdge } from '@/types';

function createTestNode(
  id: string,
  resourceType: string,
  label: string,
  provider: 'aws' | 'azure',
  config: Record<string, unknown> = {},
  groupId?: string
): CanvasNode {
  return {
    id,
    type: resourceType.includes('subnet') || resourceType.includes('vpc') || resourceType.includes('vnet') ? 'containerNode' : 'cloudNode',
    resourceType,
    label,
    provider,
    position: { x: 0, y: 0 },
    config,
    groupId,
  };
}

describe('Architecture Engine Hardening Suite', () => {
  describe('1. Centralized Relationship Engine Rules', () => {
    it('rejects Internet directly to private RDS', () => {
      const internetNode = createTestNode('node-inet', 'aws_internet', 'Internet', 'aws');
      const rdsNode = createTestNode('node-rds', 'aws_rds', 'App Database', 'aws');

      const result = relationshipEngine.validateConnection(internetNode, rdsNode, [internetNode, rdsNode]);
      expect(result.isValid).toBe(false);
      expect(result.error?.message).toMatch(/direct public internet routing to database instances is prohibited/i);
    });

    it('rejects ALB directly to RDS', () => {
      const albNode = createTestNode('node-alb', 'aws_alb', 'Application Load Balancer', 'aws');
      const rdsNode = createTestNode('node-rds', 'aws_rds', 'App Database', 'aws');

      const result = relationshipEngine.validateConnection(albNode, rdsNode, [albNode, rdsNode]);
      expect(result.isValid).toBe(false);
      expect(result.error?.message).toMatch(/application load balancers cannot forward requests directly to databases/i);
    });

    it('rejects self-connection', () => {
      const ec2Node = createTestNode('node-ec2', 'aws_ec2', 'Worker', 'aws');

      const result = relationshipEngine.validateConnection(ec2Node, ec2Node, [ec2Node]);
      expect(result.isValid).toBe(false);
      expect(result.error?.message).toMatch(/cannot connect a resource to itself/i);
    });

    it('rejects containment edges (VPC to Subnet)', () => {
      const vpcNode = createTestNode('vpc-1', 'aws_vpc', 'Production VPC', 'aws');
      const subnetNode = createTestNode('sub-1', 'aws_subnet', 'Public Subnet', 'aws', {}, 'vpc-1');

      const result = relationshipEngine.validateConnection(vpcNode, subnetNode, [vpcNode, subnetNode]);
      expect(result.isValid).toBe(false);
      expect(result.error?.message).toMatch(/container relationships should not be drawn as network traffic edges/i);
    });

    it('allows valid ALB -> EC2 connection with LOAD_BALANCES semantics', () => {
      const albNode = createTestNode('node-alb', 'aws_alb', 'ALB', 'aws');
      const ec2Node = createTestNode('node-ec2', 'aws_ec2', 'EC2 App Server', 'aws');

      const result = relationshipEngine.validateConnection(albNode, ec2Node, [albNode, ec2Node]);
      expect(result.isValid).toBe(true);
      expect(result.relationshipType).toBe('LOAD_BALANCES');
      expect(result.protocol).toBe('HTTP');
    });

    it('allows valid EC2 -> RDS connection with CONNECTS_TO semantics', () => {
      const ec2Node = createTestNode('node-ec2', 'aws_ec2', 'EC2 App Server', 'aws');
      const rdsNode = createTestNode('node-rds', 'aws_rds', 'PostgreSQL RDS', 'aws');

      const result = relationshipEngine.validateConnection(ec2Node, rdsNode, [ec2Node, rdsNode]);
      expect(result.isValid).toBe(true);
      expect(result.relationshipType).toBe('CONNECTS_TO');
      expect(result.port).toBe(5432);
    });

    it('allows EC2 -> S3 as API/service STORES_IN dependency', () => {
      const ec2Node = createTestNode('node-ec2', 'aws_ec2', 'EC2 App Server', 'aws');
      const s3Node = createTestNode('node-s3', 'aws_s3', 'Assets Bucket', 'aws');

      const result = relationshipEngine.validateConnection(ec2Node, s3Node, [ec2Node, s3Node]);
      expect(result.isValid).toBe(true);
      expect(result.relationshipType).toBe('STORES_IN');
    });
  });

  describe('2. Network Path Validation & Topology', () => {
    it('detects public subnet placement for databases as CRITICAL finding', () => {
      const nodes: CanvasNode[] = [
        createTestNode('sub-pub', 'aws_subnet', 'Public Subnet', 'aws', { mapPublicIpOnLaunch: true }),
        createTestNode('rds-1', 'aws_rds', 'App DB', 'aws', {}, 'sub-pub'),
      ];
      const report = networkPathValidator.validate(nodes, []);
      const dbFinding = report.findings.find(f => f.affectedNodeIds.includes('rds-1'));
      expect(dbFinding).toBeDefined();
      expect(dbFinding?.severity).toBe('critical');
      expect(dbFinding?.message).toMatch(/public subnet/i);
    });

    it('warns about cross-provider containment (AWS resource in Azure VNet)', () => {
      const nodes: CanvasNode[] = [
        createTestNode('vnet-1', 'azure_vnet', 'Azure VNet', 'azure'),
        createTestNode('ec2-1', 'aws_ec2', 'AWS EC2', 'aws', {}, 'vnet-1'),
      ];
      const report = architectureValidator.validate(nodes, []);
      const crossFinding = report.findings.find(f => f.pillar === 'cloud-correctness');
      expect(crossFinding).toBeDefined();
      expect(crossFinding?.severity).toBe('critical');
      expect(crossFinding?.title).toMatch(/illegal cross-provider containment/i);
    });
  });

  describe('3. SPOF Detection & Architecture Quality Score', () => {
    it('detects Single Point of Failure when single EC2 and non-multi-AZ RDS are deployed', () => {
      const nodes: CanvasNode[] = [
        createTestNode('ec2-solo', 'aws_ec2', 'App Server', 'aws'),
        createTestNode('rds-solo', 'aws_rds', 'Database', 'aws', { multiAz: false }),
      ];
      const edges: CanvasEdge[] = [
        { id: 'e1', source: 'ec2-solo', target: 'rds-solo', relationshipType: 'CONNECTS_TO' },
      ];

      const report = architectureValidator.validate(nodes, edges);
      const spofs = report.findings.filter(f => f.pillar === 'availability');
      expect(spofs.length).toBeGreaterThanOrEqual(2);
      expect(spofs.some(s => s.id.includes('single-compute'))).toBe(true);
      expect(spofs.some(s => s.id.includes('rds-no-multiaz'))).toBe(true);
      expect(report.score.reliability).toBeLessThan(75);
    });

    it('scores flagship 1,000-user AWS architecture > 90 with 0 critical SPOFs', () => {
      const template = TEMPLATES.find(t => t.id === 'aws-1000-user-production');
      expect(template).toBeDefined();

      if (template) {
        const gen = template.generate({});
        const report = architectureValidator.validate(gen.nodes, gen.edges);
        expect(report.score.overall).toBeGreaterThanOrEqual(90);
        const criticalFindings = report.findings.filter(s => s.severity === 'critical');
        expect(criticalFindings.length).toBe(0);
        expect(report.score.reliability).toBeGreaterThanOrEqual(85);
        expect(report.score.security).toBeGreaterThanOrEqual(85);
      }
    });

    it('scores flagship 1,000-user Azure architecture > 90 with 0 critical SPOFs', () => {
      const template = TEMPLATES.find(t => t.id === 'azure-1000-user-production');
      expect(template).toBeDefined();

      if (template) {
        const gen = template.generate({});
        const report = architectureValidator.validate(gen.nodes, gen.edges);
        expect(report.score.overall).toBeGreaterThanOrEqual(90);
        const criticalFindings = report.findings.filter(s => s.severity === 'critical');
        expect(criticalFindings.length).toBe(0);
        expect(report.score.reliability).toBeGreaterThanOrEqual(85);
      }
    });
  });

  describe('4. Capacity Analysis Engine (1,000-user Target)', () => {
    it('calculates 1,500+ capacity buffer for the flagship AWS production architecture', () => {
      const template = TEMPLATES.find(t => t.id === 'aws-1000-user-production');
      expect(template).toBeDefined();

      if (template) {
        const gen = template.generate({});
        const estimate = capacityAnalysisEngine.analyzeCapacity(gen.nodes, {
          targetConcurrentUsers: 1000,
          targetRequestsPerSec: 100,
          readWriteRatio: { read: 80, write: 20 },
          availabilityTarget: 99.99,
          environment: 'production',
          workloadType: 'web',
          expectedDataSizeGb: 100,
          storageRequirements: 'gp3 SSD',
          region: 'us-east-1',
        });

        expect(estimate.calculatedCapacityUsers).toBeGreaterThanOrEqual(1500);
        expect(estimate.isAdequate).toBe(true);
        expect(estimate.capacityBufferRatio).toBeGreaterThanOrEqual(1.5);
        expect(estimate.assumptions.length).toBeGreaterThan(0);
      }
    });

    it('identifies single instance as bottleneck for solo server architecture', () => {
      const soloNodes: CanvasNode[] = [
        createTestNode('ec2-1', 'aws_ec2', 'Single Server', 'aws'),
      ];
      const estimate = capacityAnalysisEngine.analyzeCapacity(soloNodes, {
        targetConcurrentUsers: 1000,
        targetRequestsPerSec: 100,
        readWriteRatio: { read: 80, write: 20 },
        availabilityTarget: 99.9,
        environment: 'production',
        workloadType: 'web',
        expectedDataSizeGb: 10,
        storageRequirements: 'gp3 SSD',
        region: 'us-east-1',
      });

      expect(estimate.isAdequate).toBe(false);
      expect(estimate.bottlenecks.some(b => b.toLowerCase().includes('compute') || b.toLowerCase().includes('caching'))).toBe(true);
    });
  });

  describe('5. Terraform Generation Consistency', () => {
    it('generates valid Terraform HCL without hardcoded aws_vpc.main.id references', () => {
      const template = TEMPLATES.find(t => t.id === 'aws-1000-user-production');
      expect(template).toBeDefined();

      if (template) {
        const gen = template.generate({});
        const terraformCode = generateTerraform(gen.nodes, gen.edges, 'aws');
        expect(terraformCode).toContain('provider "aws"');
        expect(terraformCode).toContain('aws_vpc');
        expect(terraformCode).toContain('aws_lb');
        expect(terraformCode).toContain('aws_db_instance');
        expect(terraformCode).toContain('multi_az            = true');
        expect(terraformCode).not.toContain('aws_vpc.main.id');
        expect(terraformCode).toContain('aws_vpc.production_vpc__10_0_0_0_16_.id');
      }
    });
  });
});
