import { dagEngine } from '@/lib/stacks/dagEngine';
import type { StackDefinition } from '@/lib/stacks/types';
import type { CanvasNode } from '@/types';

describe('Multi-Stack DAG Engine', () => {
  it('correctly calculates topological execution tiers for dependent stacks', () => {
    const stacks: Record<string, StackDefinition> = {
      'stack-network': {
        id: 'stack-network',
        name: 'VPC Network',
        layer: 'network',
        description: 'VPC and Subnets',
        nodeIds: ['node-1'],
        dependsOn: [],
        inputs: [],
        outputs: [],
        status: 'idle',
      },
      'stack-database': {
        id: 'stack-database',
        name: 'Postgres DB',
        layer: 'data',
        description: 'RDS Database',
        nodeIds: ['node-2'],
        dependsOn: ['stack-network'],
        inputs: [],
        outputs: [],
        status: 'idle',
      },
      'stack-compute': {
        id: 'stack-compute',
        name: 'Web Servers',
        layer: 'compute',
        description: 'EC2 AutoScaling',
        nodeIds: ['node-3'],
        dependsOn: ['stack-network', 'stack-database'],
        inputs: [],
        outputs: [],
        status: 'idle',
      },
      'stack-ingress': {
        id: 'stack-ingress',
        name: 'ALB Load Balancer',
        layer: 'app',
        description: 'Public Ingress',
        nodeIds: ['node-4'],
        dependsOn: ['stack-compute'],
        inputs: [],
        outputs: [],
        status: 'idle',
      },
    };

    const result = dagEngine.validateAndCalculateTiers(stacks);

    expect(result.isValid).toBe(true);
    expect(result.tiers.length).toBe(4);

    // Tier 0 should only have stack-network
    expect(result.tiers[0].stackIds).toEqual(['stack-network']);

    // Tier 1 should have stack-database
    expect(result.tiers[1].stackIds).toEqual(['stack-database']);

    // Tier 2 should have stack-compute
    expect(result.tiers[2].stackIds).toEqual(['stack-compute']);

    // Tier 3 should have stack-ingress
    expect(result.tiers[3].stackIds).toEqual(['stack-ingress']);
  });

  it('detects cyclic dependencies and reports errors', () => {
    const stacks: Record<string, StackDefinition> = {
      'stack-a': {
        id: 'stack-a',
        name: 'Stack A',
        layer: 'compute',
        description: '',
        nodeIds: [],
        dependsOn: ['stack-b'], // A depends on B
        inputs: [],
        outputs: [],
        status: 'idle',
      },
      'stack-b': {
        id: 'stack-b',
        name: 'Stack B',
        layer: 'data',
        description: '',
        nodeIds: [],
        dependsOn: ['stack-a'], // B depends on A (CYCLE!)
        inputs: [],
        outputs: [],
        status: 'idle',
      },
    };

    const result = dagEngine.validateAndCalculateTiers(stacks);

    expect(result.isValid).toBe(false);
    expect(result.errors?.[0]).toContain('Cyclic dependency detected');
  });

  it('auto-clusters canvas nodes into structured stacks', () => {
    const sampleNodes: CanvasNode[] = [
      {
        id: 'n1',
        type: 'cloudNode',
        resourceType: 'aws_vpc',
        provider: 'aws',
        label: 'Production VPC',
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: 'n2',
        type: 'cloudNode',
        resourceType: 'aws_rds',
        provider: 'aws',
        label: 'User DB',
        position: { x: 100, y: 0 },
        config: {},
      },
      {
        id: 'n3',
        type: 'cloudNode',
        resourceType: 'aws_ec2',
        provider: 'aws',
        label: 'API Server',
        position: { x: 200, y: 0 },
        config: {},
      },
      {
        id: 'n4',
        type: 'cloudNode',
        resourceType: 'aws_alb',
        provider: 'aws',
        label: 'Load Balancer',
        position: { x: 300, y: 0 },
        config: {},
      },
    ];

    const clusters = dagEngine.autoClusterStacks(sampleNodes);

    expect(clusters['stack-network'].nodeIds).toContain('n1');
    expect(clusters['stack-data'].nodeIds).toContain('n2');
    expect(clusters['stack-compute'].nodeIds).toContain('n3');
    expect(clusters['stack-ingress'].nodeIds).toContain('n4');

    const result = dagEngine.validateAndCalculateTiers(clusters);
    expect(result.isValid).toBe(true);
  });
});
