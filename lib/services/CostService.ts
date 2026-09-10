import { CanvasNode, CostItem, CostOptimization } from '@/types';
import { calculateCosts } from '@/lib/analysis';
import { generateCostOptimizations } from '@/lib/generator';
import { DETERMINISTIC_MOCK_RATES } from '@/lib/currency/providers/MockExchangeRateProvider';

// ─── Interface ────────────────────────────────────────────────────────────────
export interface ICostService {
  calculateCosts(nodes: CanvasNode[], currency?: string): Promise<CostItem[]>;
  generateOptimizations(nodes: CanvasNode[]): CostOptimization[];
  applyOptimization(nodes: CanvasNode[], optimizationId: string): CanvasNode[];
}

// ─── Downsize maps ─────────────────────────────────────────────────────────────
const INSTANCE_DOWNSIZE: Record<string, string> = {
  'm5.2xlarge': 'm5.xlarge',
  'm5.xlarge':  'm5.large',
  'm5.large':   'm5.medium',
  'r5.xlarge':  'r5.large',
  'r5.large':   'r5.medium',
  'c5.xlarge':  'c5.large',
};

// ─── Mock Implementation ──────────────────────────────────────────────────────
class MockCostService implements ICostService {
  async calculateCosts(nodes: CanvasNode[], currency: string = 'USD'): Promise<CostItem[]> {
    await Promise.resolve();
    const baseItems = calculateCosts(nodes);
    const targetCurr = (currency || 'USD').toUpperCase();
    if (targetCurr === 'USD') {
      return baseItems;
    }

    const rate = DETERMINISTIC_MOCK_RATES[`USD:${targetCurr}`] ?? 1.0;
    return baseItems.map((item) => ({
      ...item,
      monthlyCost: item.monthlyCost * rate,
      currency: targetCurr,
      providerCostUsd: item.monthlyCost,
      exchangeRate: rate,
      exchangeRateSource: 'mock-fixtures',
      breakdown: item.breakdown.map((b) => ({
        ...b,
        cost: b.cost * rate,
        originalCostUsd: b.cost,
      })),
    }));
  }

  generateOptimizations(nodes: CanvasNode[]): CostOptimization[] {
    return generateCostOptimizations(nodes);
  }

  applyOptimization(nodes: CanvasNode[], optimizationId: string): CanvasNode[] {
    // Right-size instance: opt-<nodeId>
    if (optimizationId.startsWith('opt-') && !optimizationId.startsWith('opt-nat-') && !optimizationId.startsWith('opt-rds-') && !optimizationId.startsWith('opt-s3-')) {
      const nodeId = optimizationId.replace(/^opt-/, '');
      return nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const current = n.config.instanceType as string | undefined;
        const downsized = current ? (INSTANCE_DOWNSIZE[current] ?? current) : current;
        return { ...n, config: { ...n.config, instanceType: downsized } };
      });
    }

    // NAT consolidation: keep only first NAT node, remove others
    if (optimizationId.startsWith('opt-nat-')) {
      const natNodes = nodes.filter((n) => n.resourceType === 'aws_nat');
      if (natNodes.length <= 1) return nodes;
      const keepId = natNodes[0].id;
      return nodes.filter((n) => n.resourceType !== 'aws_nat' || n.id === keepId);
    }

    return nodes;
  }
}

export const costService: ICostService = new MockCostService();
