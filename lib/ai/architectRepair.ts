/**
 * The repair loop shared by the dataset builder (which trains on this exact prompt format),
 * the model evaluator and any production caller of the fine-tuned model: validate the
 * model's JSON with evaluateSpec, and if it fails send the issues back for a correction.
 */
import { ARCHITECT_SYSTEM_PROMPT, evaluateSpec, type SpecIssue } from './architectureSpec';

export const MAX_REPAIR_ISSUES = 8;

export function formatIssues(stage: string, issues: SpecIssue[]): string {
  return issues.slice(0, MAX_REPAIR_ISSUES).map((i) => `- [${stage}] ${i.code}: ${i.message}`).join('\n');
}

/** User message asking the model to fix a design that failed validation. */
export function buildRepairPrompt(originalPrompt: string, previousDesign: string, stage: string, issues: SpecIssue[]): string {
  return `${originalPrompt}\n\nYour previous design failed CloudBuilder validation. Fix every issue and return the complete corrected JSON.\nPrevious design:\n${previousDesign}\nValidation issues:\n${formatIssues(stage, issues)}`;
}

/** Models occasionally wrap JSON in a code fence; accept that, nothing more. */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { return undefined; }
}

export interface RepairAttempt { attempt: number; ok: boolean; stage: string; issues: SpecIssue[] }
type Evaluated = ReturnType<typeof evaluateSpec>;
/** The closest a failed run got: a design that compiled and was laid out but still has gate issues. */
export interface BestEffort { spec: Evaluated['spec']; graph: NonNullable<Evaluated['graph']>; deploymentInputs: NonNullable<Evaluated['deploymentInputs']>; issues: SpecIssue[]; autoRepairs: string[] }
export interface RepairOutcome {
  ok: boolean; attempts: RepairAttempt[]; spec?: Evaluated['spec']; graph?: Evaluated['graph']; deploymentInputs?: Evaluated['deploymentInputs'];
  /** What CloudBuilder's own verified fixes changed in the accepted design. */
  autoRepairs?: string[];
  /** Set when ok is false but a design was built: the attempt with the fewest remaining issues. */
  best?: BestEffort;
}

/**
 * Ask the model, validate, and feed failures back for up to `maxAttempts` tries.
 * `complete` receives the chat messages and returns the assistant text.
 */
export async function generateWithRepair(
  complete: (messages: { role: 'system' | 'user' | 'assistant'; content: string }[]) => Promise<string>,
  userPrompt: string,
  maxAttempts = 3,
  /** Optional inference-time enrichment of the issues sent back to the model (never used when building training data). */
  mapIssues?: (issues: SpecIssue[]) => SpecIssue[],
  /** Optional inference-time clean-up of the parsed design before it is validated (see specSanitizer.ts). */
  prepare?: (json: unknown) => unknown,
  /** Inference only: apply CloudBuilder's verified fixes to each design before judging it (see autoRepair.ts). */
  options: { autoRepair?: boolean } = {},
): Promise<RepairOutcome> {
  const attempts: RepairAttempt[] = [];
  let best: BestEffort | undefined;
  let prompt = userPrompt;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await complete([{ role: 'system', content: ARCHITECT_SYSTEM_PROMPT }, { role: 'user', content: prompt }]);
    const parsed = extractJson(text);
    const json = parsed !== undefined && prepare ? prepare(parsed) : parsed;
    const ev = json === undefined
      ? { ok: false, stage: 'parse' as const, issues: [{ code: 'NOT_JSON', message: 'The reply was not a single JSON object.' }] }
      : evaluateSpec(json, options);
    attempts.push({ attempt, ok: ev.ok, stage: ev.stage, issues: ev.issues });
    if (ev.ok && 'spec' in ev) return { ok: true, attempts, spec: ev.spec, graph: ev.graph, deploymentInputs: ev.deploymentInputs, autoRepairs: (ev as { autoRepairs?: string[] }).autoRepairs };
    if (ev.graph && ev.deploymentInputs && (!best || ev.issues.length < best.issues.length)) {
      best = { spec: ev.spec, graph: ev.graph, deploymentInputs: ev.deploymentInputs, issues: ev.issues, autoRepairs: (ev as { autoRepairs?: string[] }).autoRepairs ?? [] };
    }
    // Send back the design as it was validated (renamed/dropped settings applied), so the issues match what the model sees.
    const previous = prepare && json !== undefined ? JSON.stringify(json) : text;
    prompt = buildRepairPrompt(userPrompt, previous, ev.stage, mapIssues ? mapIssues(ev.issues) : ev.issues);
  }
  return { ok: false, attempts, ...(best ? { best } : {}) };
}
