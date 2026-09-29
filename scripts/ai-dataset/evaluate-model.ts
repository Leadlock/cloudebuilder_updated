/**
 * Scores a model against the held-out prompts using CloudCraft's real gates.
 *
 * Offline (no network): score responses you already collected
 *   npx tsx --tsconfig tsconfig.json scripts/ai-dataset/evaluate-model.ts --responses responses.jsonl
 *   (each line: {"id":"eval-1","response":"<assistant text>"})
 *
 * Live: call a model (needs OPENAI_API_KEY in the environment; the key is never printed)
 *   npx tsx --tsconfig tsconfig.json scripts/ai-dataset/evaluate-model.ts --model ft:gpt-4o-mini-2024-07-18:org::id [--attempts 3]
 *
 * Reports first-try pass rate, pass rate with the repair loop, and failures by stage/gate.
 * A pass means the design cleared every internal gate; it is not proof that `terraform apply` succeeds.
 */
import { readFileSync } from 'node:fs';
import { evaluateSpec } from '@/lib/ai/architectureSpec';
import { extractJson, generateWithRepair } from '@/lib/ai/architectRepair';

interface EvalPrompt { id: string; prompt: string; requirements: { pattern: string; provider: string } }
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const prompts: EvalPrompt[] = readFileSync(arg('--prompts') ?? 'datasets/ai-architect/eval-prompts.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));

async function openaiComplete(model: string, messages: { role: string; content: string }[]): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0, response_format: { type: 'json_object' } }),
  });
  if (!res.ok) throw new Error(`OpenAI request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content;
}

async function main() {
  const responsesFile = arg('--responses'); const model = arg('--model'); const maxAttempts = Number(arg('--attempts') ?? 3);
  if (!responsesFile && !model) { console.error('Pass --responses <file.jsonl> or --model <id>'); process.exit(2); }
  let first = 0; let repaired = 0; const failures: Record<string, number> = {}; const rows: { id: string; pattern: string; first: boolean; final: boolean }[] = [];
  const canned = responsesFile ? new Map(readFileSync(responsesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { id: string; response: string }).map((r) => [r.id, r.response])) : null;

  for (const p of prompts) {
    let firstOk = false; let finalOk = false;
    if (canned) {
      const text = canned.get(p.id);
      const json = text === undefined ? undefined : extractJson(text);
      const ev = json === undefined ? { ok: false, stage: 'parse', issues: [{ code: 'NOT_JSON', message: 'missing or not JSON' }] } : evaluateSpec(json);
      firstOk = finalOk = ev.ok;
      if (!ev.ok) for (const i of ev.issues) { const k = `${ev.stage}/${i.code}`; failures[k] = (failures[k] ?? 0) + 1; }
    } else {
      const out = await generateWithRepair((m) => openaiComplete(model!, m), p.prompt, maxAttempts);
      firstOk = out.attempts[0].ok; finalOk = out.ok;
      if (!firstOk) for (const i of out.attempts[0].issues) { const k = `${out.attempts[0].stage}/${i.code}`; failures[k] = (failures[k] ?? 0) + 1; }
    }
    if (firstOk) first++; if (finalOk) repaired++;
    rows.push({ id: p.id, pattern: p.requirements.pattern, first: firstOk, final: finalOk });
  }
  const pct = (n: number) => `${((100 * n) / prompts.length).toFixed(1)}%`;
  console.log(JSON.stringify({ prompts: prompts.length, firstTryPass: `${first}/${prompts.length} (${pct(first)})`, passWithRepair: canned ? 'n/a (offline)' : `${repaired}/${prompts.length} (${pct(repaired)})`, failuresByStageAndCode: failures }, null, 2));
  const byPattern: Record<string, string> = {};
  for (const r of rows) { const [n, t] = (byPattern[r.pattern] ?? '0/0').split('/').map(Number); byPattern[r.pattern] = `${n + (r.first ? 1 : 0)}/${t + 1}`; }
  console.log('first-try by pattern:', byPattern);
  process.exitCode = first === prompts.length ? 0 : 1;
}
main().catch((e) => { console.error(e.message); process.exit(2); });
