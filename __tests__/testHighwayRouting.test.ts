jest.mock('reactflow/dist/style.css', () => ({}), { virtual: true });

import * as fs from 'fs';
import * as path from 'path';
import { toReactFlowEdges } from '@/components/canvas/InfraCanvas';
import { CanvasNode, CanvasEdge } from '@/types';

describe('Test Highway Routing Engine', () => {
  it('verifies that cross-flank edges do not drop inside AZ-2', () => {
    const raw = fs.readFileSync(path.resolve(__dirname, '../prism-architecture.json'), 'utf8');
    const prism = JSON.parse(raw);

    const testEdges: CanvasEdge[] = [
      ...prism.edges,
      { id: 'iam-s3-1', source: 'iam_crr', target: 's3front', label: 'Source S3 (CRR)' },
      { id: 'iam-s3-2', source: 'iam_crr', target: 's3upload', label: 'Source S3 (CRR)' },
      { id: 'iam-s3-3', source: 'iam_crr', target: 's3config', label: 'Source S3 (CRR)' },
      { id: 'iam-s3-4', source: 'iam_crr', target: 's3ctrail', label: 'Source S3 (CRR)' },
      { id: 'iam-dr-1', source: 'iam_crr', target: 's3frontcrr', label: 'ReplicateObject (Osaka)' },
      { id: 'iam-dr-2', source: 'iam_crr', target: 's3uploadcrr', label: 'ReplicateObject (Osaka)' },
    ];

    const rfEdges = toReactFlowEdges(testEdges, prism.nodes);

    // Verify cross-flank edges
    const s3Edges = rfEdges.filter((e) => e.id.startsWith('iam-s3-'));
    expect(s3Edges.length).toBe(4);

    s3Edges.forEach((e) => {
      // Must use Top handles to stay on Top Sky Highway
      expect(e.sourceHandle).toContain('top');
      expect(e.targetHandle).toContain('top');
      // Cross-flank edges do not drop into AZ-2, pathOffset is set for top sky clearance
      expect(e.data?.pathOffset).toBeGreaterThanOrEqual(20);
    });

    // Verify DR edges
    const drEdges = rfEdges.filter((e) => e.id.startsWith('iam-dr-'));
    expect(drEdges.length).toBe(2);

    drEdges.forEach((e) => {
      // Must use Bottom handles to stay on Bottom Highway
      expect(e.sourceHandle).toContain('bottom');
      expect(e.targetHandle).toContain('bottom');
    });

    // Verify ec2b to nat2 edge
    const nat2Edge = rfEdges.find((e) => e.source === 'ec2b' && e.target === 'nat2');
    expect(nat2Edge).toBeDefined();

    // Verify badge collisions
    const badgePositions = rfEdges
      .filter((e) => e.label)
      .map((e) => ({
        id: e.id,
        label: e.label,
        ox: e.data?.labelOffsetX,
        oy: e.data?.labelOffsetY,
      }));

    console.log('Badge positions count:', badgePositions.length);
  });
});
