/**
 * ApiCostService — HTTP-backed implementation of ICostService.
 *
 * Replaces MockCostService with real API-backed cost estimation.
 * The interface is IDENTICAL to ICostService — no frontend changes required.
 *
 * Calls:
 *   POST /api/projects/:id/cost-estimates  — runs estimation from persisted arch
 *   GET  /api/projects/:id/cost-estimates/:estimateId — retrieves an estimate
 */
import type { ICostService } from './CostService';
import type { CanvasNode, CostItem, CostOptimization } from '@/types';

export interface CostComparisonItem {
  resourceId: string;
  resourceLabel: string;
  resourceType: string;
  monthlyUsd: number;
}

export interface CostComparisonResult {
  currentProvider: string;
  targetProvider: string;
  current: { items: CostComparisonItem[]; totalMonthlyUsd: number; totalHourlyUsd: number };
  translated: { items: CostComparisonItem[]; totalMonthlyUsd: number; totalHourlyUsd: number };
  targetCurrency: string;
}

// ─── API helpers ─────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  if (typeof window !== 'undefined') return '';
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

interface ApiSuccess<T> { ok: true; data: T }
interface ApiError { ok: false; error: { code: string; message: string } }
type ApiEnvelope<T> = ApiSuccess<T> | ApiError;

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.NODE_ENV === 'development' ? { 'x-user-id': 'dev-user-id' } : {}),
    },
    ...init,
  });
  const envelope = (await res.json()) as ApiEnvelope<T>;
  if (!envelope.ok) {
    throw new Error(`API ${path} → ${envelope.error.code}: ${envelope.error.message}`);
  }
  return envelope.data;
}

// ─── Response types ───────────────────────────────────────────────────────────

interface ApiCostLineItem {
  resourceId: string;
  resourceLabel: string;
  resourceType: string;
  provider: string;
  region: string;
  hourlyUsd: number;
  monthlyUsd: number;
  breakdown: Array<{ label: string; monthlyUsd: number; monthlyConverted?: number; currency?: string }>;
  assumptions: string[];
  pricingSource: string;
  confidence: string;
  providerPrice?: {
    unitPrice: number;
    monthlyPrice: number;
    currency: string;
    unit?: string;
  };
  convertedPrice?: {
    unitPrice: number;
    monthlyPrice: number;
    currency: string;
    exchangeRate: number;
    exchangeRateSource: string;
    exchangeRateRetrievedAt: string;
    isCachedRate?: boolean;
    isStaleRate?: boolean;
  };
}

interface CostEstimateResponse {
  estimateId: string | null;
  architectureId: string;
  items: ApiCostLineItem[];
  totalMonthlyUsd: number;
  totalHourlyUsd: number;
  totalMonthlyConverted?: number;
  totalHourlyConverted?: number;
  currency: string;
  assumptions: string[];
  pricingSource: string;
  confidence: string;
  exchangeRateMeta?: {
    fromCurrency: string;
    toCurrency: string;
    rate: number;
    source: string;
    retrievedAt: string;
    isCached: boolean;
    isStale?: boolean;
  };
  message?: string;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

function mapItem(item: ApiCostLineItem): CostItem {
  const isConverted = Boolean(item.convertedPrice && item.convertedPrice.currency !== 'USD');
  const monthlyCost = isConverted ? item.convertedPrice!.monthlyPrice : item.monthlyUsd;
  const hourlyCost = isConverted ? item.convertedPrice!.unitPrice : item.hourlyUsd;
  const currency = isConverted ? item.convertedPrice!.currency : 'USD';

  return {
    nodeId: item.resourceId,
    nodeLabel: item.resourceLabel,
    resourceType: item.resourceType,
    provider: item.provider as 'aws' | 'azure',
    region: item.region,
    monthlyCost,
    hourlyCost,
    currency,
    providerCostUsd: item.providerPrice?.monthlyPrice ?? item.monthlyUsd,
    providerHourlyUsd: item.providerPrice?.unitPrice ?? item.hourlyUsd,
    exchangeRate: item.convertedPrice?.exchangeRate,
    exchangeRateSource: item.convertedPrice?.exchangeRateSource,
    exchangeRateRetrievedAt: item.convertedPrice?.exchangeRateRetrievedAt,
    isCachedRate: item.convertedPrice?.isCachedRate,
    isStaleRate: item.convertedPrice?.isStaleRate,
    breakdown: item.breakdown.map((b) => ({
      label: b.label,
      cost: isConverted && b.monthlyConverted !== undefined ? b.monthlyConverted : b.monthlyUsd,
      originalCostUsd: b.monthlyUsd,
    })),
  };
}

// ─── Downsize maps (for applyOptimization) ────────────────────────────────────

const INSTANCE_DOWNSIZE: Record<string, string> = {
  'm5.2xlarge': 'm5.xlarge',
  'm5.xlarge':  'm5.large',
  'm5.large':   'm5.medium',
  'r5.xlarge':  'r5.large',
  'r5.large':   'r5.medium',
  'c5.xlarge':  'c5.large',
};

// ─── Active project registry ─────────────────────────────────────────────────

/** Module-level active project ID — set by AppContext when active project changes */
let _activeProjectId: string | null = null;
let _activeEnvironment = 'production';
let _activeCurrency = 'USD';

/**
 * Set the active project ID so the API service can scope its requests correctly.
 * Called by AppContext whenever the active project changes — no localStorage needed.
 */
export function setActiveProjectId(id: string | null): void {
  _activeProjectId = id;
}

export function setActiveEnvironment(env: string): void {
  _activeEnvironment = env;
}

export function setActiveCurrency(currency: string): void {
  _activeCurrency = (currency || 'USD').toUpperCase();
}

// ─── ApiCostService ───────────────────────────────────────────────────────────

class ApiCostServiceImpl implements ICostService {

  async calculateCosts(nodes: CanvasNode[], currency?: string): Promise<CostItem[]> {
    const projectId = _activeProjectId;
    if (!projectId) {
      throw new Error('No active project context');
    }

    const targetCurr = (currency || _activeCurrency || 'USD').toUpperCase();
    const query = targetCurr !== 'USD' ? `?currency=${targetCurr}` : '';
    const bodyPayload: Record<string, string> = { env: _activeEnvironment };
    if (currency && currency.toUpperCase() !== 'USD') {
      bodyPayload.currency = currency.toUpperCase();
    }

    const data = await apiFetch<CostEstimateResponse>(
      `/api/projects/${projectId}/cost-estimates${query}`,
      {
        method: 'POST',
        body: JSON.stringify(bodyPayload),
      },
    );

    return (data.items ?? [])
      .filter((i) => i.confidence !== 'unsupported')
      .map(mapItem);
  }

  async compareCosts(nodes: CanvasNode[], currency?: string): Promise<CostComparisonResult> {
    const projectId = _activeProjectId;
    if (!projectId) {
      throw new Error('No active project context');
    }

    const targetCurr = (currency || _activeCurrency || 'USD').toUpperCase();
    const query = targetCurr !== 'USD' ? `?currency=${targetCurr}` : '';
    const bodyPayload: Record<string, string> = { env: _activeEnvironment };
    if (currency && currency.toUpperCase() !== 'USD') {
      bodyPayload.currency = currency.toUpperCase();
    }

    const data = await apiFetch<CostComparisonResult>(
      `/api/projects/${projectId}/cost-comparison${query}`,
      {
        method: 'POST',
        body: JSON.stringify(bodyPayload),
      },
    );

    return data;
  }

  generateOptimizations(nodes: CanvasNode[]): CostOptimization[] {
    // Client-side optimization suggestions based on node config
    // These are computed locally from the in-memory nodes for immediate UI feedback
    const opts: CostOptimization[] = [];

    for (const node of nodes) {
      if (node.resourceType === 'aws_ec2') {
        const instanceType = node.config['instanceType'] as string | undefined;
        if (instanceType && (instanceType.includes('xlarge') || instanceType.includes('2xlarge'))) {
          opts.push({
            id: `opt-${node.id}`,
            nodeId: node.id,
            nodeLabel: node.label,
            title: 'Right-size EC2 instance',
            description: `${node.label} uses ${instanceType}. Switching to the next smaller type could save ~$88-175/month based on typical utilization.`,
            potentialSavings: 88,
            effort: 'low',
          });
        }
      }
      if (node.resourceType === 'aws_nat') {
        const natCount = nodes.filter((n) => n.resourceType === 'aws_nat').length;
        if (natCount > 1) {
          opts.push({
            id: `opt-nat-${node.id}`,
            nodeId: node.id,
            nodeLabel: node.label,
            title: 'Consolidate NAT Gateways',
            description: 'Multiple NAT Gateways detected. Consolidating to a single gateway in non-HA environments saves ~$32/month per removed gateway.',
            potentialSavings: 32,
            effort: 'medium',
          });
        }
      }
      if (node.resourceType === 'aws_rds') {
        const instanceClass = node.config['instanceClass'] as string | undefined;
        if (instanceClass && (instanceClass.includes('r5') || instanceClass.includes('m5'))) {
          opts.push({
            id: `opt-rds-${node.id}`,
            nodeId: node.id,
            nodeLabel: node.label,
            title: 'Use RDS Reserved Instance pricing',
            description: `${node.label} is on on-demand pricing. A 1-year Reserved Instance can save up to 42%.`,
            potentialSavings: 55,
            effort: 'low',
          });
        }
      }
      if (node.resourceType === 'aws_s3') {
        opts.push({
          id: `opt-s3-${node.id}`,
          nodeId: node.id,
          nodeLabel: node.label,
          title: 'Enable S3 Intelligent-Tiering',
          description: 'Automatically moves objects to cheaper tiers. Can save 40-68% on infrequently accessed objects.',
          potentialSavings: 12,
          effort: 'low',
        });
      }
    }

    return opts;
  }

  applyOptimization(nodes: CanvasNode[], optimizationId: string): CanvasNode[] {
    // Right-size EC2
    if (optimizationId.startsWith('opt-') && !optimizationId.startsWith('opt-nat-') && !optimizationId.startsWith('opt-rds-') && !optimizationId.startsWith('opt-s3-')) {
      const nodeId = optimizationId.replace(/^opt-/, '');
      return nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const current = n.config['instanceType'] as string | undefined;
        const downsized = current ? (INSTANCE_DOWNSIZE[current] ?? current) : current;
        return { ...n, config: { ...n.config, instanceType: downsized } };
      });
    }

    // NAT consolidation
    if (optimizationId.startsWith('opt-nat-')) {
      const natNodes = nodes.filter((n) => n.resourceType === 'aws_nat');
      if (natNodes.length <= 1) return nodes;
      const keepId = natNodes[0]!.id;
      return nodes.filter((n) => n.resourceType !== 'aws_nat' || n.id === keepId);
    }

    return nodes;
  }

}

export const apiCostService: ICostService = new ApiCostServiceImpl();
