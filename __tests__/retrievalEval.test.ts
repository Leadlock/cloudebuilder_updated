import { readFileSync } from 'node:fs';
import { loadCases, scoreRetrieval, rankPatterns } from '../scripts/ai-dataset/evaluate-retrieval';

const FREEFORM = 'datasets/ai-architect/eval-freeform.jsonl';
const HELD_OUT = 'datasets/ai-architect/eval-prompts.jsonl';
const NEW_PATTERNS = ['aws-static-site', 'aws-event-driven', 'aws-lambda-private-api', 'azure-static-site', 'azure-functions-private-api'];

describe('knowledge-base retrieval picks the right starting pattern (offline, keyword search)', () => {
  it('on hand-written, differently phrased prompts: right pattern first for most, and in the top 2 for nearly all', async () => {
    const s = await scoreRetrieval(loadCases(FREEFORM));
    expect(s.top1 / s.total).toBeGreaterThanOrEqual(0.8);
    // Keyword search only (no embeddings). A few prompts are genuinely ambiguous between two patterns (for example a queue-backed Lambda
    // API is both serverless and event-driven), so 100% is not a fair bar for 100 differently worded requests.
    expect(s.top2 / s.total).toBeGreaterThanOrEqual(0.97);
  });

  it('on the generated held-out prompts: right pattern first for nearly all', async () => {
    const s = await scoreRetrieval(loadCases(HELD_OUT));
    expect(s.top1 / s.total).toBeGreaterThanOrEqual(0.95);
    expect(s.top2).toBe(s.total);
  });

  it('every new pattern is retrievable: each has hand-written prompts and a held-out prompt, and they find it', async () => {
    const free = loadCases(FREEFORM); const held = loadCases(HELD_OUT);
    const s = await scoreRetrieval([...free, ...held]);
    for (const p of NEW_PATTERNS) {
      expect(free.filter((c) => c.requirements.pattern === p).length).toBeGreaterThanOrEqual(2);
      expect(held.filter((c) => c.requirements.pattern === p).length).toBeGreaterThan(0);
      const b = s.byPattern[p]!;
      expect(b.top1 / b.total).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('never suggests a pattern from the wrong cloud', async () => {
    expect((await rankPatterns('static website on azure behind a CDN', 'aws')).every((p) => p.startsWith('azure-'))).toBe(true);
    expect((await rankPatterns('serverless API with a queue on AWS', 'azure')).every((p) => p.startsWith('aws-'))).toBe(true);
  });
});

describe('the training dataset covers the new patterns', () => {
  const manifest = JSON.parse(readFileSync('datasets/ai-architect/manifest.json', 'utf8')) as { byPattern: Record<string, number>; examples: { train: number; validation: number } };
  it.each(NEW_PATTERNS)('%s has training examples', (p) => expect(manifest.byPattern[p]).toBeGreaterThanOrEqual(4));
  it('keeps train and validation files in line with the manifest', () => {
    const lines = (f: string) => readFileSync(`datasets/ai-architect/${f}`, 'utf8').trim().split('\n').length;
    expect(lines('train.jsonl')).toBe(manifest.examples.train);
    expect(lines('validation.jsonl')).toBe(manifest.examples.validation);
  });
});
