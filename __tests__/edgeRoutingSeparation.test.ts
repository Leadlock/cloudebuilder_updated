jest.mock('reactflow/dist/style.css', () => ({}), { virtual: true });

import { toReactFlowEdges } from '@/components/canvas/InfraCanvas';
import { CanvasNode, CanvasEdge } from '@/types';

describe('Edge Routing & Overlap Prevention Engine', () => {
  const baseNodes: CanvasNode[] = [
    {
      id: 'alb',
      type: 'cloudNode',
      resourceType: 'aws_alb',
      provider: 'aws',
      label: 'Application Load Balancer',
      position: { x: 760, y: 430 },
      config: {},
    },
    {
      id: 'nat1',
      type: 'cloudNode',
      resourceType: 'aws_nat_gateway',
      provider: 'aws',
      label: 'NAT Gateway 1',
      position: { x: 880, y: 430 },
      config: {},
    },
    {
      id: 'ec2a',
      type: 'cloudNode',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'Amazon EC2 (AZ-1)',
      position: { x: 760, y: 730 },
      config: {},
    },
    {
      id: 'ebsa',
      type: 'cloudNode',
      resourceType: 'aws_ebs',
      provider: 'aws',
      label: 'Amazon EBS',
      position: { x: 880, y: 730 },
      config: {},
    },
    {
      id: 'rdsp',
      type: 'cloudNode',
      resourceType: 'aws_rds',
      provider: 'aws',
      label: 'Amazon RDS Primary',
      position: { x: 760, y: 1100 },
      config: {},
    },
    {
      id: 'iam_sec',
      type: 'cloudNode',
      resourceType: 'aws_iam_role',
      provider: 'aws',
      label: 'IAM Security Role',
      position: { x: 2100, y: 430 },
      config: {},
    },
    {
      id: 's3dest',
      type: 'cloudNode',
      resourceType: 'aws_s3',
      provider: 'aws',
      label: 'S3 Target Bucket',
      position: { x: 300, y: 430 },
      config: {},
    },
  ];

  it('assigns distinct multi-port handles so opposite and multiple edges do not share the exact same point', () => {
    const edges: CanvasEdge[] = [
      { id: 'e-in', source: 'alb', target: 'ec2a', relationshipType: 'LOAD_BALANCES', label: 'Forward Traffic' },
      { id: 'e-out', source: 'ec2a', target: 'nat1', relationshipType: 'NETWORK_FLOW', label: 'Outbound Internet' },
    ];

    const rfEdges = toReactFlowEdges(edges, baseNodes);
    expect(rfEdges).toHaveLength(2);

    const inEdge = rfEdges.find((e) => e.id === 'e-in')!;
    const outEdge = rfEdges.find((e) => e.id === 'e-out')!;

    // EC2A top has both an incoming and an outgoing edge
    // They must use different handles so lines do not merge on the same pixel!
    expect(inEdge.targetHandle).toBeDefined();
    expect(outEdge.sourceHandle).toBeDefined();
    expect(inEdge.targetHandle).not.toEqual(outEdge.sourceHandle);
  });

  it('separates parallel edges into distinct channel lanes', () => {
    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'ec2a', target: 'rdsp', relationshipType: 'DATA_FLOW', label: 'Queries 1' },
      { id: 'e2', source: 'ebsa', target: 'rdsp', relationshipType: 'DATA_FLOW', label: 'Queries 2' },
    ];

    const rfEdges = toReactFlowEdges(edges, baseNodes);
    expect(rfEdges).toHaveLength(2);

    // End handles on rdsp should be staggered/distinct
    const handles = rfEdges.map((e) => e.targetHandle);
    expect(new Set(handles).size).toBe(2);
  });

  it('routes cross-canvas edges spanning across the VPC away from internal subnets', () => {
    const edges: CanvasEdge[] = [
      { id: 'e-cross', source: 'iam_sec', target: 's3dest', relationshipType: 'ASSOCIATED_WITH', label: 'Policy Sync' },
    ];

    const rfEdges = toReactFlowEdges(edges, baseNodes);
    expect(rfEdges).toHaveLength(1);

    const crossEdge = rfEdges[0];
    // Cross-canvas edge (Right Flank -> Left Flank) routes via Top Sky Highway to avoid cutting through VPC subnets
    expect(crossEdge.sourceHandle).toContain('top');
    expect(crossEdge.targetHandle).toContain('top');
    expect(crossEdge.data?.pathOffset).toBeGreaterThanOrEqual(20);
  });

  it('inspects all edges in prism-architecture.json', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    const prism = JSON.parse(fs.readFileSync('prism-architecture.json', 'utf8'));
    // Add IAM edges like the ones produced by IAM completion modal
    const testEdges = [
      ...prism.edges,
      { id: 'iam-s3-1', source: 'iam_crr', target: 's3front', label: 'Source S3 (CRR)' },
      { id: 'iam-s3-2', source: 'iam_crr', target: 's3upload', label: 'Source S3 (CRR)' },
      { id: 'iam-s3-3', source: 'iam_crr', target: 's3config', label: 'Source S3 (CRR)' },
      { id: 'iam-s3-4', source: 'iam_crr', target: 's3ctrail', label: 'Source S3 (CRR)' },
      { id: 'iam-dr-1', source: 'iam_crr', target: 's3frontcrr', label: 'ReplicateObject (Osaka)' },
      { id: 'iam-dr-2', source: 'iam_crr', target: 's3uploadcrr', label: 'ReplicateObject (Osaka)' },
    ];
    const rfEdges = toReactFlowEdges(testEdges, prism.nodes);

    console.log('=== IAM Modal Generated Edges ===');
    rfEdges
      .filter((e) => e.id.startsWith('iam-'))
      .forEach((e) => {
        console.log(
          `${e.id} | ${e.source} -> ${e.target} | label: "${e.label}" | srcH: ${e.sourceHandle} | tgtH: ${e.targetHandle} | centerX: ${e.data?.centerX} | centerY: ${e.data?.centerY} | offset: ${e.data?.labelOffsetX}, ${e.data?.labelOffsetY}`
        );
      });
  });
});

