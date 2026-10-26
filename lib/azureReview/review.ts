/**
 * The Azure Well-Architected review sheet: Microsoft's design review checklist, pre-filled from what CloudBuilder knows about the design and from the
 * team's answers. Nothing here is a verdict. Each recommendation gets one of four states, and a recommendation CloudBuilder has no evidence for is left
 * for the team: a diagram says nothing about culture, process or testing, and a sheet that pretended otherwise would be worse than an empty one.
 */
import type { Evaluation } from '@/lib/engines/assessment/types';
import { AZURE_CHECKLIST, AZURE_CHECKLIST_URL, AZURE_PILLAR_LABEL, AZURE_PILLAR_ORDER, type AzureChecklistItem, type AzurePillar } from './checklist';

export type ReviewState = 'gap' | 'met' | 'answer_needed' | 'not_assessed';

export interface ReviewRow {
  code: string; pillar: AzurePillar; title: string; state: ReviewState;
  /** Why: the checks that found a gap, how many things passed, or what is missing. */
  basis: string[];
  /** How many of the recommendation's checks passed / failed / could not tell. */
  passed: number; failed: number; unclear: number; unanswered: number;
}

export interface AzureReview {
  generatedFor: { project: string; environment: string };
  rulesetVersion: string; evaluatedAt: string;
  rows: ReviewRow[];
  counts: Record<ReviewState, number>;
  total: number;
}

const isAnswerRule = (id: string) => id.startsWith('WAQ-') || id.includes('-EXT-');

export function buildAzureReview(evaluations: readonly Evaluation[], meta: { project: string; environment: string; rulesetVersion: string; evaluatedAt: string }): AzureReview {
  const byRule = new Map<string, Evaluation[]>();
  for (const e of evaluations) { const l = byRule.get(e.ruleId) ?? []; l.push(e); byRule.set(e.ruleId, l); }

  const rows = AZURE_CHECKLIST.map((item: AzureChecklistItem): ReviewRow => {
    const evs = item.evidence.flatMap((id) => byRule.get(id) ?? []);
    const failing = evs.filter((e) => e.status === 'FAIL' || e.status === 'WARNING');
    const passed = evs.filter((e) => e.status === 'PASS').length;
    const unclear = evs.filter((e) => e.status === 'INSUFFICIENT_DATA').length;
    const unanswered = evs.filter((e) => e.status === 'NOT_EVALUATED' && isAnswerRule(e.ruleId)).length;
    const basis: string[] = [];
    let state: ReviewState;
    if (item.evidence.length === 0) { state = 'not_assessed'; basis.push('A design cannot show this: the team answers it.'); }
    else if (failing.length > 0) {
      state = 'gap';
      const seen = new Set<string>();
      for (const e of failing) { const line = `${e.ruleId}: ${e.observation}`.replace(/\s+/g, ' ').slice(0, 200); if (!seen.has(line) && seen.size < 6) { seen.add(line); basis.push(line); } }
    } else if (passed > 0 && unclear === 0 && unanswered === 0) { state = 'met'; basis.push(`${passed} check${passed === 1 ? '' : 's'} passed${evs.some((e) => isAnswerRule(e.ruleId) && e.status === 'PASS') ? ', some from the team\'s answers' : ''}.`); }
    else if (passed > 0) { state = 'answer_needed'; basis.push(`${passed} check${passed === 1 ? '' : 's'} passed, but ${unclear + unanswered} could not be judged yet.`); }
    else { state = 'answer_needed'; basis.push(evs.length === 0 ? 'Nothing in this design is covered by this recommendation, so it needs the team\'s answer.' : 'Not enough information yet: answer the related questions in the Well-Architected tab.'); }
    return { code: item.code, pillar: item.pillar, title: item.title, state, basis, passed, failed: failing.length, unclear, unanswered };
  });

  const counts: Record<ReviewState, number> = { gap: 0, met: 0, answer_needed: 0, not_assessed: 0 };
  for (const r of rows) counts[r.state]++;
  return { generatedFor: { project: meta.project, environment: meta.environment }, rulesetVersion: meta.rulesetVersion, evaluatedAt: meta.evaluatedAt, rows, counts, total: rows.length };
}

const STATE_LABEL: Record<ReviewState, string> = { gap: 'Gap', met: 'Met by the design or answers', answer_needed: 'Answer needed', not_assessed: 'For the team' };
const CELL = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

export function azureReviewMarkdown(r: AzureReview): string {
  const out: string[] = [];
  out.push(`# Azure Well-Architected review sheet: ${r.generatedFor.project}`, '');
  out.push(`Environment: ${r.generatedFor.environment} · CloudBuilder rule set ${r.rulesetVersion} · ${r.evaluatedAt.slice(0, 10)}`, '');
  out.push(
    'This sheet pre-fills Microsoft\'s Azure Well-Architected Framework design review checklists from what CloudBuilder can see in the architecture design and from the answers your team gave. ' +
    'It is a starting point for a review, **not** a Microsoft review, a certification or a compliance report.', '',
    `**Coverage.** ${r.counts.gap + r.counts.met} of ${r.total} recommendations have evidence from the design or your answers (${r.counts.gap} gap${r.counts.gap === 1 ? '' : 's'}, ${r.counts.met} met). ` +
    `${r.counts.answer_needed} need an answer or more detail, and ${r.counts.not_assessed} are about practices a design cannot show, so your team answers them. A recommendation marked "met" means the checks CloudBuilder has for it passed, not that the whole recommendation is satisfied.`, '',
  );
  for (const pillar of AZURE_PILLAR_ORDER) {
    const rows = r.rows.filter((x) => x.pillar === pillar);
    const c = (s: ReviewState) => rows.filter((x) => x.state === s).length;
    out.push(`## ${AZURE_PILLAR_LABEL[pillar]}`, '', `${c('gap')} gap, ${c('met')} met, ${c('answer_needed')} answer needed, ${c('not_assessed')} for the team · [Microsoft's checklist](${AZURE_CHECKLIST_URL(pillar)})`, '');
    out.push('| Code | Recommendation | State | Basis | Team decision / notes |', '|---|---|---|---|---|');
    for (const x of rows) out.push(`| ${x.code} | ${CELL(x.title)} | ${STATE_LABEL[x.state]} | ${CELL(x.basis.join(' '))} | |`);
    out.push('');
  }
  return out.join('\n');
}
