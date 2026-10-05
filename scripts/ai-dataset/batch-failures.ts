/**
 * Finds the mistakes the AI generator still makes AFTER every automatic repair, so the next repair can be built from evidence.
 *
 * Runs the free-form prompts through the same pipeline the app uses (knowledge-base context, repair hints, sanitiser, mechanical
 * repairs, verified auto-fixes) against the configured Azure AI Foundry deployment, and groups the issues that are left by kind.
 * Calls the model once per prompt per attempt: --limit and --attempts keep the cost bounded. The key is read from the environment
 * and never printed.
 *
 *   npx tsx --env-file=.env --tsconfig tsconfig.json scripts/ai-dataset/batch-failures.ts [--limit 34] [--attempts 2] [--out report.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { generateWithRepair } from '@/lib/ai/architectRepair';
import { buildGenerationContext } from '@/lib/ai/knowledgeBase';
import { withHints } from '@/lib/ai/repairHints';
import { sanitizeSpecInput } from '@/lib/ai/specSanitizer';
import { repairSpecInput } from '@/lib/ai/specRepair';

interface EvalPrompt { id: string; prompt: string; requirements: { pattern: string; provider: string } }
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

async function complete(messages: { role: string; content: string }[]): Promise<string> {
  const endpoint = (process.env.AZURE_AI_FOUNDRY_ENDPOINT ?? '').replace(/\/responses\/?$/, '');
  const key = process.env.AZURE_AI_FOUNDRY_API_KEY;
  const model = process.env.AZURE_AI_FOUNDRY_DEPLOYMENT;
  if (!endpoint || !key || !model) throw new Error('AZURE_AI_FOUNDRY_ENDPOINT / _API_KEY / _DEPLOYMENT are not set (run with --env-file=.env)');
  const res = await fetch(`${endpoint}/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'api-key': key },
    body: JSON.stringify({ model, input: messages, text: { format: { type: 'json_object' } } }),
  });
  if (!res.ok) throw new Error(`Foundry request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { output?: { content?: { type: string; text: string }[] }[] };
  return (body.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
}

/** "MEDIUM AWS-ELB-003: ... (API Load Balancer)" and "\"Name\" (type) is not connected" → one kind per rule, names removed. */
function kindOf(message: string): string {
  return message.replace(/\([^)]*\)/g, '()').replace(/"[^"]*"/g, '"_"').replace(/\b\d+\b/g, 'N').slice(0, 160);
}

async function main() {
  const file = arg('--prompts') ?? 'datasets/ai-architect/eval-freeform.jsonl';
  const limit = Number(arg('--limit') ?? 34);
  const attempts = Number(arg('--attempts') ?? 2);
  const prompts = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as EvalPrompt).slice(0, limit);

  const kinds = new Map<string, { count: number; example: string; prompts: string[] }>();
  const rows: { id: string; ok: boolean; attempts: number; autoRepairs: number; stage: string; issues: string[] }[] = [];
  let passed = 0; let firstTry = 0;

  for (const p of prompts) {
    const provider = p.requirements.provider === 'azure' ? 'azure' : 'aws';
    const ctx = await buildGenerationContext(p.prompt, provider).catch(() => '');
    const userPrompt = ctx ? `${p.prompt}\n\n${ctx}` : p.prompt;
    try {
      const out = await generateWithRepair((m) => complete(m), userPrompt, attempts, withHints,
        (j) => repairSpecInput(sanitizeSpecInput(j).value).value, { autoRepair: true });
      const last = out.attempts[out.attempts.length - 1]!;
      const issues = out.ok ? [] : (out.best?.issues ?? last.issues).map((i) => i.message);
      if (out.ok) passed++;
      if (out.attempts[0]!.ok) firstTry++;
      for (const m of issues) {
        const k = kindOf(m);
        const e = kinds.get(k) ?? { count: 0, example: m, prompts: [] };
        e.count++; if (!e.prompts.includes(p.id)) e.prompts.push(p.id);
        kinds.set(k, e);
      }
      rows.push({ id: p.id, ok: out.ok, attempts: out.attempts.length, autoRepairs: (out.autoRepairs ?? out.best?.autoRepairs ?? []).length, stage: last.stage, issues });
      console.log(`${p.id}: ${out.ok ? 'pass' : `FAIL (${last.stage}, ${issues.length} issue(s))`} after ${out.attempts.length} attempt(s)`);
    } catch (err) {
      console.log(`${p.id}: error — ${(err as Error).message}`);
      rows.push({ id: p.id, ok: false, attempts: 0, autoRepairs: 0, stage: 'error', issues: [(err as Error).message] });
    }
  }

  const summary = {
    prompts: prompts.length, passed, firstTryPass: firstTry,
    remainingIssueKinds: [...kinds.entries()].sort((a, b) => b[1].count - a[1].count).map(([kind, v]) => ({ kind, count: v.count, prompts: v.prompts.length, example: v.example })),
    rows,
  };
  const out = arg('--out');
  if (out) writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ prompts: summary.prompts, passed, firstTryPass: firstTry, remainingIssueKinds: summary.remainingIssueKinds.slice(0, 15) }, null, 2));
}
main().catch((e) => { console.error(e.message); process.exit(2); });
