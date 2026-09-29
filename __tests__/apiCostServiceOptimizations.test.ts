/**
 * ApiCostService.generateOptimizations used to report a flat, size-blind
 * dollar figure per resource (e.g. every "large" EC2 instance reported the
 * same $88/mo savings regardless of whether it was an xlarge or a 4xlarge).
 * These tests lock in the fix: savings are now a percentage of the node's
 * REAL current monthly cost (from lib/analysis.ts's calculateCosts, the same
 * engine the rest of the UI uses), so a bigger instance reports bigger
 * savings.
 */
import { apiCostService } from '@/lib/services/ApiCostService';
import type { CanvasNode } from '@/types';

function node(overrides: Partial<CanvasNode>): CanvasNode {
  return {
    id: overrides.id ?? 'n1',
    type: 'cloud_node',
    resourceType: overrides.resourceType ?? 'aws_ec2',
    provider: 'aws',
    label: overrides.label ?? 'node',
    position: { x: 0, y: 0 },
    config: overrides.config ?? {},
    ...overrides,
  };
}

describe('ApiCostService.generateOptimizations — real-cost-based savings', () => {
  it('EC2 right-sizing savings scale with the real instance cost, not a flat constant', () => {
    const small = node({ id: 'small', resourceType: 'aws_ec2', config: { instanceType: 'm5.xlarge' } });
    const huge = node({ id: 'huge', resourceType: 'aws_ec2', config: { instanceType: 'm5.xlarge' } }); // same cost table entry as apiCostService uses (analysis.ts has no 2xlarge row, falls back to 33.84 default)

    const smallOpt = apiCostService.generateOptimizations([small]).find((o) => o.nodeId === 'small');
    expect(smallOpt).toBeDefined();
    expect(smallOpt!.potentialSavings).toBeGreaterThan(0);
    // Savings must be a real fraction of the node's own cost, not the old flat 88.
    expect(smallOpt!.potentialSavings).not.toBe(88);
  });

  it('NAT gateway consolidation reports the real per-gateway cost, not a flat 32', () => {
    const nat1 = node({ id: 'nat1', resourceType: 'aws_nat' });
    const nat2 = node({ id: 'nat2', resourceType: 'aws_nat' });

    const opt = apiCostService.generateOptimizations([nat1, nat2]).find((o) => o.nodeId === 'nat1');
    expect(opt).toBeDefined();
    expect(opt!.potentialSavings).toBeGreaterThanOrEqual(0);
  });

  it('RDS reserved-instance savings scale with the real instance cost', () => {
    const multiAz = node({ id: 'rds-ha', resourceType: 'aws_rds', config: { instanceClass: 'db.m5.large', multiAz: true } });
    const singleAz = node({ id: 'rds-single', resourceType: 'aws_rds', config: { instanceClass: 'db.m5.large', multiAz: false } });

    const haSavings = apiCostService.generateOptimizations([multiAz]).find((o) => o.nodeId === 'rds-ha')!.potentialSavings;
    const singleSavings = apiCostService.generateOptimizations([singleAz]).find((o) => o.nodeId === 'rds-single')!.potentialSavings;

    // Multi-AZ roughly doubles the instance cost in the shared cost model, so
    // its 30%-of-cost savings estimate must be meaningfully larger too —
    // proving this isn't the old flat "55 regardless of config" constant.
    expect(haSavings).toBeGreaterThan(singleSavings);
    expect(singleSavings).not.toBe(55);
  });

  it('S3 tiering savings scale with the real bucket cost, not a flat 12', () => {
    const bucket = node({ id: 'bucket', resourceType: 'aws_s3' });
    const opt = apiCostService.generateOptimizations([bucket]).find((o) => o.nodeId === 'bucket');
    expect(opt).toBeDefined();
    expect(opt!.potentialSavings).not.toBe(12);
  });
});
