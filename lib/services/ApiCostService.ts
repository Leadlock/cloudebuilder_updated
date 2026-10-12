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
import { calculateCosts } from '@/lib/analysis';

/**
 * One side (current or translated) of a comparison. `items` are full
 * CostItems — the same shape CostPanel already renders — with `monthlyCost`
 * already converted to `currency` via mapItem's isConverted logic, so
 * callers never need to re-derive a converted value themselves.
 *
 * totalMonthlyUsd/totalHourlyUsd stay in raw USD for reference; the values
 * a UI should actually DISPLAY are totalMonthlyConverted/totalHourlyConverted
 * (which equal the USD figures when currency is 'USD').
 */
export interface CostComparisonSide {
  items: CostItem[];
  /** Resources whose confidence came back 'unsupported' — priced at nothing, excluded from `items`/totals. */
  unsupportedCount: number;
  /** items.length + unsupportedCount. */
  totalResourceCount: number;
  /** 0-100. (totalResourceCount - unsupportedCount) / totalResourceCount, i.e. how much of this side's cost is a real number vs a known gap. 100 when there are zero resources. */
  pricingCoveragePct: number;
  totalMonthlyUsd: number;
  totalHourlyUsd: number;
  totalMonthlyConverted: number;
  totalHourlyConverted: number;
  currency: string;
}

export interface CostComparisonResult {
  currentProvider: string;
  targetProvider: string;
  current: CostComparisonSide;
  translated: CostComparisonSide;
  targetCurrency: string;
  /** Other-cloud equivalents chosen by the AI rather than the fixed table (shown with an "AI match" badge). */
  aiMatches?: { resourceId: string; from: string; to: string; reason: string }[];
  /** Lines with an implausibly high price (computed in code). */
  anomalies?: { current: CostAnomalyView[]; translated: CostAnomalyView[] };
  /** How far each line and each side can be trusted (computed in code on the server). */
  quality?: { current: SideQuality; translated: SideQuality };
  /** Plain-language things the person can fix to get better prices. */
  notices?: string[];
}

export interface SideQuality {
  /** Keyed by the line's resource id (the same id as CostItem.nodeId). */
  lines: Record<string, { status: 'verified' | 'estimate' | 'check' | 'unpriced'; notes: string[]; excludes: string[]; assumes: string[] }>;
  summary: { verified: number; estimates: number; check: number; unpriced: number; verifiedUsd: number; estimateUsd: number; checkUsd: number };
  /** When the oldest price on this side was fetched from the official list. */
  oldestPriceAt: string | null;
}

export interface CostAnomalyView { resourceId: string; label: string; resourceType: string; monthlyUsd: number; reason: string }

/**
 * Raw shape POST /api/projects/:id/cost-comparison actually returns — each
 * side is a CostEstimationResult (lib/engines/cost/types.ts) as returned
 * directly by CostEstimator.estimateAsync, NOT a CostEstimateResponse (that
 * type additionally carries estimateId/architectureId, which the
 * comparison route never sets since it doesn't persist an estimate row).
 */
interface ApiCostComparisonSide {
  items: ApiCostLineItem[];
  totalMonthlyUsd: number;
  totalHourlyUsd: number;
  totalMonthlyConverted?: number;
  totalHourlyConverted?: number;
  currency: string;
}
interface ApiCostComparisonResponse {
  currentProvider: string;
  targetProvider: string;
  current: ApiCostComparisonSide;
  translated: ApiCostComparisonSide;
  targetCurrency: string;
  aiMatches?: CostComparisonResult['aiMatches'];
  anomalies?: CostComparisonResult['anomalies'];
  quality?: CostComparisonResult['quality'];
  notices?: string[];
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
  pricingTier?: 'LIVE' | 'CACHED_LIVE' | 'FALLBACK_ESTIMATE' | 'UNAVAILABLE';
  pricingIsStale?: boolean;
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
    exchangeRateTier?: 'LIVE' | 'CACHED_LIVE' | 'FALLBACK_ESTIMATE' | 'UNAVAILABLE';
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
    // Items from the server without a tier predate tiering; never assume they are live.
    pricingTier: item.pricingTier ?? (item.confidence === 'unsupported' ? 'UNAVAILABLE' : 'FALLBACK_ESTIMATE'),
    pricingIsStale: item.pricingIsStale,
    exchangeRateTier: item.convertedPrice?.exchangeRateTier,
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

/**
 * Convert the canvas's live CanvasNode[] into the wire shape the
 * cost-estimates/cost-comparison routes accept as an optional `resources`
 * override. Sending this (rather than relying on the server to re-read the
 * persisted architecture) is what makes a scale-profile change, or any other
 * unsaved edit, show up in the cost estimate immediately — previously the
 * `nodes` parameter here was accepted but never actually sent, so the
 * estimate always reflected whatever was last autosaved (800ms debounced),
 * not what's currently on screen. "Change expected users, cost stays the
 * same" was this: the estimate request fired before the autosave landed.
 */
function nodesToResourcePayload(nodes: CanvasNode[]) {
  return nodes.map((n) => ({
    id: n.id,
    resourceType: n.resourceType,
    provider: n.provider,
    label: n.label,
    region: n.region ?? null,
    config: n.config ?? {},
  }));
}

class ApiCostServiceImpl implements ICostService {

  async calculateCosts(nodes: CanvasNode[], currency?: string): Promise<CostItem[]> {
    const projectId = _activeProjectId;
    if (!projectId) {
      throw new Error('No active project context');
    }

    const targetCurr = (currency || _activeCurrency || 'USD').toUpperCase();
    const query = targetCurr !== 'USD' ? `?currency=${targetCurr}` : '';
    const bodyPayload: Record<string, unknown> = { env: _activeEnvironment };
    if (currency && currency.toUpperCase() !== 'USD') {
      bodyPayload.currency = currency.toUpperCase();
    }
    if (nodes.length > 0) {
      bodyPayload.resources = nodesToResourcePayload(nodes);
    }

    const data = await apiFetch<CostEstimateResponse>(
      `/api/projects/${projectId}/cost-estimates${query}`,
      {
        method: 'POST',
        body: JSON.stringify(bodyPayload),
      },
    );

    // Unpriced items are kept (tier UNAVAILABLE) so the UI can say so instead of hiding them.
    return (data.items ?? []).map(mapItem);
  }

  async compareCosts(nodes: CanvasNode[], currency?: string, opts?: { refresh?: boolean }): Promise<CostComparisonResult> {
    const projectId = _activeProjectId;
    if (!projectId) {
      throw new Error('No active project context');
    }

    const targetCurr = (currency || _activeCurrency || 'USD').toUpperCase();
    const query = targetCurr !== 'USD' ? `?currency=${targetCurr}` : '';
    const bodyPayload: Record<string, unknown> = { env: _activeEnvironment };
    if (currency && currency.toUpperCase() !== 'USD') {
      bodyPayload.currency = currency.toUpperCase();
    }
    if (nodes.length > 0) {
      bodyPayload.resources = nodesToResourcePayload(nodes);
    }
    if (opts?.refresh) bodyPayload.refresh = true;

    const data = await apiFetch<ApiCostComparisonResponse>(
      `/api/projects/${projectId}/cost-comparison${query}`,
      {
        method: 'POST',
        body: JSON.stringify(bodyPayload),
      },
    );

    // mapItem (used by calculateCosts above) is the single source of truth
    // for "which number does the UI actually display" — reused here so the
    // comparison panel can never regress to showing raw USD figures under a
    // non-USD currency label the way it previously did.
    const toSide = (side: ApiCostComparisonSide): CostComparisonSide => {
      const rawItems = side.items ?? [];
      const unsupportedCount = rawItems.filter((i) => i.confidence === 'unsupported').length;
      const totalResourceCount = rawItems.length;
      return {
        items: rawItems.filter((i) => i.confidence !== 'unsupported').map(mapItem),
        unsupportedCount,
        totalResourceCount,
        pricingCoveragePct: totalResourceCount > 0 ? ((totalResourceCount - unsupportedCount) / totalResourceCount) * 100 : 100,
        totalMonthlyUsd: side.totalMonthlyUsd,
        totalHourlyUsd: side.totalHourlyUsd,
        totalMonthlyConverted: side.totalMonthlyConverted ?? side.totalMonthlyUsd,
        totalHourlyConverted: side.totalHourlyConverted ?? side.totalHourlyUsd,
        currency: side.currency,
      };
    };

    return {
      currentProvider: data.currentProvider,
      targetProvider: data.targetProvider,
      current: toSide(data.current),
      translated: toSide(data.translated),
      targetCurrency: data.targetCurrency,
      aiMatches: data.aiMatches ?? [],
      anomalies: data.anomalies ?? { current: [], translated: [] },
      ...(data.quality ? { quality: data.quality } : {}),
      ...(data.notices && data.notices.length > 0 ? { notices: data.notices } : {}),
    };
  }

  /** "This price looks wrong": sends one line and a note to the team. Changes nothing on screen. */
  async reportPrice(report: { resourceId: string; resourceType: string; provider: string; region: string; monthlyUsd: number; pricingTier?: string | null; assumptions?: string[]; note: string }): Promise<void> {
    const projectId = _activeProjectId;
    if (!projectId) throw new Error('No active project context');
    await apiFetch(`/api/projects/${projectId}/cost-comparison/report`, { method: 'POST', body: JSON.stringify(report) });
  }

  /** AI explanation and savings ideas (a paid model call, so only on request). All numbers in it were calculated by the server. */
  async getInsights(nodes: CanvasNode[]): Promise<import('@/lib/cost/ai/insights').CostInsights> {
    const projectId = _activeProjectId;
    if (!projectId) throw new Error('No active project context');
    return apiFetch(`/api/projects/${projectId}/cost-insights`, {
      method: 'POST',
      body: JSON.stringify({ env: _activeEnvironment, ...(nodes.length > 0 ? { resources: nodesToResourcePayload(nodes) } : {}) }),
    });
  }

  generateOptimizations(nodes: CanvasNode[]): CostOptimization[] {
    // Client-side optimization suggestions based on node config
    // These are computed locally from the in-memory nodes for immediate UI feedback.
    // Savings are percentages of each node's REAL current monthly cost (from
    // calculateCosts — the same engine the rest of the UI uses to show
    // "Est. Monthly Cost"), never a flat dollar constant: a t3.large and an
    // m5.xlarge do not cost the same to right-size, so they must not report
    // the same savings figure.
    const opts: CostOptimization[] = [];
    const costByNodeId = new Map(calculateCosts(nodes).map((c) => [c.nodeId, c.monthlyCost]));

    for (const node of nodes) {
      const currentMonthly = costByNodeId.get(node.id) ?? 0;

      if (node.resourceType === 'aws_ec2') {
        const instanceType = node.config['instanceType'] as string | undefined;
        if (instanceType && (instanceType.includes('xlarge') || instanceType.includes('2xlarge'))) {
          const savings = Math.round(currentMonthly * 0.4);
          opts.push({
            id: `opt-${node.id}`,
            nodeId: node.id,
            nodeLabel: node.label,
            title: 'Right-size EC2 instance',
            description: `${node.label} uses ${instanceType} (~$${Math.round(currentMonthly)}/mo). Switching to the next smaller type could save roughly 40% based on typical utilization.`,
            potentialSavings: savings,
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
            description: `Multiple NAT Gateways detected. Consolidating to a single gateway in non-HA environments saves this gateway's ~$${Math.round(currentMonthly)}/month.`,
            potentialSavings: Math.round(currentMonthly),
            effort: 'medium',
          });
        }
      }
      if (node.resourceType === 'aws_rds') {
        const instanceClass = node.config['instanceClass'] as string | undefined;
        if (instanceClass && (instanceClass.includes('r5') || instanceClass.includes('m5'))) {
          const savings = Math.round(currentMonthly * 0.3);
          opts.push({
            id: `opt-rds-${node.id}`,
            nodeId: node.id,
            nodeLabel: node.label,
            title: 'Use RDS Reserved Instance pricing',
            description: `${node.label} is on on-demand pricing (~$${Math.round(currentMonthly)}/mo). A 1-year Reserved Instance can save up to 42%; ~30% is a typical no-upfront outcome.`,
            potentialSavings: savings,
            effort: 'low',
          });
        }
      }
      if (node.resourceType === 'aws_s3') {
        const savings = Math.round(currentMonthly * 0.2);
        opts.push({
          id: `opt-s3-${node.id}`,
          nodeId: node.id,
          nodeLabel: node.label,
          title: 'Enable S3 Intelligent-Tiering',
          description: `Automatically moves objects to cheaper tiers. Can save up to 68% on infrequently accessed objects; ~20% of this bucket's ~$${Math.round(currentMonthly)}/mo is a conservative typical estimate.`,
          potentialSavings: savings,
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
