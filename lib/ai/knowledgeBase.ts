/**
 * Retrieval over CloudBuilder's generated knowledge base (datasets/ai-architect/knowledge-base).
 *
 * The chunks are produced by scripts/ai-dataset/build-knowledge-base.ts from the code that enforces the
 * rules (resource catalog, containment/connection rules, the 115 assessment rules, verified patterns), so
 * what the model reads here cannot drift from what CloudBuilder validates.
 *
 * Search is semantic (Azure AI Foundry embeddings, vectors precomputed by scripts/ai-dataset/build-kb-embeddings.ts)
 * with an automatic keyword fallback, so the AI features keep working — just less precisely — if the
 * embedding call fails or the vectors file is missing/stale.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { foundryClient, FOUNDRY_EMBEDDING_MODEL } from './foundryClient';

export type KbKind = 'resource' | 'rule' | 'pattern' | 'guideline' | 'connections';
export interface KbChunk { id: string; title: string; text: string; metadata: { kind: KbKind; provider?: string; pattern?: string } }
export interface EmbeddingsFile { model: string; dimensions: number; generatedAt: string; chunks: Record<string, { hash: string; vector: string }> }

const kbDir = () => path.join(process.cwd(), 'datasets', 'ai-architect', 'knowledge-base');

// ─── Chunks ───────────────────────────────────────────────────────────────────

let chunkCache: KbChunk[] | null = null;
let chunkIndex: Map<string, KbChunk> | null = null;

export function loadChunks(): KbChunk[] {
  if (chunkCache) return chunkCache;
  const file = path.join(kbDir(), 'knowledge-base.jsonl');
  if (!existsSync(file)) {
    console.warn(`[knowledgeBase] ${file} not found — AI features will run without knowledge-base context.`);
    chunkCache = [];
  } else {
    chunkCache = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as KbChunk);
  }
  chunkIndex = new Map(chunkCache.map((c) => [c.id, c]));
  return chunkCache;
}

export function chunkById(id: string): KbChunk | undefined {
  loadChunks();
  return chunkIndex!.get(id);
}

/** The exact text that is embedded (shared with the script that builds the vectors file). */
// A pattern's long JSON sample is left out of what is embedded: it is mostly ids and settings, and it drowns the description
// (use-when, resources, summary), so multi-cloud requests were matching single-cloud patterns. The model still receives the full text.
const SAMPLE_MARKER = '\nSample design (JSON):';
export const embeddingText = (c: KbChunk): string => {
  const cut = c.metadata.kind === 'pattern' ? c.text.indexOf(SAMPLE_MARKER) : -1;
  return `${c.title}\n${cut >= 0 ? c.text.slice(0, cut) : c.text}`;
};
export const embeddingHash = (c: KbChunk): string => createHash('sha1').update(embeddingText(c)).digest('hex');

// ─── Vectors ──────────────────────────────────────────────────────────────────

export const encodeVector = (v: ArrayLike<number>): string => Buffer.from(new Float32Array(Array.from(v)).buffer).toString('base64');
export const decodeVector = (b64: string): Float32Array => {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
};

let vectorCache: Map<string, Float32Array> | null | undefined;

/** Vectors are used only if every chunk has one computed from its current text; otherwise search falls back to keywords. */
function loadVectors(): Map<string, Float32Array> | null {
  if (vectorCache !== undefined) return vectorCache;
  const file = path.join(kbDir(), 'embeddings.json');
  vectorCache = null;
  if (!existsSync(file)) return vectorCache;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as EmbeddingsFile;
    const map = new Map<string, Float32Array>();
    for (const c of loadChunks()) {
      const entry = parsed.chunks[c.id];
      if (!entry || entry.hash !== embeddingHash(c)) {
        console.warn('[knowledgeBase] embeddings.json is stale (knowledge base changed) — using keyword search. Run: npm run ai:kb-embed');
        return vectorCache;
      }
      map.set(c.id, decodeVector(entry.vector));
    }
    vectorCache = map;
  } catch (err) {
    console.warn('[knowledgeBase] could not read embeddings.json — using keyword search:', (err as Error).message);
  }
  return vectorCache;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await foundryClient().embeddings.create({ model: FOUNDRY_EMBEDDING_MODEL, input: texts });
  return res.data.map((d) => d.embedding as number[]);
}

export function _resetKnowledgeBaseCacheForTests(): void {
  chunkCache = null; chunkIndex = null; vectorCache = undefined; idfCache = null;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface SearchOptions { kinds?: KbKind[]; providers?: string[]; k?: number }

export function candidates(opts: SearchOptions): KbChunk[] {
  return loadChunks().filter((c) =>
    (!opts.kinds || opts.kinds.includes(c.metadata.kind)) &&
    (!opts.providers || !c.metadata.provider || opts.providers.includes(c.metadata.provider)));
}

const STOP = new Set('a an and are as at be by for from has have i in is it of on or that the this to was we with will should would can your our'.split(' '));
const tokens = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));

let idfCache: Map<string, number> | null = null;
function idf(): Map<string, number> {
  if (idfCache) return idfCache;
  const all = loadChunks(); const df = new Map<string, number>();
  for (const c of all) for (const t of new Set(tokens(`${c.title} ${c.text}`))) df.set(t, (df.get(t) ?? 0) + 1);
  idfCache = new Map([...df].map(([t, n]) => [t, Math.log(1 + all.length / n)]));
  return idfCache;
}

/** Keyword score of every chunk in the pool (0 for no shared word). Rarer words count for more, and a word in the title counts double. */
export function lexicalScores(query: string, pool: KbChunk[]): Map<string, number> {
  // "daily active users" describes the load, not the pattern, but "active" is exactly what the active-active pattern is named after.
  const weights = idf(); const q = new Set(tokens(query.replace(/\b(?:daily |monthly |weekly |concurrent )?active users?\b/gi, ' ')));
  const out = new Map<string, number>();
  for (const c of pool) {
    const body = new Set(tokens(c.text)); const title = new Set(tokens(c.title));
    let score = 0;
    for (const t of q) { const w = weights.get(t) ?? 0; if (body.has(t)) score += w; if (title.has(t)) score += 2 * w; }
    out.set(c.id, score);
  }
  return out;
}

export function lexicalSearch(query: string, pool: KbChunk[], k: number): KbChunk[] {
  const scores = lexicalScores(query, pool);
  return pool.map((c) => ({ c, score: scores.get(c.id) ?? 0 })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.c);
}

/** How much of the final score comes from meaning (embeddings) and how much from the words themselves. */
export const SEMANTIC_WEIGHT = 0.5;

/**
 * Combines the two rankings. Embeddings know that "PaaS web app" and "App Service" mean the same thing but blur patterns that differ in one
 * word ("Functions inside the VNet" against "serverless Functions"); keywords are exact but miss paraphrases. Each score is scaled to 0..1 across the
 * pool and the two are added with SEMANTIC_WEIGHT, so a chunk both agree on wins and neither alone can outvote the other on a close call.
 */
export function fuseScores(semantic: Map<string, number>, lexical: Map<string, number>, ids: string[], semanticWeight = SEMANTIC_WEIGHT): Map<string, number> {
  const scale = (m: Map<string, number>) => {
    const vals = ids.map((id) => m.get(id) ?? 0);
    const lo = Math.min(...vals); const hi = Math.max(...vals);
    return (id: string) => (hi > lo ? ((m.get(id) ?? 0) - lo) / (hi - lo) : 0);
  };
  const sem = scale(semantic); const lex = scale(lexical);
  return new Map(ids.map((id) => [id, semanticWeight * sem(id) + (1 - semanticWeight) * lex(id)]));
}

export async function searchKnowledgeBase(query: string, opts: SearchOptions = {}): Promise<KbChunk[]> {
  const k = opts.k ?? 3; const pool = candidates(opts);
  const vectors = loadVectors();
  if (vectors && pool.length) {
    try {
      const [q] = await embedTexts([query]);
      if (q) {
        const semantic = new Map(pool.map((c) => { const v = vectors.get(c.id)!; let dot = 0; for (let i = 0; i < v.length; i++) dot += v[i]! * q[i]!; return [c.id, dot] as const; }));
        const fused = fuseScores(semantic, lexicalScores(query, pool), pool.map((c) => c.id));
        return pool.slice().sort((a, b) => (fused.get(b.id) ?? 0) - (fused.get(a.id) ?? 0)).slice(0, k);
      }
    } catch (err) {
      console.warn('[knowledgeBase] embedding search failed, falling back to keywords:', (err as Error).message);
    }
  }
  return lexicalSearch(query, pool, k);
}

// ─── Context builders ─────────────────────────────────────────────────────────

const enabled = () => process.env.AI_KB_ENABLED !== 'false';

function assemble(intro: string, sections: { heading: string; chunks: KbChunk[] }[], maxChars: number): string {
  const seen = new Set<string>(); let out = intro; let used = out.length;
  for (const s of sections) {
    const fresh = s.chunks.filter((c) => !seen.has(c.id));
    if (!fresh.length) continue;
    const header = `\n\n### ${s.heading}\n`;
    let body = '';
    for (const c of fresh) {
      const piece = `${c.text}\n\n`;
      if (used + header.length + body.length + piece.length > maxChars) break;
      body += piece; seen.add(c.id);
    }
    if (body) { out += header + body.trimEnd(); used = out.length; }
  }
  return seen.size ? out : '';
}

export const providersFor = (prompt: string, fallback: 'aws' | 'azure'): string[] => {
  const aws = /\baws\b|amazon/i.test(prompt); const azure = /\bazure\b/i.test(prompt);
  if ((aws && azure) || /multi-?cloud/i.test(prompt)) return ['aws', 'azure', 'multi'];
  return [aws ? 'aws' : azure ? 'azure' : fallback];
};

/** Types listed on a pattern chunk's "Resources:" line. */
const patternTypes = (c: KbChunk): string[] => (/^Resources: (.+)\.$/m.exec(c.text)?.[1] ?? '').split(',').map((t) => t.trim()).filter(Boolean);

/**
 * Reference material appended to a generation request: the closest verified pattern (a full example that
 * passed every gate), the exact settings for each resource type it uses, and the placement guidelines.
 * Returns '' when the knowledge base is disabled or unavailable, so callers never depend on it.
 */
export async function buildGenerationContext(prompt: string, fallbackProvider: 'aws' | 'azure', maxChars = 20000): Promise<string> {
  // AI_KB_GENERATION=false turns the context off for generation only (the reviewer keeps using it) — for a
  // fine-tuned model that has already learned the catalog and does not need it repeated on every request.
  if (!enabled() || process.env.AI_KB_GENERATION === 'false' || !loadChunks().length) return '';
  const providers = providersFor(prompt, fallbackProvider);
  const [pattern] = await searchKnowledgeBase(prompt, { kinds: ['pattern'], providers, k: 1 });
  const wanted = new Set(pattern ? patternTypes(pattern) : []);
  const catalog = [...wanted].map((t) => chunkById(`catalog-${t}`)).filter((c): c is KbChunk => !!c);
  const extra = await searchKnowledgeBase(prompt, { kinds: ['resource'], providers, k: 3 });
  const guidelines = await searchKnowledgeBase(prompt, { kinds: ['guideline'], k: 3 });
  return assemble(
    'Reference material from CloudBuilder\'s knowledge base: a verified example, the exact resource settings and the placement rules. Use the exact type and setting names shown here. Adapt the example to the request (name, region, scale, database) rather than copying it.',
    [
      { heading: 'Verified example', chunks: pattern ? [pattern] : [] },
      { heading: 'Placement and connection guidelines', chunks: guidelines },
      { heading: 'Resource settings', chunks: [...catalog, ...extra] },
    ],
    maxChars,
  );
}

/**
 * Reference material for reviewing an existing architecture: the exact text of each rule the engine
 * reported, the settings of the affected resource types and the guidelines — plus whatever is closest to
 * the user's question, if they asked one.
 */
export async function buildReviewContext(input: { ruleIds: string[]; resourceTypes: string[]; question?: string }, maxChars = 16000): Promise<string> {
  if (!enabled() || !loadChunks().length) return '';
  const rules = input.ruleIds.map((id) => chunkById(`rule-${id}`)).filter((c): c is KbChunk => !!c);
  const catalog = input.resourceTypes.map((t) => chunkById(`catalog-${t}`)).filter((c): c is KbChunk => !!c);
  const guidelines = await searchKnowledgeBase(input.question ?? 'architecture review placement security availability', { kinds: ['guideline'], k: 3 });
  const asked = input.question ? await searchKnowledgeBase(input.question, { kinds: ['rule', 'resource', 'connections', 'pattern'], k: 4 }) : [];
  return assemble(
    'Reference material from CloudBuilder\'s knowledge base. Rules below are the exact text of the checks that ran.',
    [
      { heading: 'Rules that fired', chunks: rules },
      { heading: 'Resource settings', chunks: catalog },
      { heading: 'Guidelines', chunks: guidelines },
      { heading: 'Most relevant to the question', chunks: asked },
    ],
    maxChars,
  );
}
