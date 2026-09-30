/**
 * Embeds every knowledge-base chunk with the Azure AI Foundry embedding deployment and writes
 * datasets/ai-architect/knowledge-base/embeddings.json (float32 vectors, base64, keyed by chunk id + text hash).
 *
 *   npm run ai:kb-embed
 *
 * Re-run after `npm run ai:knowledge-base`. Runtime search ignores the file (and falls back to keyword
 * search) whenever a chunk's text no longer matches its stored hash, so a stale file can never serve wrong
 * results — it just stops being used until regenerated. Needs AZURE_AI_FOUNDRY_ENDPOINT / _API_KEY
 * (run through `--env-file=.env`); the key is never printed.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { FOUNDRY_EMBEDDING_MODEL } from '@/lib/ai/foundryClient';
import { embedTexts, embeddingHash, embeddingText, encodeVector, loadChunks, type EmbeddingsFile } from '@/lib/ai/knowledgeBase';

async function main() {
  const chunks = loadChunks();
  if (!chunks.length) throw new Error('No chunks found — run `npm run ai:knowledge-base` first.');
  const out: EmbeddingsFile = { model: FOUNDRY_EMBEDDING_MODEL, dimensions: 0, generatedAt: new Date().toISOString(), chunks: {} };

  const BATCH = 32;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    const vectors = await embedTexts(slice.map(embeddingText));
    slice.forEach((c, j) => { out.dimensions = vectors[j]!.length; out.chunks[c.id] = { hash: embeddingHash(c), vector: encodeVector(vectors[j]!) }; });
    console.log(`embedded ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
  }
  const file = path.join(process.cwd(), 'datasets', 'ai-architect', 'knowledge-base', 'embeddings.json');
  writeFileSync(file, JSON.stringify(out));
  console.log(`wrote ${file} (${chunks.length} chunks, ${out.dimensions} dimensions, model ${out.model})`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
