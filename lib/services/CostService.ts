import { CanvasNode, CostItem, CostOptimization } from '@/types';
import { calculateCosts } from '@/lib/analysis';
import { generateCostOptimizations } from '@/lib/generator';
import { CloudCostComparisonService } from '@/lib/engines/comparison/CloudCostComparisonService';
import type { CostComparisonResult } from './ApiCostService';

// ─── Interface ────────────────────────────────────────────────────────────────
export interface ICostService {
  calculateCosts(nodes: CanvasNode[], currency?: string): Promise<CostItem[]>;
  compareCosts?(nodes: CanvasNode[], currency?: string, opts?: { refresh?: boolean }): Promise<CostComparisonResult>;
  /** AI explanation and savings ideas (server-side; only the API-backed service implements it). */
  getInsights?(nodes: CanvasNode[]): Promise<import('@/lib/cost/ai/insights').CostInsights>;
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
  /**
   * Offline estimate from CloudCraft's static tables. Used only when the pricing API is
   * unreachable, so every item is a FALLBACK_ESTIMATE. No exchange rate is invented: a
   * non-USD request returns USD figures with the conversion marked UNAVAILABLE.
   */
  async calculateCosts(nodes: CanvasNode[], currency: string = 'USD'): Promise<CostItem[]> {
    await Promise.resolve();
    const targetCurr = (currency || 'USD').toUpperCase();
    return calculateCosts(nodes).map((item) => ({
      ...item,
      currency: 'USD',
      providerCostUsd: item.monthlyCost,
      pricingTier: 'FALLBACK_ESTIMATE' as const,
      ...(targetCurr !== 'USD' ? { exchangeRateTier: 'UNAVAILABLE' as const } : {}),
    }));
  }

  async compareCosts(nodes: CanvasNode[], currency: string = 'USD'): Promise<CostComparisonResult> {
    const currentProvider = nodes.find((n) => n.provider === 'aws' || n.provider === 'azure')?.provider ?? 'aws';
    const targetProvider = currentProvider === 'aws' ? 'azure' : 'aws';

    const translatedNodes = CloudCostComparisonService.translateNodes(nodes, targetProvider);

    // calculateCosts (above) never converts (no invented FX rate), so items are USD.
    const [currentItems, translatedItems] = await Promise.all([
      this.calculateCosts(nodes, currency),
      this.calculateCosts(translatedNodes, currency),
    ]);

    const sumUsd = (items: CostItem[]) => items.reduce((a, i) => a + (i.providerCostUsd ?? i.monthlyCost), 0);
    const sumConverted = (items: CostItem[]) => items.reduce((a, i) => a + i.monthlyCost, 0);

    // The local fixture calculator (lib/analysis.ts calculateCosts) has no
    // per-resource confidence/unsupported concept — every resource it knows
    // about gets a fixture price — so coverage is honestly reported as
    // "everything it priced", not fabricated partial coverage.
    const toSide = (items: CostItem[]) => ({
      items,
      unsupportedCount: 0,
      totalResourceCount: items.length,
      pricingCoveragePct: 100,
      totalMonthlyUsd: sumUsd(items),
      totalHourlyUsd: sumUsd(items) / 730,
      totalMonthlyConverted: sumConverted(items),
      totalHourlyConverted: sumConverted(items) / 730,
      // No exchange rate is available offline, so figures stay in USD.
      currency: 'USD',
    });

    return {
      currentProvider,
      targetProvider,
      current: toSide(currentItems),
      translated: toSide(translatedItems),
      targetCurrency: 'USD',
    };
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
