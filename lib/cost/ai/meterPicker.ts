/**
 * AI picks the price-list entries; code reads the prices.
 *
 * For an Azure resource type with no hand-written lookup, the model is shown a short list of real Retail Prices API rows and says which
 * ones make up the resource's monthly bill and in what quantity. It never produces a price: every figure is the `retailPrice` of a row it
 * pointed at, converted by that row's own unit (lib/cloud/pricing/AzurePricingProvider.ts, monthlyFromRetailItem). Its answer is checked
 * in code and thrown away (so the built-in table prices the resource instead) when it points at a row that was not offered, uses an absurd
 * quantity, or lands outside the type's plausible range or far from the built-in estimate.
 */
import { monthlyFromRetailItem, type AzureRetailPriceItem } from '@/lib/cloud/pricing/AzurePricingProvider';
import type { NormalizedPrice } from '@/lib/cloud/pricing/types';
import { maxPlausibleMonthlyUsd } from './plausibility';
import type { AskModel } from './askModel';

/** Which Retail Prices API service(s) hold each resource type's meters (Azure files some of them under the "Global" region, or with no region at all, as Azure DNS does). */
export const AZURE_METER_SOURCES: Record<string, { service: string }> = {
  azure_redis: { service: 'Redis Cache' },
  azure_cosmos_db: { service: 'Azure Cosmos DB' },
  azure_nat: { service: 'NAT Gateway' },
  azure_bastion: { service: 'Azure Bastion' },
  azure_app_service: { service: 'Azure App Service' },
  azure_public_ip: { service: 'Virtual Network' },
  azure_dns: { service: 'Azure DNS' },
  azure_monitor: { service: 'Azure Monitor' },
};

export const AI_MATCHED_SOURCE = 'azure-retail-api-ai-matched';

const MAX_CANDIDATES = 40;
const MAX_PICKS = 4;
/** How far the AI-matched total may be from the built-in estimate before it is distrusted. */
const ANCHOR_FACTOR = 8;

const DROP = /spot|low priority|dev\/test|devtest|secondary|reservation|\bpreview\b/i;

export function azureMeterFilter(service: string, region: string): string {
  return `serviceName eq '${service}' and (armRegionName eq '${region}' or armRegionName eq 'Global' or armRegionName eq '') and priceType eq 'Consumption'`;
}

const tokens = (v: unknown): string[] => String(v ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

/** Candidate rows, with obviously irrelevant ones removed and the ones matching the resource's own settings first. */
export function selectCandidates(rows: AzureRetailPriceItem[], config: Record<string, unknown>): AzureRetailPriceItem[] {
  const wantsWindows = /windows/i.test(JSON.stringify(config));
  const want = new Set(Object.values(config).flatMap(tokens));
  const usable = rows.filter((r) =>
    r.retailPrice > 0 && r.tierMinimumUnits === 0 && !DROP.test(`${r.skuName} ${r.meterName} ${r.productName}`)
    && (wantsWindows || !/windows/i.test(r.productName)));
  const score = (r: AzureRetailPriceItem) => tokens(`${r.skuName} ${r.meterName} ${r.productName}`).filter((t) => want.has(t)).length;
  return usable
    .map((r, idx) => ({ r, idx, s: score(r) }))
    .sort((a, b) => b.s - a.s || a.idx - b.idx)
    .slice(0, MAX_CANDIDATES)
    .map((x) => x.r);
}

const SYSTEM = `You match a cloud resource to Azure Retail Prices API rows so its monthly cost can be computed. You NEVER state or compute prices: you only choose rows (by their index) and quantities.
Answer with JSON only: {"picks":[{"i":<row index>,"quantity":<number>,"reason":"<short>"}]}.
Rules:
- Choose the rows that make up this resource's regular monthly bill: fixed hourly or monthly charges first. At most ${MAX_PICKS} rows.
- For hourly or monthly rows, quantity is the number of units running (instances, nodes, units); default 1.
- For per-GB, per-operation or per-request rows, quantity is expected monthly usage in that row's own unit. Include such a row only when the resource settings give the usage, or assume a small light workload.
- Match the SKU, tier and size in the resource settings exactly. Never choose Spot, Low Priority, Dev/Test, Secondary or Windows rows unless the settings say Windows.
- If no row fits the resource, answer {"picks":[]}. Do not guess.`;

export interface MeterPickInput {
  resourceType: string;
  region: string;
  config: Record<string, unknown>;
  rows: AzureRetailPriceItem[];
  /** The built-in table's monthly estimate, used as a sanity anchor (null when it has none). */
  anchorMonthlyUsd: number | null;
  ask: AskModel;
}

export async function pickAzureMeters(input: MeterPickInput): Promise<NormalizedPrice | null> {
  const { resourceType, region, config, anchorMonthlyUsd, ask } = input;
  const candidates = selectCandidates(input.rows, config);
  if (candidates.length === 0) return null;

  const listing = candidates.map((r, i) => `${i}: ${r.productName} | ${r.skuName} | ${r.meterName} | unit ${r.unitOfMeasure}`).join('\n');
  const answer = await ask(SYSTEM, `Resource type: ${resourceType}\nRegion: ${region}\nSettings: ${JSON.stringify(config).slice(0, 1200)}\n\nRows:\n${listing}`);
  const picks = Array.isArray(answer?.['picks']) ? (answer!['picks'] as unknown[]) : [];
  if (picks.length === 0 || picks.length > MAX_PICKS) return null;

  const used = new Set<number>();
  // The price feed can list the same meter in more than one row (identical product, SKU, meter, unit and price). It is one charge: choosing
  // both would bill it twice (an Azure Redis Standard cache was shown at exactly double its real price this way).
  const seenMeters = new Set<string>();
  let monthly = 0;
  const lines: string[] = [];
  for (const p of picks) {
    const pick = p as { i?: unknown; quantity?: unknown };
    const i = pick.i;
    const q = Number(pick.quantity);
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= candidates.length || used.has(i)) return null; // a row that was never offered
    if (!Number.isFinite(q) || q <= 0 || q > 1_000_000) return null;
    used.add(i);
    const row = candidates[i]!;
    const signature = [row.productName, row.skuName, row.meterName, row.unitOfMeasure, row.retailPrice].join('|');
    if (seenMeters.has(signature)) continue;
    seenMeters.add(signature);
    const perUnitMonthly = monthlyFromRetailItem(row); // null for per-GB / per-operation rows
    const cost = perUnitMonthly !== null ? perUnitMonthly * q : row.retailPrice * q;
    monthly += cost;
    lines.push(`${row.productName} / ${row.skuName} / ${row.meterName}: $${row.retailPrice} per ${row.unitOfMeasure.replace(/^1\s*\/?\s*/, '') || 'unit'} × ${q} = $${cost.toFixed(2)}/mo`);
  }

  if (!Number.isFinite(monthly) || monthly <= 0 || monthly > maxPlausibleMonthlyUsd(resourceType)) return null;
  if (anchorMonthlyUsd && anchorMonthlyUsd > 0 && (monthly > anchorMonthlyUsd * ANCHOR_FACTOR || monthly < anchorMonthlyUsd / ANCHOR_FACTOR)) return null;

  return {
    provider: 'azure',
    service: AZURE_METER_SOURCES[resourceType]?.service ?? resourceType,
    resourceType,
    region,
    sku: 'AI-matched meters',
    pricingModel: 'on-demand',
    unit: '1 Hour',
    unitPrice: monthly / 730,
    monthlyPrice: monthly,
    currency: 'USD',
    description: `${resourceType} priced from ${picks.length} Azure Retail Prices API meter(s) chosen by AI`,
    source: AI_MATCHED_SOURCE,
    retrievedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    assumptions: [
      'The meters below were chosen by AI; every price is the official Azure list price of that meter.',
      ...lines,
      `Region: ${region}`,
    ],
  };
}
