import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  toCanonicalGraph,
  fromCanonicalGraph,
  validateCanonicalArchitecture,
} from '@/lib/domain/canonicalArchitecture';
import { adaptiveScaleEngine } from '@/lib/engines/capacity/AdaptiveScaleEngine';
import { architectureAutoFixEngine } from '@/lib/engines/autofix/ArchitectureAutoFixEngine';
import { scaleAdvisorEngine } from '@/lib/engines/ai/ScaleAdvisorEngine';
import {
  CanvasNode,
  CanvasEdge,
  ScaleProfile,
  ProviderMode,
  providerModeToCloudProvider,
  cloudProviderToProviderMode,
} from '@/types';
import { calculateCosts, runSecurityScan, generateTerraform } from '@/lib/analysis';

describe('Core Canvas Workflow & Architecture Creation', () => {
  // ─── 1. Provider Mode & Blank Canvas ─────────────────────────────────────────
  describe('Cloud Selection & ProviderMode', () => {
    it('correctly maps between ProviderMode and CloudProvider', () => {
      expect(providerModeToCloudProvider('AWS')).toBe('aws');
      expect(providerModeToCloudProvider('AZURE')).toBe('azure');
      expect(providerModeToCloudProvider('MULTI_CLOUD')).toBe('multi');

      expect(cloudProviderToProviderMode('aws')).toBe('AWS');
      expect(cloudProviderToProviderMode('azure')).toBe('AZURE');
      expect(cloudProviderToProviderMode('multi')).toBe('MULTI_CLOUD');
    });

    it('enforces cloud compatibility in canonical architecture validation', () => {
      // AWS only mode with Azure resource should fail validation
      const mixedNodes: CanvasNode[] = [
        {
          id: 'aws-vpc',
          type: 'containerNode',
          resourceType: 'aws_vpc',
          provider: 'aws',
          label: 'AWS VPC',
          position: { x: 0, y: 0 },
          config: { cidrBlock: '10.0.0.0/16' },
        },
        {
          id: 'azure-vnet',
          type: 'containerNode',
          resourceType: 'azure_vnet',
          provider: 'azure',
          label: 'Azure VNet',
          position: { x: 500, y: 0 },
          config: { addressSpace: '10.1.0.0/16' },
        },
      ];

      const awsCanonical = toCanonicalGraph({
        id: 'test-aws',
        name: 'AWS Architecture',
        provider: 'aws',
        providerMode: 'AWS',
        nodes: mixedNodes,
        edges: [],
      });

      const awsReport = validateCanonicalArchitecture(awsCanonical);
      expect(awsReport.isValid).toBe(false);
      expect(awsReport.issues.some((i) => i.code === 'INVALID_CLOUD_PROVIDER_RESOURCE')).toBe(true);

      // Multi-Cloud mode with both AWS and Azure resources is completely valid
      const multiCanonical = toCanonicalGraph({
        id: 'test-multi',
        name: 'Multi-Cloud Architecture',
        provider: 'multi',
        providerMode: 'MULTI_CLOUD',
        nodes: mixedNodes,
        edges: [],
      });

      const multiReport = validateCanonicalArchitecture(multiCanonical);
      expect(multiReport.issues.some((i) => i.code === 'INVALID_CLOUD_PROVIDER_RESOURCE')).toBe(false);
    });
  });

  // ─── 2. Expected Users & Scale Profile ───────────────────────────────────────
  describe('Scale Profile & Workload Adaptation', () => {
    it('stores ScaleProfile in canonical model and serializes cleanly', () => {
      const scaleProfile: ScaleProfile = {
        expectedUsers: 50000,
        requestsPerSecond: 250,
        peakRequestsPerSecond: 750,
        availabilityTarget: 99.99,
        geographicDistribution: 'multi-region',
        dataGrowth: 'high',
        trafficPattern: 'weekend-spikes',
      };

      const nodes: CanvasNode[] = [
        {
          id: 'vpc-1',
          type: 'containerNode',
          resourceType: 'aws_vpc',
          provider: 'aws',
          label: 'Prod VPC',
          position: { x: 0, y: 0 },
          config: { cidrBlock: '10.0.0.0/16' },
        },
      ];

      const canonical = toCanonicalGraph({
        id: 'test-scale',
        name: 'Scaled System',
        provider: 'aws',
        providerMode: 'AWS',
        nodes,
        edges: [],
        scaleProfile,
      });

      expect(canonical.scaleProfile?.expectedUsers).toBe(50000);
      expect(canonical.scaleProfile?.availabilityTarget).toBe(99.99);
      expect(canonical.scaleProfile?.trafficPattern).toBe('weekend-spikes');

      const restored = fromCanonicalGraph(canonical);
      expect(restored.scaleProfile?.expectedUsers).toBe(50000);
      expect(restored.scaleProfile?.peakRequestsPerSecond).toBe(750);
    });

    it('adapts architecture capacity from 1,000 to 100,000 users without blind multiplication', () => {
      const baseNodes: CanvasNode[] = [
        {
          id: 'vpc-1',
          type: 'containerNode',
          resourceType: 'aws_vpc',
          provider: 'aws',
          label: 'VPC',
          position: { x: 0, y: 0 },
          config: { cidrBlock: '10.0.0.0/16' },
        },
        {
          id: 'sub-app',
          type: 'containerNode',
          resourceType: 'aws_subnet',
          provider: 'aws',
          label: 'App Subnet',
          parentId: 'vpc-1',
          groupId: 'vpc-1',
          position: { x: 50, y: 50 },
          config: { cidrBlock: '10.0.1.0/24' },
        },
        {
          id: 'ec2-1',
          type: 'cloudNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'App Server',
          parentId: 'sub-app',
          groupId: 'sub-app',
          position: { x: 100, y: 100 },
          config: { instanceType: 't3.micro' },
        },
        {
          id: 'rds-1',
          type: 'cloudNode',
          resourceType: 'aws_rds',
          provider: 'aws',
          label: 'Database',
          parentId: 'sub-app',
          groupId: 'sub-app',
          position: { x: 250, y: 100 },
          config: { instanceClass: 'db.t3.micro', multiAz: false, allocatedStorage: 20 },
        },
      ];

      // Adapt to 100,000 users
      const scale100k: ScaleProfile = {
        expectedUsers: 100000,
        requestsPerSecond: 600,
        peakRequestsPerSecond: 2000,
        availabilityTarget: 99.99,
        trafficPattern: 'steady',
      };

      const adapted = adaptiveScaleEngine.adaptArchitectureScale(baseNodes, [], scale100k);

      // Check compute scaling (instance upgraded)
      const ec2 = adapted.nodes.find((n) => n.id === 'ec2-1');
      expect(ec2).toBeDefined();
      expect(ec2?.config.instanceType).not.toBe('t3.micro');

      // Check database tier and Multi-AZ
      const rds = adapted.nodes.find((n) => n.id === 'rds-1');
      expect(rds).toBeDefined();
      expect(rds?.config.multiAz).toBe(true);
      expect((rds?.config.allocatedStorage as number) > 20).toBe(true);

      // Check caching / read replicas introduced where appropriate
      expect(adapted.nodes.length).toBeGreaterThanOrEqual(baseNodes.length);
    });
  });

  // ─── 3. Deterministic Auto-Fix Engine ────────────────────────────────────────
  describe('Deterministic Auto-Fix Engine', () => {
    it('repairs dangling edges, self-loops, and missing container hierarchy', () => {
      const brokenNodes: CanvasNode[] = [
        {
          id: 'ec2-orphan',
          type: 'cloudNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Orphaned EC2',
          position: { x: 100, y: 100 },
          config: { instanceType: 't3.small' },
          // Missing parentId and groupId!
        },
      ];

      const brokenEdges: CanvasEdge[] = [
        {
          id: 'edge-self',
          source: 'ec2-orphan',
          target: 'ec2-orphan', // self-connection
        },
        {
          id: 'edge-dangling',
          source: 'ec2-orphan',
          target: 'non-existent-node', // dangling
        },
      ];

      const fixResult = architectureAutoFixEngine.repairArchitecture(brokenNodes, brokenEdges);

      // Dangling and self-edges must be purged
      expect(fixResult.edges.length).toBe(0);

      // Orphaned EC2 must have VPC and Subnet containers generated for proper isolation
      const hasSubnet = fixResult.nodes.some((n) => n.resourceType === 'aws_subnet');
      const hasVpc = fixResult.nodes.some((n) => n.resourceType === 'aws_vpc');
      expect(hasSubnet).toBe(true);
      expect(hasVpc).toBe(true);

      const fixedEc2 = fixResult.nodes.find((n) => n.id === 'ec2-orphan');
      expect(fixedEc2?.groupId).toBeDefined();
    });

    it('resolves cross-cloud containment violations', () => {
      const crossCloudNodes: CanvasNode[] = [
        {
          id: 'aws-vpc-1',
          type: 'containerNode',
          resourceType: 'aws_vpc',
          provider: 'aws',
          label: 'AWS VPC',
          position: { x: 0, y: 0 },
          config: { cidrBlock: '10.0.0.0/16' },
        },
        {
          id: 'azure-vm-1',
          type: 'cloudNode',
          resourceType: 'azure_vm',
          provider: 'azure',
          label: 'Azure VM inside AWS VPC',
          parentId: 'aws-vpc-1', // Cross-cloud containment error!
          groupId: 'aws-vpc-1',
          position: { x: 50, y: 50 },
          config: {},
        },
      ];

      const fixResult = architectureAutoFixEngine.repairArchitecture(crossCloudNodes, []);

      // Azure VM must not be contained in AWS VPC
      const fixedVm = fixResult.nodes.find((n) => n.id === 'azure-vm-1');
      expect(fixedVm?.parentId).not.toBe('aws-vpc-1');
      expect(fixedVm?.groupId).not.toBe('aws-vpc-1');
    });
  });

  // ─── 4. AI-Assisted Scale Advisor ───────────────────────────────────────────
  describe('AI Scale Advisor with Authoritative Deterministic Validator', () => {
    it('interprets requirements into ScaleProfile and produces technically valid canonical graph', () => {
      const prompt = 'I am building an e-commerce application for 100,000 users with heavy weekend spikes.';
      const recommendation = scaleAdvisorEngine.interpretRequirements(prompt, 'aws');

      expect(recommendation.scaleProfile.expectedUsers).toBe(100000);
      expect(recommendation.scaleProfile.trafficPattern).toBe('weekend-spikes');
      expect(recommendation.nodes.length).toBeGreaterThan(0);

      // Deterministic validation must pass
      const canonical = toCanonicalGraph({
        id: 'ai-gen',
        name: 'E-commerce AI',
        provider: recommendation.suggestedProvider,
        nodes: recommendation.nodes,
        edges: recommendation.edges,
        scaleProfile: recommendation.scaleProfile,
      });

      const report = validateCanonicalArchitecture(canonical);
      expect(report.isValid).toBe(true);
      expect(report.criticalCount).toBe(0);
    });
  });

  // ─── 5. Live Draft Analysis Synchronization ─────────────────────────────────
  describe('Live Draft Analysis Synchronization', () => {
    it('runs Cost, Security, and Terraform directly on live draft nodes without saving', () => {
      const liveDraftNodes: CanvasNode[] = [
        {
          id: 'ec2-test',
          type: 'cloudNode',
          resourceType: 'aws_ec2',
          provider: 'aws',
          label: 'Web Server',
          position: { x: 100, y: 100 },
          config: { instanceType: 't3.medium' },
        },
        {
          id: 's3-test',
          type: 'cloudNode',
          resourceType: 'aws_s3',
          provider: 'aws',
          label: 'Static Assets',
          position: { x: 300, y: 100 },
          config: { encryption: true, versioning: false },
        },
      ];

      // Cost calculation
      const costs = calculateCosts(liveDraftNodes);
      expect(costs.length).toBe(2);
      const totalCost = costs.reduce((acc, c) => acc + c.monthlyCost, 0);
      expect(totalCost).toBeGreaterThan(0);

      // Security scan
      const securityIssues = runSecurityScan(liveDraftNodes);
      expect(Array.isArray(securityIssues)).toBe(true);

      // Terraform generation
      const tfCode = generateTerraform(liveDraftNodes, [], 'aws');
      expect(tfCode).toContain('resource "aws_instance"');
      expect(tfCode).toContain('resource "aws_s3_bucket"');
    });
  });
});
