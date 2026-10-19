/**
 * Size and shape limits for what a caller may send to the AI routes. The model is billed per token and the text goes into
 * its prompt, so an unbounded prompt is both a cost problem (one request can burn a day's budget) and the easiest place to
 * hide a prompt-injection payload. (Whatever the model returns is still validated by CloudBuilder's own gates, so an injected
 * instruction can change the design but never produce one that fails them.)
 */
export const AI_INPUT_LIMITS = { prompt: 4000, requirements: 4000, answerKey: 300, answerValue: 1000, answers: 40 } as const;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A required, non-empty string no longer than `max`. */
export function checkText(value: unknown, name: string, max: number): Checked<string> {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: `${name} is required.` };
  if (value.length > max) return { ok: false, error: `${name} is too long (${value.length} characters; the limit is ${max}).` };
  return { ok: true, value };
}

/** An optional string: absent is fine, wrong type or too long is not. */
export function checkOptionalText(value: unknown, name: string, max: number): Checked<string | undefined> {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, error: `${name} must be text.` };
  if (value.length > max) return { ok: false, error: `${name} is too long (${value.length} characters; the limit is ${max}).` };
  return { ok: true, value };
}

/** Questionnaire answers: a plain object of short strings, not more than a questionnaire could ever produce. */
export function checkAnswers(raw: unknown): Checked<Record<string, string> | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'answers must be an object of question → answer.' };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > AI_INPUT_LIMITS.answers) return { ok: false, error: `Too many answers (the limit is ${AI_INPUT_LIMITS.answers}).` };
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof v !== 'string') return { ok: false, error: 'Every answer must be text.' };
    if (k.length > AI_INPUT_LIMITS.answerKey || v.length > AI_INPUT_LIMITS.answerValue) return { ok: false, error: 'An answer is too long.' };
    out[k] = v;
  }
  return { ok: true, value: Object.keys(out).length ? out : undefined };
}

/** Only the two clouds the generator targets; anything else means AWS, as before. */
export const normalizeProvider = (p: unknown): 'aws' | 'azure' => (p === 'azure' ? 'azure' : 'aws');
