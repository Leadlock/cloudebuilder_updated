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
