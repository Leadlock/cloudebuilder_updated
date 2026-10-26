/**
 * Turns CloudBuilder's check results into what to write to the AWS Well-Architected Tool. Pure: no AWS, no database.
 *
 * Rules that keep the Tool honest:
 *  - a best practice is only marked as in place when at least one mapped check PASSED and none failed, warned or lacked data;
 *  - nothing a person already selected is ever removed (the Tool replaces the selection on update, so ours is added to theirs);
 *  - practices with no evidence are left alone, never marked "none of these";
 *  - our remarks go in a marked block of the answer's notes, so a person's own notes around it are kept.
 */
import type { Evaluation } from '@/lib/engines/assessment/types';
import { AWS_BEST_PRACTICES, type BestPracticeMapping } from './awsMap';

export type PracticeState = 'met' | 'not_met' | 'unknown';

export interface PracticeEvidence {
  bp: string;
  choiceId: string;
  title: string;
  state: PracticeState;
  passed: number;
  /** One line per failing or warning check. */
  problems: string[];
  /** Checks that could not tell (missing configuration). */
  unclear: number;
}

/** A question of the workload as the Tool lists it. */
export interface ToolAnswer {
  questionId: string;
  questionTitle: string;
  choices: { id: string; title: string }[];
  selected: string[];
}

export interface AnswerUpdate {
  questionId: string;
  questionTitle: string;
  /** The full selection to write, or undefined when only the notes change. */
  selectedChoices?: string[];
  /** Choices this update adds. */
  added: string[];
  notesBlock: string;
}

export interface SyncPlan {
  practices: PracticeEvidence[];
  updates: AnswerUpdate[];
  /** Practices whose choice the Tool's lens does not list (the Framework changed): reported, never guessed. */
  unmatched: PracticeEvidence[];
}

const BLOCK_START = '--- CloudBuilder';
const BLOCK_END = '--- end CloudBuilder ---';
const NOTES_LIMIT = 2000; // the Tool accepts 2084 characters

export function evaluatePractices(evaluations: readonly Evaluation[], map: readonly BestPracticeMapping[] = AWS_BEST_PRACTICES): PracticeEvidence[] {
  return map.map((m) => {
    const evs = evaluations.filter((e) => m.ruleIds.includes(e.ruleId));
    const failing = evs.filter((e) => e.status === 'FAIL' || e.status === 'WARNING');
    const passed = evs.filter((e) => e.status === 'PASS').length;
    const unclear = evs.filter((e) => e.status === 'INSUFFICIENT_DATA').length;
    const problems = [...new Set(failing.map((e) => `${e.ruleId}: ${e.observation}`.replace(/\s+/g, ' ').slice(0, 160)))].slice(0, 5);
    const state: PracticeState = failing.length > 0 ? 'not_met' : unclear === 0 && passed > 0 ? 'met' : 'unknown';
    return { bp: m.bp, choiceId: m.choiceId, title: m.title, state, passed, problems, unclear };
  });
}

/** Puts our block into the notes, replacing an earlier block of ours and keeping everything else. */
export function mergeNotes(existing: string, block: string): string {
  const s = existing.indexOf(BLOCK_START);
  const e = existing.indexOf(BLOCK_END);
  const kept = s >= 0 && e > s ? `${existing.slice(0, s)}${existing.slice(e + BLOCK_END.length)}`.trim() : existing.trim();
  const out = kept ? `${kept}\n\n${block}` : block;
  // Never cut a person's notes to make room: shorten our block instead.
  const room = NOTES_LIMIT - (kept ? kept.length + 2 : 0);
  return out.length <= NOTES_LIMIT ? out : `${kept ? `${kept}\n\n` : ''}${block.slice(0, Math.max(room - BLOCK_END.length - 5, 0))}…\n${BLOCK_END}`;
}

export function planSync(evaluations: readonly Evaluation[], answers: readonly ToolAnswer[], opts: { rulesetVersion: string; evaluatedAt: string }): SyncPlan {
  const practices = evaluatePractices(evaluations);
  const byQuestion = new Map<string, { answer: ToolAnswer; items: PracticeEvidence[] }>();
  const unmatched: PracticeEvidence[] = [];
  for (const p of practices) {
    const answer = answers.find((a) => a.choices.some((c) => c.id === p.choiceId));
    if (!answer) { unmatched.push(p); continue; }
    const entry = byQuestion.get(answer.questionId) ?? { answer, items: [] };
    entry.items.push(p);
    byQuestion.set(answer.questionId, entry);
  }
  const updates: AnswerUpdate[] = [];
  for (const { answer, items } of byQuestion.values()) {
    const add = items.filter((p) => p.state === 'met' && !answer.selected.includes(p.choiceId)).map((p) => p.choiceId);
    const lines = [`${BLOCK_START}, ruleset ${opts.rulesetVersion}, ${opts.evaluatedAt.slice(0, 10)}: read from the architecture design, to be reviewed by a person ---`];
    for (const p of items) {
      if (p.state === 'met') lines.push(`In place by design: ${p.bp} ${p.title} (${p.passed} check${p.passed === 1 ? '' : 's'} passed).`);
      else if (p.state === 'not_met') lines.push(`Not in place: ${p.bp} ${p.title}.`, ...p.problems.map((x) => `  - ${x}`));
      else lines.push(`No evidence either way: ${p.bp} ${p.title}${p.unclear ? ` (${p.unclear} check${p.unclear === 1 ? '' : 's'} lacked configuration)` : ''}.`);
    }
    lines.push(BLOCK_END);
    updates.push({
      questionId: answer.questionId,
      questionTitle: answer.questionTitle,
      ...(add.length > 0 ? { selectedChoices: [...new Set([...answer.selected, ...add])] } : {}),
      added: add,
      notesBlock: lines.join('\n'),
    });
  }
  return { practices, updates, unmatched };
}
