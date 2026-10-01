/**
 * AI commentary for exported assessment reports.
 *
 * The browser sends the AI security review the user is looking at; the server never trusts it. Only the model's
 * wording (summary, problem, fix, suggestions) is kept — rule ids must exist in the report's own findings, and
 * titles / severities come from those findings, not from the request. It is rendered in its own labelled section and
 * never feeds scores, counts or the report's content hash.
 */
import { z } from 'zod';
import type { Finding } from '@/lib/engines/assessment/types';

export interface AiCommentary {
  generatedAt: string;
  summary: string;
  priorities: { ruleId: string; title: string; severity: string; problem: string; fix: string }[];
  /** Ideas the model had that no finding supports — always rendered as unverified. */
  suggestions: string[];
}

const text = (max: number) => z.string().trim().max(max);

/** Request shape (loosely bounded; sanitised below). */
export const AiCommentaryInputSchema = z.object({
  summary: text(800),
  priorities: z.array(z.object({ ruleId: text(80), problem: text(600).optional(), fix: text(800).optional() })).max(25).default([]),
  suggestions: z.array(text(600)).max(5).default([]),
});
export type AiCommentaryInput = z.infer<typeof AiCommentaryInputSchema>;

export function buildCommentary(input: AiCommentaryInput, findings: Finding[], generatedAt: string): AiCommentary | undefined {
  const byRule = new Map(findings.map((f) => [f.ruleId, f]));
  const seen = new Set<string>();
  const priorities: AiCommentary['priorities'] = [];
  for (const p of input.priorities) {
    const f = byRule.get(p.ruleId);
    if (!f || seen.has(p.ruleId)) continue;
    seen.add(p.ruleId);
    priorities.push({
      ruleId: f.ruleId, title: f.title, severity: f.severity.toLowerCase(),
      problem: (p.problem?.trim() || f.risk || f.observation).slice(0, 600),
      fix: (p.fix?.trim() || f.recommendation).slice(0, 800),
    });
  }
  const summary = input.summary.trim();
  const suggestions = input.suggestions.filter((s) => s.length > 0);
  if (!summary && priorities.length === 0 && suggestions.length === 0) return undefined;
  return { generatedAt, summary, priorities, suggestions };
}

export const COMMENTARY_DISCLAIMER =
  'AI-generated commentary. CloudCraft\'s analysis engine produced every finding, severity and score in this report; the AI only re-explains and orders them. It does not change any result and is not part of the report\'s integrity hash. Suggestions marked unverified are not backed by a finding.';

// ── Well-Architected report commentary ────────────────────────────────────────────────────────────────

export interface AiWaCommentary {
  generatedAt: string;
  summary: string;
  pillars: { key: string; label: string; assessment: string; topFixes: { ruleId: string; title: string; severity: string; fix: string }[] }[];
  plan: { ruleId: string; title: string; severity: string; action: string }[];
  suggestions: string[];
}

export const AiWaCommentaryInputSchema = z.object({
  summary: text(800),
  pillars: z.array(z.object({
    pillar: text(80),
    assessment: text(600).optional(),
    topFixes: z.array(z.object({ ruleId: text(80), fix: text(600).optional() })).max(5).default([]),
  })).max(20).default([]),
  plan: z.array(z.object({ ruleId: text(80), action: text(500).optional() })).max(12).default([]),
  suggestions: z.array(text(600)).max(5).default([]),
});
export type AiWaCommentaryInput = z.infer<typeof AiWaCommentaryInputSchema>;

/** The slice of the report the validation needs (kept structural so this file does not import the report builder). */
export interface WaReportPillar { provider: string; pillar: string; label: string; evaluable: boolean; findings: Finding[] }

/**
 * Pillar keys must be `provider:pillar` pairs in the report, rule ids must be findings of that pillar (plan: of any pillar),
 * and pillars with too little evidence always get fixed wording — the model is never allowed to opine on them.
 */
export function buildWaCommentary(input: AiWaCommentaryInput, pillars: WaReportPillar[], generatedAt: string): AiWaCommentary | undefined {
  const allByRule = new Map(pillars.flatMap((p) => p.findings).map((f) => [f.ruleId, f]));
  const modelPillars = new Map(input.pillars.map((p) => [p.pillar, p]));

  const out: AiWaCommentary['pillars'] = pillars.map((p) => {
    const key = `${p.provider}:${p.pillar}`;
    if (!p.evaluable) return { key, label: p.label, assessment: 'CloudCraft has too little evidence in this design to assess this pillar — add the relevant resources or settings before drawing conclusions.', topFixes: [] };
    const m = modelPillars.get(key);
    const rules = new Map(p.findings.map((f) => [f.ruleId, f]));
    const seen = new Set<string>();
    const topFixes: AiWaCommentary['pillars'][number]['topFixes'] = [];
    for (const x of m?.topFixes ?? []) {
      const f = rules.get(x.ruleId);
      if (!f || seen.has(x.ruleId)) continue;
      seen.add(x.ruleId);
      topFixes.push({ ruleId: f.ruleId, title: f.title, severity: f.severity.toLowerCase(), fix: (x.fix?.trim() || f.recommendation).slice(0, 600) });
      if (topFixes.length === 3) break;
    }
    return { key, label: p.label, assessment: m?.assessment?.trim() ?? '', topFixes };
  });

  const seenPlan = new Set<string>();
  const plan: AiWaCommentary['plan'] = [];
  for (const x of input.plan) {
    const f = allByRule.get(x.ruleId);
    if (!f || seenPlan.has(x.ruleId)) continue;
    seenPlan.add(x.ruleId);
    plan.push({ ruleId: f.ruleId, title: f.title, severity: f.severity.toLowerCase(), action: (x.action?.trim() || f.recommendation).slice(0, 500) });
  }
  const summary = input.summary.trim();
  const suggestions = input.suggestions.filter((s) => s.length > 0);
  const evaluable = new Set(pillars.filter((p) => p.evaluable).map((p) => `${p.provider}:${p.pillar}`));
  const hasPillarText = out.some((p) => evaluable.has(p.key) && (p.assessment || p.topFixes.length > 0));
  if (!summary && !hasPillarText && plan.length === 0 && suggestions.length === 0) return undefined;
  return { generatedAt, summary, pillars: out, plan, suggestions };
}
