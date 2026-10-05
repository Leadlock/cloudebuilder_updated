/**
 * Finds the mistakes the AI generator still makes AFTER every automatic repair, so the next repair can be built from evidence.
 *
 * Runs the free-form prompts through the app's own generator (AiGeneratorService.generateValidatedArchitecture: knowledge-base context,
 * repair hints, sanitiser, mechanical repairs, verified auto-fixes, then the verified-pattern ladder) against the configured Azure AI
 * Foundry deployment, and groups what is left by kind. --attempts is the number of tries the model gets for its own design; each prompt
 * can cost up to attempts + 2 model calls. --only restricts to listed prompt ids. The key is read from the environment, never printed.
 *
 *   npx tsx --env-file=.env --tsconfig tsconfig.json scripts/ai-dataset/batch-failures.ts [--limit 34] [--attempts 2] [--only free-6,free-9] [--out report.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { AiGeneratorService } from '@/lib/services/AiGeneratorService';

interface EvalPrompt { id: string; prompt: string; requirements: { pattern: string; provider: string } }
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

/** "MEDIUM AWS-ELB-003: ... (API Load Balancer)" and "\"Name\" (type) is not connected" → one kind per rule, names removed. */
function kindOf(message: string): string {
  return message.replace(/\([^)]*\)/g, '()').replace(/"[^"]*"/g, '"_"').replace(/\b\d+\b/g, 'N').slice(0, 160);
}

async function main() {
  const file = arg('--prompts') ?? 'datasets/ai-architect/eval-freeform.jsonl';
  const limit = Number(arg('--limit') ?? 34);
  const attempts = Number(arg('--attempts') ?? 2);
  const only = arg('--only')?.split(',');
  const all = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as EvalPrompt).slice(0, limit);
  const chosen = only ? all.filter((p) => only.includes(p.id)) : all;

  const kinds = new Map<string, { count: number; example: string; prompts: string[] }>();
  const rows: { id: string; ok: boolean; ownDesignPassed: boolean; route: string; issues: string[] }[] = [];
  let passed = 0;
  let ownPassed = 0;

  for (const p of chosen) {
    const provider = p.requirements.provider === 'azure' ? 'azure' : 'aws';
    try {
      const r = await AiGeneratorService.generateValidatedArchitecture(p.prompt, 'batch', '', provider, undefined, undefined, attempts);
      const own = r.attempts.slice(0, attempts);
      const ownDesignPassed = own.some((a) => a.ok);
      // What the AI's own design still got wrong after the automatic repairs: the last of its own attempts.
      const issues = ownDesignPassed ? [] : own[own.length - 1]!.issues.map((i) => i.message);
      if (r.ok) passed++;
      if (ownDesignPassed) ownPassed++;
      for (const m of issues) {
        const k = kindOf(m);
        const e = kinds.get(k) ?? { count: 0, example: m, prompts: [] };
        e.count++;
        if (!e.prompts.includes(p.id)) e.prompts.push(p.id);
        kinds.set(k, e);
      }
      const route = r.verifiedFallback ? 'verified pattern itself'
        : r.basedOnPattern ? 'AI adapted verified pattern'
        : r.needsReview ? 'needs review'
        : ownDesignPassed ? 'AI own design' : 'FAILED';
      rows.push({ id: p.id, ok: r.ok, ownDesignPassed, route, issues });
      console.log(`${p.id}: ${route}${issues.length ? ` (${issues.length} issue(s) in the AI's own design)` : ''}`);
    } catch (err) {
      console.log(`${p.id}: error — ${(err as Error).message}`);
      rows.push({ id: p.id, ok: false, ownDesignPassed: false, route: 'error', issues: [(err as Error).message] });
    }
  }

  const routes = rows.reduce<Record<string, number>>((m, r) => { m[r.route] = (m[r.route] ?? 0) + 1; return m; }, {});
  const remainingIssueKinds = [...kinds.entries()].sort((a, b) => b[1].count - a[1].count)
    .map(([kind, v]) => ({ kind, count: v.count, prompts: v.prompts.length, example: v.example }));
  const summary = { prompts: chosen.length, passed, aiOwnDesignPassed: ownPassed, routes, remainingIssueKinds, rows };
  const out = arg('--out');
  if (out) writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ prompts: chosen.length, passed, aiOwnDesignPassed: ownPassed, routes, remainingIssueKinds: remainingIssueKinds.slice(0, 15) }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(2); });
