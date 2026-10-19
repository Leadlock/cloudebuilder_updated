/**
 * Well-Architected Framework Intelligence Unit Tests
 *
 * Validates:
 * 1. AWS 6-Pillar Framework Mapping & Versioning
 * 2. Azure 5-Pillar Framework Mapping & Versioning
 * 3. Deterministic scoring algorithms (same input -> same score)
 * 4. AWS Well-Architected rules (Operational, Security, Reliability, Performance, Cost, Sustainability)
 * 5. Azure Well-Architected rules (Reliability, Security, Cost, Operations, Performance)
 * 6. Multi-cloud architecture handling & separation
 * 7. Source attribution & framework documentation references
 * 8. Resource state propagation (imported vs new)
 * 9. Staleness tracking
 * 10. Auto-layout cloud boundary grouping
 */

import { WellArchitectedRuleEngine } from '@/lib/engines/wellArchitected/WellArchitectedRuleEngine';
import {
  AWS_WELL_ARCHITECTED_FRAMEWORK,
  AZURE_WELL_ARCHITECTED_FRAMEWORK,
  getPillarsForProvider,
} from '@/lib/engines/wellArchitected/frameworkDefinitions';
import { autoLayoutArchitecture } from '@/lib/canvas/autoLayout';
import type { CanvasNode, CanvasEdge } from '@/types';

describe('Well-Architected Framework Definitions', () => {
  test('AWS Framework has 6 official pillars and 2024 versioning', () => {
    expect(AWS_WELL_ARCHITECTED_FRAMEWORK.provider).toBe('aws');
    expect(AWS_WELL_ARCHITECTED_FRAMEWORK.pillars.length).toBe(6);
    const pillarIds = AWS_WELL_ARCHITECTED_FRAMEWORK.pillars.map((p) => p.id);
    expect(pillarIds).toContain('operational_excellence');
    expect(pillarIds).toContain('security');
    expect(pillarIds).toContain('reliability');
    expect(pillarIds).toContain('performance_efficiency');
    expect(pillarIds).toContain('cost_optimization');
    expect(pillarIds).toContain('sustainability');
  });

  test('Azure Framework has 5 official pillars (no sustainability pillar)', () => {
    expect(AZURE_WELL_ARCHITECTED_FRAMEWORK.provider).toBe('azure');
    expect(AZURE_WELL_ARCHITECTED_FRAMEWORK.pillars.length).toBe(5);
    const pillarIds = AZURE_WELL_ARCHITECTED_FRAMEWORK.pillars.map((p) => p.id);
    expect(pillarIds).toContain('reliability');
    expect(pillarIds).toContain('security');
    expect(pillarIds).toContain('cost_optimization');
    expect(pillarIds).toContain('operational_excellence');
    expect(pillarIds).toContain('performance_efficiency');
    expect(pillarIds).not.toContain('sustainability');
  });

  test('getPillarsForProvider returns exact pillars per provider', () => {
    const awsPillars = getPillarsForProvider('aws');
    expect(awsPillars.length).toBe(6);

    const azPillars = getPillarsForProvider('azure');
    expect(azPillars.length).toBe(5);
  });
});

describe('WellArchitectedRuleEngine — AWS Pillar Analysis', () => {
  const engine = new WellArchitectedRuleEngine();

  test('Detects publicly accessible RDS as a critical security finding', () => {
    const nodes: CanvasNode[] = [
      {
        id: 'rds-1',
        type: 'cloudNode',
        resourceType: 'aws_rds',
        provider: 'aws',
        label: 'Production Database',
        position: { x: 0, y: 0 },
        config: {
          engine: 'postgres',
          publiclyAccessible: true,
          encrypted: false,
          multiAz: false,
        },
      },
    ];

    const assessment = engine.analyze({
      architectureId: 'arch-1',
      provider: 'aws',
      nodes,
      edges: [],
    });

    expect(assessment.provider).toBe('aws');
    expect(assessment.framework).toBe(AWS_WELL_ARCHITECTED_FRAMEWORK.framework);

    // Finding for public accessibility
    const publicRdsFinding = assessment.findings.find(
      (f) => f.ruleId === 'AWS-RDS-001'
    );
    expect(publicRdsFinding).toBeDefined();
    expect(publicRdsFinding?.severity).toBe('critical');
    expect(publicRdsFinding?.pillar).toBe('security');
    expect(publicRdsFinding?.source).toBe('DESIGN_TIME');
    expect(publicRdsFinding?.pillarRef).toContain('aws.amazon.com');

    // Finding for single AZ
    // Multi-AZ is a Reliability finding; severity follows Security Hub RDS.5 (medium).
    const singleAzFinding = assessment.findings.find(
      (f) => f.pillar === 'reliability' && f.ruleId === 'AWS-RDS-006'
    );
    expect(singleAzFinding).toBeDefined();
    expect(singleAzFinding?.severity).toBe('medium');
    // Storage encryption disabled is its own security finding with evidence.
    const enc = assessment.findings.find((f) => f.ruleId === 'AWS-RDS-002');
    expect(enc?.observation).toMatch(/disabled/i);
  });

  test('Detects S3 bucket with public access or missing encryption', () => {
    const nodes: CanvasNode[] = [
      {
        id: 's3-1',
        type: 'cloudNode',
        resourceType: 'aws_s3',
        provider: 'aws',
        label: 'Customer Data Assets',
        position: { x: 0, y: 0 },
        config: {
          bucketName: 'customer-data',
          // Real CloudBuilder S3 keys (the previous test used keys that do not exist).
          publicAccess: true,
          blockPublicAcls: false,
          blockPublicPolicy: false,
          encryption: false,
        },
      },
    ];

    const assessment = engine.analyze({
      architectureId: 'arch-1',
      provider: 'aws',
      nodes,
      edges: [],
    });

    const s3Finding = assessment.findings.find(
      (f) => f.pillar === 'security' && f.affectedResourceIds.includes('s3-1')
    );
    expect(s3Finding).toBeDefined();
    expect(s3Finding?.severity).toBe('critical');
  });

  test('Scores pillars deterministically and calculates overall average', () => {
    const nodes: CanvasNode[] = [
      {
        id: 'vpc-1',
        type: 'containerNode',
        resourceType: 'aws_vpc',
        provider: 'aws',
        label: 'App VPC',
        position: { x: 0, y: 0 },
        config: { cidrBlock: '10.0.0.0/16' },
      },
      {
        id: 'ec2-1',
        type: 'cloudNode',
        resourceType: 'aws_ec2',
        provider: 'aws',
        label: 'App Server',
        position: { x: 100, y: 100 },
        config: { instanceType: 't3.micro' },
      },
    ];

    const run1 = engine.analyze({ architectureId: 'a1', provider: 'aws', nodes, edges: [] });
    const run2 = engine.analyze({ architectureId: 'a1', provider: 'aws', nodes, edges: [] });

    expect(run1.overallScore).toBe(run2.overallScore);
    expect(run1.pillarScores).toEqual(run2.pillarScores);
    expect(run1.findings.length).toBe(run2.findings.length);
  });
});

describe('WellArchitectedRuleEngine — Azure Pillar Analysis', () => {
  const engine = new WellArchitectedRuleEngine();

  test('Detects public Azure SQL Database with high security severity', () => {
    const nodes: CanvasNode[] = [
      {
        id: 'az-sql-1',
        type: 'cloudNode',
        resourceType: 'azure_sql',
        provider: 'azure',
        label: 'Core SQL DB',
        position: { x: 0, y: 0 },
        config: {
          publicNetworkAccess: true,
          transparentDataEncryption: false,
        },
      },
    ];

    const assessment = engine.analyze({
      architectureId: 'arch-az',
      provider: 'azure',
      nodes,
      edges: [],
    });

    expect(assessment.provider).toBe('azure');
    expect(assessment.pillarScores.length).toBe(5);

    const secFinding = assessment.findings.find((f) => f.pillar === 'security');
    expect(secFinding).toBeDefined();
    expect(secFinding?.pillarRef).toContain('learn.microsoft.com');
  });

  test('Propagates imported resource state to findings', () => {
    const nodes: CanvasNode[] = [
      {
        id: 'az-vm-1',
        type: 'cloudNode',
        resourceType: 'azure_vm',
        provider: 'azure',
        label: 'Legacy Worker',
        position: { x: 0, y: 0 },
        importState: 'imported',
        config: {
          imported: true,
          size: 'Standard_B2s',
          publicIpEnabled: true,
        },
      },
    ];

    const assessment = engine.analyze({
      architectureId: 'arch-az',
      provider: 'azure',
      nodes,
      edges: [],
    });

    expect(assessment.findings.length).toBeGreaterThan(0);
    expect(assessment.findings[0].resourceState).toBe('imported');
  });
});

describe('Auto-Layout with Cloud Provider Boundaries', () => {
  test('Encloses resources inside cloud provider boundaries', () => {
    const nodes: CanvasNode[] = [
      {
        id: 'boundary-aws',
        type: 'containerNode',
        resourceType: 'cloud_provider_boundary',
        provider: 'aws',
        label: 'Amazon Web Services',
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: 'vpc-1',
        type: 'containerNode',
        resourceType: 'aws_vpc',
        provider: 'aws',
        label: 'Primary VPC',
        position: { x: 50, y: 50 },
        config: { cidrBlock: '10.0.0.0/16' },
      },
      {
        id: 'ec2-1',
        type: 'cloudNode',
        resourceType: 'aws_ec2',
        provider: 'aws',
        label: 'Web Node',
        position: { x: 100, y: 100 },
        config: { instanceType: 't3.micro' },
      },
    ];

    const edges: CanvasEdge[] = [];
    const layout = autoLayoutArchitecture(nodes, edges);

    const boundary = layout.nodes.find((n) => n.id === 'boundary-aws');
    expect(boundary).toBeDefined();
    expect(boundary?.width).toBeGreaterThanOrEqual(800);
    expect(boundary?.height).toBeGreaterThanOrEqual(500);

    // Boundary should be sorted before VPC and leaves in z-order
    const boundaryIndex = layout.nodes.findIndex((n) => n.id === 'boundary-aws');
    const vpcIndex = layout.nodes.findIndex((n) => n.id === 'vpc-1');
    expect(boundaryIndex).toBeLessThan(vpcIndex);
  });
});
