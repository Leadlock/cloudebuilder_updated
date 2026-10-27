import { evaluateResourceDataflowStatus, isDataflowOrConnectionEdge } from '@/lib/canvas/dataflowStatus';
import { CanvasNode, CanvasEdge } from '@/types';
import fs from 'fs';
import path from 'path';

describe('Dataflow Connection & Resource Health Evaluator', () => {
  const dummyVpc: CanvasNode = {
    id: 'vpc-1',
    type: 'containerNode',
    resourceType: 'aws_vpc',
    provider: 'aws',
    label: 'Main VPC',
    position: { x: 500, y: 200 },
    config: { cidrBlock: '10.0.0.0/16' },
  };

  const dummySubnet: CanvasNode = {
    id: 'sub-1',
    type: 'containerNode',
    resourceType: 'aws_subnet',
    provider: 'aws',
    label: 'Private Subnet',
    position: { x: 540, y: 350 },
    groupId: 'vpc-1',
    config: { cidrBlock: '10.0.1.0/24' },
  };

  test('1. Resource with no connected edges reports disconnected', () => {
    const ec2Node: CanvasNode = {
      id: 'ec2-isolated',
      type: 'cloudNode',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'Isolated EC2',
      position: { x: 600, y: 400 },
      groupId: 'sub-1',
      config: { instanceType: 't3.medium' },
    };

    const status = evaluateResourceDataflowStatus(ec2Node, [dummyVpc, dummySubnet, ec2Node], []);
    expect(status.isConnected).toBe(false);
    expect(status.isConfigured).toBe(false);
    expect(status.status).toBe('disconnected');
    expect(status.connectedEdgeCount).toBe(0);
  });

  test('2. Resource with structural containment only (e.g. subnet in vpc) does not count as dataflow connection', () => {
    const containmentEdge: CanvasEdge = {
      id: 'e-contain',
      source: 'vpc-1',
      target: 'sub-1',
      relationshipType: 'CONTAINS' as any,
      label: 'subnet in vpc',
    };

    expect(isDataflowOrConnectionEdge(containmentEdge)).toBe(false);

    const status = evaluateResourceDataflowStatus(dummySubnet, [dummyVpc, dummySubnet], [containmentEdge]);
    expect(status.isConnected).toBe(false);
  });

  test('3. Connected resource with valid configuration reports connected_healthy (GREEN)', () => {
    const ec2Node: CanvasNode = {
      id: 'ec2-valid',
      type: 'cloudNode',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'Web Server',
      position: { x: 600, y: 400 },
      groupId: 'sub-1',
      config: { instanceType: 't3.medium', os: 'Amazon Linux 2' },
    };

    const rdsNode: CanvasNode = {
      id: 'rds-valid',
      type: 'cloudNode',
      resourceType: 'aws_rds',
      provider: 'aws',
      label: 'App DB',
      position: { x: 1000, y: 400 },
      groupId: 'sub-1',
      config: { engine: 'postgres', instanceClass: 'db.r6g.large' },
    };

    const edge: CanvasEdge = {
      id: 'e-ec2-rds',
      source: 'ec2-valid',
      target: 'rds-valid',
      relationshipType: 'DATABASE_CONNECTION' as any,
      label: 'DB access',
    };

    const ec2Status = evaluateResourceDataflowStatus(ec2Node, [dummyVpc, dummySubnet, ec2Node, rdsNode], [edge]);
    expect(ec2Status.isConnected).toBe(true);
    expect(ec2Status.isConfigured).toBe(true);
    expect(ec2Status.status).toBe('connected_healthy');
    expect(ec2Status.issues).toBeUndefined();

    const rdsStatus = evaluateResourceDataflowStatus(rdsNode, [dummyVpc, dummySubnet, ec2Node, rdsNode], [edge]);
    expect(rdsStatus.isConnected).toBe(true);
    expect(rdsStatus.isConfigured).toBe(true);
    expect(rdsStatus.status).toBe('connected_healthy');
  });

  test('4. Connected resource with unconfigured / missing required properties reports needs_manual_config (RED)', () => {
    const unconfiguredEc2: CanvasNode = {
      id: 'ec2-unconf',
      type: 'cloudNode',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'Unconfigured EC2',
      position: { x: 600, y: 400 },
      // missing instanceType and missing groupId (not inside a subnet)
      config: {},
    };

    const rdsNode: CanvasNode = {
      id: 'rds-valid',
      type: 'cloudNode',
      resourceType: 'aws_rds',
      provider: 'aws',
      label: 'App DB',
      position: { x: 1000, y: 400 },
      groupId: 'sub-1',
      config: { engine: 'postgres' },
    };

    const edge: CanvasEdge = {
      id: 'e-ec2-rds',
      source: 'ec2-unconf',
      target: 'rds-valid',
      relationshipType: 'DATABASE_CONNECTION' as any,
      label: 'DB access',
    };

    const status = evaluateResourceDataflowStatus(unconfiguredEc2, [unconfiguredEc2, rdsNode], [edge]);
    expect(status.isConnected).toBe(true);
    expect(status.isConfigured).toBe(false);
    expect(status.status).toBe('needs_manual_config');
    expect(status.issues?.length).toBeGreaterThan(0);
    expect(status.issues?.some((i) => i.includes('Subnet'))).toBe(true);
  });

  test('5. Connected resource explicitly flagged for manual configuration reports needs_manual_config (RED)', () => {
    const flaggedEc2: CanvasNode = {
      id: 'ec2-flagged',
      type: 'cloudNode',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'Flagged EC2',
      position: { x: 600, y: 400 },
      groupId: 'sub-1',
      config: { instanceType: 't3.micro', manualConfigRequired: true },
    };

    const rdsNode: CanvasNode = {
      id: 'rds-target',
      type: 'cloudNode',
      resourceType: 'aws_rds',
      provider: 'aws',
      label: 'App DB',
      position: { x: 1000, y: 400 },
      groupId: 'sub-1',
      config: { engine: 'postgres' },
    };

    const edge: CanvasEdge = {
      id: 'e-flagged',
      source: 'ec2-flagged',
      target: 'rds-target',
      relationshipType: 'DATABASE_CONNECTION' as any,
    };

    const status = evaluateResourceDataflowStatus(flaggedEc2, [dummyVpc, dummySubnet, flaggedEc2, rdsNode], [edge]);
    expect(status.isConnected).toBe(true);
    expect(status.isConfigured).toBe(false);
    expect(status.status).toBe('needs_manual_config');
    expect(status.issues?.some((i) => i.includes('manual configuration'))).toBe(true);
  });

  test('6. PRISM Architecture file resources all have valid dataflow statuses and expansive distances', () => {
    const raw = fs.readFileSync(path.join(process.cwd(), 'prism-architecture.json'), 'utf8');
    const prism = JSON.parse(raw);

    const nodes: CanvasNode[] = prism.nodes;
    const edges: CanvasEdge[] = prism.edges;

    // Check ec2a, ec2b, rdsp
    const ec2a = nodes.find((n) => n.id === 'ec2a')!;
    const ec2b = nodes.find((n) => n.id === 'ec2b')!;
    const ebsa = nodes.find((n) => n.id === 'ebsa')!;
    const ebsb = nodes.find((n) => n.id === 'ebsb')!;
    const rdsp = nodes.find((n) => n.id === 'rdsp')!;

    const ec2aStatus = evaluateResourceDataflowStatus(ec2a, nodes, edges);
    expect(ec2aStatus.isConnected).toBe(true);
    expect(ec2aStatus.isConfigured).toBe(true);
    expect(ec2aStatus.status).toBe('connected_healthy');

    const rdspStatus = evaluateResourceDataflowStatus(rdsp, nodes, edges);
    expect(rdspStatus.isConnected).toBe(true);
    expect(rdspStatus.isConfigured).toBe(true);
    expect(rdspStatus.status).toBe('connected_healthy');

    // Distance between workloads must be generous (>= 400px center-to-center)
    const ec2aDistToEbs = Math.abs(ebsa.position.x - ec2a.position.x);
    expect(ec2aDistToEbs).toBeGreaterThanOrEqual(400);

    const ec2bDistToEbs = Math.abs(ebsb.position.x - ec2b.position.x);
    expect(ec2bDistToEbs).toBeGreaterThanOrEqual(400);

    // Subnets must have inter-AZ canyon >= 120px
    const pub1 = nodes.find((n) => n.id === 'pub1')!;
    const pub2 = nodes.find((n) => n.id === 'pub2')!;
    const pub1Right = pub1.position.x + (pub1.width || 720);
    const canyonGap = pub2.position.x - pub1Right;
    expect(canyonGap).toBeGreaterThanOrEqual(120);

    // Inter-tier gap must be >= 120px
    const priv1 = nodes.find((n) => n.id === 'priv1')!;
    const tier1Bottom = pub1.position.y + (pub1.height || 230);
    const tierCorridor = priv1.position.y - tier1Bottom;
    expect(tierCorridor).toBeGreaterThanOrEqual(120);
  });
});
