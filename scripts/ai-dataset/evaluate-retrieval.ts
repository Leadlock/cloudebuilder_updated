/**
 * Scores the knowledge-base RETRIEVAL step on its own — no model, no network, no cost.
 *
 * Before the model sees a request, buildGenerationContext picks the closest verified pattern and gives it to the model as
 * the example to adapt. If that pick is the wrong pattern the model starts from the wrong design, however good it is. This
 * checks, for every prompt that names its expected pattern, whether the keyword search puts that pattern first (or in the top 2).
 *
 *   npx tsx --tsconfig tsconfig.json scripts/ai-dataset/evaluate-retrieval.ts [--prompts file.jsonl] [--embeddings] [--verbose]
 *
 * --embeddings uses the semantic search the app uses in production (a handful of tiny embedding calls; needs --env-file=.env).
 */
import { readFileSync } from 'node:fs';
import { candidates, lexicalSearch, providersFor, searchKnowledgeBase } from '@/lib/ai/knowledgeBase';

export interface RetrievalCase { id: string; prompt: string; requirements: { pattern: string; provider: string } }
export interface RetrievalMiss { id: string; prompt: string; expected: string; got: string[] }
export interface RetrievalScore { total: number; top1: number; top2: number; misses: RetrievalMiss[]; byPattern: Record<string, { total: number; top1: number }> }

const patternOf = (id: string) => id.replace(/^pattern-/, '');

/** Rank patterns for one prompt exactly as buildGenerationContext does (provider filter, then pattern chunks only). */
export async function rankPatterns(prompt: string, fallback: 'aws' | 'azure', semantic = false, k = 2): Promise<string[]> {
  const providers = providersFor(prompt, fallback);
  const found = semantic
    ? await searchKnowledgeBase(prompt, { kinds: ['pattern'], providers, k })
    : lexicalSearch(prompt, candidates({ kinds: ['pattern'], providers }), k);
  return found.map((c) => patternOf(c.id));
}

export async function scoreRetrieval(cases: RetrievalCase[], semantic = false): Promise<RetrievalScore> {
  const score: RetrievalScore = { total: cases.length, top1: 0, top2: 0, misses: [], byPattern: {} };
  for (const c of cases) {
    const got = await rankPatterns(c.prompt, c.requirements.provider === 'azure' ? 'azure' : 'aws', semantic);
    const expected = c.requirements.pattern;
    const bucket = (score.byPattern[expected] ??= { total: 0, top1: 0 });
    bucket.total++;
    if (got[0] === expected) { score.top1++; bucket.top1++; }
    if (got.includes(expected)) score.top2++;
    if (got[0] !== expected) score.misses.push({ id: c.id, prompt: c.prompt, expected, got });
  }
  return score;
}

export const loadCases = (file: string): RetrievalCase[] => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RetrievalCase);

async function main() {
  const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  const files = arg('--prompts') ? [arg('--prompts')!] : ['datasets/ai-architect/eval-freeform.jsonl', 'datasets/ai-architect/eval-prompts.jsonl'];
  const semantic = process.argv.includes('--embeddings');
  for (const f of files) {
    const s = await scoreRetrieval(loadCases(f), semantic);
    const pct = (n: number) => `${n}/${s.total} (${Math.round((100 * n) / s.total)}%)`;
    console.log(`\n${f} — ${semantic ? 'semantic' : 'keyword'} search\n  right pattern first: ${pct(s.top1)}   in the top 2: ${pct(s.top2)}`);
    for (const [p, b] of Object.entries(s.byPattern)) if (b.top1 < b.total) console.log(`  ${p}: ${b.top1}/${b.total} first`);
    if (process.argv.includes('--verbose') || s.misses.length <= 12) for (const m of s.misses) console.log(`  MISS ${m.id}: wanted ${m.expected}, got ${m.got.join(', ') || '(nothing)'} — "${m.prompt.slice(0, 90)}"`);
  }
}
if (process.argv[1]?.includes('evaluate-retrieval')) main().catch((e) => { console.error(e.message); process.exit(1); });
