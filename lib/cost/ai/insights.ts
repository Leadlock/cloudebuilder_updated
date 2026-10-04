/**
 * AI explanation and savings ideas for a cost comparison.
 *
 * The model reads the computed result and writes words: a short summary, why the biggest lines cost what they do, and settings it thinks
 * could be cheaper. It never supplies a number that is shown:
 *  - totals, shares and every saving come from CloudCraft's own estimator (a suggestion is applied to a copy of the resource and re-priced);
 *  - sentences containing a currency amount or percentage are dropped from the model's text;
 *  - a suggestion must name a resource that exists, a setting that is a real dropdown of that resource, and one of its real options.
 * Anything that fails a check is silently discarded.
 */
import type { CostEstimationInput, CostEstimationResult, CostLineItem } from '@/lib/engines/cost/types';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';
import { getResourceDefinition } from '@/lib/resources';
import type { AskModel } from './askModel';

export interface CostInsightFacts {
  currentProvider: string;
  targetProvider: string;
  currentMonthlyUsd: number;
  targetMonthlyUsd: number;
  /** Target relative to current, in percent (negative = target is cheaper). */
  differencePct: number;
  topDrivers: { resourceId: string; label: string; resourceType: string; monthlyUsd: number; sharePct: number; why: string }[];
}

export interface CostSuggestion {
  resourceId: string;
  label: string;
  field: string;
  fieldLabel: string;
  from: string;
  to: string;
  rationale: string;
  currentMonthlyUsd: number;
  newMonthlyUsd: number;
  savingUsd: number;
}

export interface CostInsights {
  generatedAt: string;
  facts: CostInsightFacts;
  /** Model wording, with any sentence that contained an amount or percentage removed. May be empty. */
  summary: string;
  suggestions: CostSuggestion[];
  disclaimer: string;
}

export const INSIGHTS_DISCLAIMER =
  'The explanation and ideas were written by AI. Every price and saving shown here was calculated by CloudCraft from provider list prices: each suggestion was applied to a copy of the resource and re-priced. Check an idea against your real workload before acting on it.';

type Estimator = { estimateAsync(input: CostEstimationInput, mode?: 'REAL' | 'TEST'): Promise<CostEstimationResult> };

const AMOUNT = /[$€£₹¥]|\d+(?:[.,]\d+)?\s?(?:%|percent\b|x\b)|\b\d{3,}\b/i;

/**
 * Which cloud is cheaper overall is shown from the computed totals; a model sentence about it is dropped, because a wrong one (it once
 * said AWS was the dearer side while Azure's total was higher) would sit right next to the real numbers.
 */
const CLOUD_VERDICT = /\b(aws|azure|amazon|microsoft|alternative|current)\b[^.!?]*\b(cheaper|more expensive|costlier|less expensive|more costly|higher cost|lower cost|costs more|costs less|incurs? higher|incurs? lower|saves?)\b|\b(cheaper|more expensive|costlier|less expensive|more costly)\b[^.!?]*\b(aws|azure|amazon|microsoft)\b/i;

/** Keeps only the sentences with no money or percentage in them and no cloud-vs-cloud verdict (those facts must come from code, not from the model). */
export function withoutFigures(text: unknown, maxLength: number): string {
  if (typeof text !== 'string') return '';
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*/g) ?? [];
  return sentences.map((s) => s.trim()).filter((s) => s && !AMOUNT.test(s) && !CLOUD_VERDICT.test(s)).join(' ').slice(0, maxLength).trim();
}

const SYSTEM = `You are a cloud cost analyst reviewing a computed cost comparison. All prices were already calculated; you only explain and suggest.
Answer with JSON only:
{"summary":"<2-3 sentences on which kinds of resources drive the bill and why>",
 "why":[{"resourceId":"<id>","text":"<one sentence on why this resource costs what it does>"}],
 "suggestions":[{"resourceId":"<id>","field":"<setting key>","value":"<one of that setting's listed options>","rationale":"<one sentence>"}]}
Rules:
- NEVER write a price, a total, a percentage or any number with a currency symbol. Describe in words only (for example "the database dominates the bill").
- Do NOT say which cloud is cheaper or more expensive overall; the app shows that from the real totals. Talk about resources, not about a winner.
- A suggestion may only change a setting that is listed for that resource, to one of the options listed for it, and only where a cheaper option would plausibly still meet the workload. Give at most 5.
- Use resource ids exactly as given. If you have no genuine suggestion, return an empty list.`;

const tunable = (resourceType: string, config: Record<string, unknown>) => {
  const def = getResourceDefinition(resourceType);
  return (def?.configSchema ?? [])
    .filter((f) => f.type === 'select' && f.options && f.options.length > 1)
    .map((f) => ({ key: f.key, label: f.label, current: String(config[f.key] ?? f.defaultValue ?? ''), options: f.options!.map((o) => o.value) }));
};

const parse = (json: string): Record<string, unknown> => { try { const v = JSON.parse(json); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

export async function buildCostInsights(args: {
  currentProvider: string;
  targetProvider: string;
  current: CostEstimationResult;
  translated: CostEstimationResult;
  /** The current side's resources, used to re-price each suggestion. */
  resources: DbArchitectureResource[];
  estimateInput: Omit<CostEstimationInput, 'resources'>;
  estimator: Estimator;
  ask: AskModel;
  now?: Date;
}): Promise<CostInsights> {
  const { current, translated, resources, estimator } = args;
  const billable = (items: CostLineItem[]) => items.filter((i) => i.confidence !== 'unsupported' && i.monthlyUsd > 0);
  const lines = billable(current.items);
  const total = current.totalMonthlyUsd;

  const top = [...lines].sort((a, b) => b.monthlyUsd - a.monthlyUsd).slice(0, 3);
  const byId = new Map(resources.map((r) => [r.id, r]));

  const prompt = JSON.stringify({
    currentProvider: args.currentProvider,
    targetProvider: args.targetProvider,
    currentSide: lines.map((i) => {
      const r = byId.get(i.resourceId);
      const config = r ? parse(r.configJson) : {};
      return { resourceId: i.resourceId, label: i.resourceLabel, type: i.resourceType, monthlyUsd: Math.round(i.monthlyUsd * 100) / 100, settings: JSON.stringify(config).slice(0, 500), tunable: tunable(i.resourceType, config) };
    }),
    targetSide: billable(translated.items).map((i) => ({ label: i.resourceLabel, type: i.resourceType, monthlyUsd: Math.round(i.monthlyUsd * 100) / 100 })),
  }).slice(0, 14_000);

  let answer: Record<string, unknown> | undefined;
  try { answer = await args.ask(SYSTEM, prompt); } catch { answer = undefined; }

  // Why the biggest lines cost what they do (model wording only; shares are computed here).
  const whyById = new Map<string, string>();
  for (const w of Array.isArray(answer?.['why']) ? (answer!['why'] as unknown[]) : []) {
    const x = w as { resourceId?: unknown; text?: unknown };
    if (typeof x.resourceId === 'string' && lines.some((l) => l.resourceId === x.resourceId)) {
      const t = withoutFigures(x.text, 220);
      if (t) whyById.set(x.resourceId, t);
    }
  }

  // Suggestions: validated against the real resource catalogue, then re-priced by the estimator.
  const suggestions: CostSuggestion[] = [];
  const seen = new Set<string>();
  const raw = Array.isArray(answer?.['suggestions']) ? (answer!['suggestions'] as unknown[]).slice(0, 8) : [];
  for (const s of raw) {
    const x = s as { resourceId?: unknown; field?: unknown; value?: unknown; rationale?: unknown };
    if (typeof x.resourceId !== 'string' || typeof x.field !== 'string' || typeof x.value !== 'string') continue;
    const line = lines.find((l) => l.resourceId === x.resourceId);
    const resource = byId.get(x.resourceId);
    if (!line || !resource || seen.has(`${x.resourceId}:${x.field}`)) continue;
    const config = parse(resource.configJson);
    const field = tunable(resource.resourceType, config).find((f) => f.key === x.field);
    if (!field || !field.options.includes(x.value) || x.value === field.current) continue;
    const def = getResourceDefinition(resource.resourceType)!;

    let repriced: CostEstimationResult;
    try {
      repriced = await estimator.estimateAsync({ ...args.estimateInput, resources: [{ ...resource, configJson: JSON.stringify({ ...config, [x.field]: x.value }) }] }, 'REAL');
    } catch { continue; }
    const after = repriced.items[0];
    if (!after || after.confidence === 'unsupported' || after.pricingTier === 'UNAVAILABLE') continue;
    const saving = line.monthlyUsd - after.monthlyUsd;
    if (!(saving >= 1) || saving < line.monthlyUsd * 0.03) continue; // only genuine savings
    seen.add(`${x.resourceId}:${x.field}`);
    suggestions.push({
      resourceId: line.resourceId, label: line.resourceLabel, field: x.field,
      fieldLabel: def.configSchema.find((f) => f.key === x.field)?.label ?? x.field,
      from: field.current, to: x.value, rationale: withoutFigures(x.rationale, 240),
      currentMonthlyUsd: line.monthlyUsd, newMonthlyUsd: after.monthlyUsd, savingUsd: saving,
    });
  }
  suggestions.sort((a, b) => b.savingUsd - a.savingUsd);

  const currentMonthlyUsd = current.totalMonthlyUsd;
  const targetMonthlyUsd = translated.totalMonthlyUsd;
  return {
    generatedAt: (args.now ?? new Date()).toISOString(),
    facts: {
      currentProvider: args.currentProvider,
      targetProvider: args.targetProvider,
      currentMonthlyUsd,
      targetMonthlyUsd,
      differencePct: currentMonthlyUsd > 0 ? ((targetMonthlyUsd - currentMonthlyUsd) / currentMonthlyUsd) * 100 : 0,
      topDrivers: top.map((i) => ({
        resourceId: i.resourceId, label: i.resourceLabel, resourceType: i.resourceType, monthlyUsd: i.monthlyUsd,
        sharePct: total > 0 ? (i.monthlyUsd / total) * 100 : 0, why: whyById.get(i.resourceId) ?? '',
      })),
    },
    summary: withoutFigures(answer?.['summary'], 600),
    suggestions: suggestions.slice(0, 5),
    disclaimer: INSIGHTS_DISCLAIMER,
  };
}
