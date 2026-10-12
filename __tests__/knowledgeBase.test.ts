/**
 * Retrieval over the real knowledge-base files (datasets/ai-architect/knowledge-base). Only the embedding
 * call is mocked, so these tests exercise the actual chunks and the actual precomputed vectors.
 */
const mockEmbeddingsCreate = jest.fn();
jest.mock('@/lib/ai/foundryClient', () => ({
  foundryClient: () => ({ embeddings: { create: (...args: unknown[]) => mockEmbeddingsCreate(...args) } }),
  FOUNDRY_EMBEDDING_MODEL: 'text-embedding-3-small',
}));

import { readFileSync } from 'fs';
import {
  _resetKnowledgeBaseCacheForTests, buildGenerationContext, buildReviewContext, chunkById, decodeVector,
  embeddingHash, encodeVector, fuseScores, lexicalScores, lexicalSearch, loadChunks, searchKnowledgeBase, SEMANTIC_WEIGHT, type EmbeddingsFile,
} from '@/lib/ai/knowledgeBase';

const stored = JSON.parse(readFileSync('datasets/ai-architect/knowledge-base/embeddings.json', 'utf8')) as EmbeddingsFile;

beforeEach(() => {
  _resetKnowledgeBaseCacheForTests();
  mockEmbeddingsCreate.mockReset();
  delete process.env['AI_KB_ENABLED'];
});

describe('knowledge base files', () => {
  it('has a precomputed vector for every chunk, computed from its current text', () => {
    // If this fails, the knowledge base changed without regenerating vectors: run `npm run ai:kb-embed`.
    for (const c of loadChunks()) {
      expect(stored.chunks[c.id]).toBeDefined();
      expect(stored.chunks[c.id]!.hash).toBe(embeddingHash(c));
    }
    expect(loadChunks().length).toBeGreaterThan(200);
  });

  it('round-trips vectors through the base64 encoding', () => {
    const v = [0.5, -0.25, 0.125, 1];
    expect(Array.from(decodeVector(encodeVector(v)))).toEqual(v);
  });
});

describe('searchKnowledgeBase', () => {
  it('semantic search returns the chunk whose stored vector is closest to the query vector', async () => {
    const target = 'rule-AWS-SG-001';
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: Array.from(decodeVector(stored.chunks[target]!.vector)) }] });

    const [top] = await searchKnowledgeBase('anything', { kinds: ['rule'], k: 1 });

    expect(top!.id).toBe(target);
  });

  it('falls back to keyword search when the embedding call fails', async () => {
    mockEmbeddingsCreate.mockRejectedValue(new Error('network down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const [top] = await searchKnowledgeBase('security group allows SSH port 22 from the whole internet', { kinds: ['rule'], k: 1 });

    expect(top!.id).toMatch(/^rule-(AWS-SG-001|AZ-NSG-001)$/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('honours the kind and provider filters', async () => {
    mockEmbeddingsCreate.mockRejectedValue(new Error('x'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const results = await searchKnowledgeBase('storage account encryption', { kinds: ['rule'], providers: ['azure'], k: 5 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) { expect(r.metadata.kind).toBe('rule'); expect(r.metadata.provider).toBe('azure'); }
  });

  it('lexicalSearch matches on split identifiers (ecs finds aws_ecs)', () => {
    const pool = loadChunks().filter((c) => c.metadata.kind === 'resource');
    expect(lexicalSearch('ecs fargate service', pool, 1)[0]!.id).toBe('catalog-aws_ecs');
  });
});

describe('buildGenerationContext', () => {
  it('returns the closest verified pattern plus the exact settings of the types it uses', async () => {
    mockEmbeddingsCreate.mockRejectedValue(new Error('x')); // keyword path keeps this deterministic
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const ctx = await buildGenerationContext('containerised web application on ECS Fargate, 1k users, us-east-1', 'aws');

    expect(ctx).toContain('aws-ecs');
    expect(ctx).toContain('cidrBlock'); // from the aws_subnet/aws_vpc settings — the exact names models get wrong
    expect(ctx.length).toBeLessThanOrEqual(20000);
  });

  it('does not offer Azure patterns for an AWS-only request', async () => {
    mockEmbeddingsCreate.mockRejectedValue(new Error('x'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = await buildGenerationContext('serverless API on AWS with a NoSQL table', 'aws');
    expect(ctx).not.toContain('azure_functions');
  });

  it('can be switched off for generation without switching off the reviewer', async () => {
    process.env['AI_KB_GENERATION'] = 'false';
    expect(await buildGenerationContext('serverless API on AWS', 'aws')).toBe('');
    mockEmbeddingsCreate.mockRejectedValue(new Error('x'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await buildReviewContext({ ruleIds: ['AWS-SG-001'], resourceTypes: [] })).toContain('AWS-SG-001');
    delete process.env['AI_KB_GENERATION'];
  });

  it('is empty when the knowledge base is disabled', async () => {
    process.env['AI_KB_ENABLED'] = 'false';
    expect(await buildGenerationContext('anything', 'aws')).toBe('');
  });
});

describe('buildReviewContext', () => {
  it('includes the exact text of every rule the engine reported and the settings of the affected types', async () => {
    mockEmbeddingsCreate.mockRejectedValue(new Error('x'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const ctx = await buildReviewContext({ ruleIds: ['AWS-SG-001', 'AWS-RDS-001'], resourceTypes: ['aws_sg', 'aws_rds'] });

    expect(ctx).toContain(chunkById('rule-AWS-SG-001')!.text.slice(0, 80));
    expect(ctx).toContain(chunkById('rule-AWS-RDS-001')!.text.slice(0, 80));
    expect(ctx).toContain('aws_rds');
  });

  it('ignores rule ids that are not in the knowledge base instead of failing', async () => {
    mockEmbeddingsCreate.mockRejectedValue(new Error('x'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(buildReviewContext({ ruleIds: ['NOT-A-RULE'], resourceTypes: [] })).resolves.toEqual(expect.any(String));
  });
});

describe('hybrid search (meaning plus words)', () => {
  const ids = ['a', 'b', 'c'];
  const m = (o: Record<string, number>) => new Map(Object.entries(o));

  it('scales each score to 0..1 over the pool, so neither kind can outvote the other by its units', () => {
    const f = fuseScores(m({ a: 0.31, b: 0.30, c: 0.10 }), m({ a: 0, b: 12, c: 50 }), ids, 0.5);
    expect(Math.max(...f.values())).toBeLessThanOrEqual(1);
    expect(Math.min(...f.values())).toBeGreaterThanOrEqual(0);
  });
  it('a chunk both rankings like beats one that only one of them likes', () => {
    const f = fuseScores(m({ a: 0.9, b: 0.88, c: 0.2 }), m({ a: 3, b: 40, c: 45 }), ids, 0.5);
    const order = ids.slice().sort((x, y) => f.get(y)! - f.get(x)!);
    expect(order[0]).toBe('b');                     // second on meaning, near the top on words
  });
  it('weight 1 is meaning only and weight 0 is words only', () => {
    const sem = m({ a: 0.9, b: 0.5, c: 0.1 }); const lex = m({ a: 0, b: 1, c: 9 });
    const top = (w: number) => { const f = fuseScores(sem, lex, ids, w); return ids.slice().sort((x, y) => f.get(y)! - f.get(x)!)[0]; };
    expect(top(1)).toBe('a');
    expect(top(0)).toBe('c');
  });
  it('a flat or empty score contributes nothing (no divide by zero)', () => {
    const f = fuseScores(m({ a: 0.5, b: 0.5, c: 0.5 }), m({}), ids, 0.5);
    for (const id of ids) expect(f.get(id)).toBe(0);
    expect(fuseScores(m({}), m({}), [], 0.5).size).toBe(0);
  });
  it('the weight is an even split', () => {
    expect(SEMANTIC_WEIGHT).toBe(0.5);
  });

  it('lexicalScores gives the same ranking lexicalSearch returns, and 0 to a chunk that shares no word', () => {
    const pool = loadChunks().filter((c) => c.metadata.kind === 'pattern');
    const scores = lexicalScores('private EKS Kubernetes cluster', pool);
    const top = lexicalSearch('private EKS Kubernetes cluster', pool, 3).map((c) => c.id);
    expect(top).toEqual(pool.slice().sort((a, b) => scores.get(b.id)! - scores.get(a.id)!).slice(0, 3).map((c) => c.id));
    expect([...scores.values()].some((v) => v === 0)).toBe(true);
  });
  it('"daily active users" does not pull the active-active pattern', () => {
    const pool = loadChunks().filter((c) => c.metadata.kind === 'pattern');
    const s = lexicalScores('production on AWS with an Azure standby for resilience, around 50,000 daily active users', pool);
    expect(s.get('pattern-multi-aws-azure-dr')!).toBeGreaterThan(s.get('pattern-multi-active-active')!);
  });

  it('searchKnowledgeBase uses both: when the query vector and the words point at the same chunk, it is first', async () => {
    const target = 'pattern-azure-functions-private-api';
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: Array.from(decodeVector(stored.chunks[target]!.vector)) }] });
    const [top] = await searchKnowledgeBase('private serverless API on Azure: Azure Functions inside the VNet with Azure SQL', { kinds: ['pattern'], providers: ['azure'], k: 1 });
    expect(top!.id).toBe(target);
  });
  it('and when the vector narrowly prefers the wrong chunk, the words correct it', async () => {
    // Meaning is close between the plain serverless pattern and the private Functions pattern (it leans to the first by a hair);
    // the words say "inside the VNet … Application Gateway … private … Azure SQL", which only the second has.
    const a = Array.from(decodeVector(stored.chunks['pattern-azure-serverless']!.vector));
    const b = Array.from(decodeVector(stored.chunks['pattern-azure-functions-private-api']!.vector));
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: a.map((x, i) => 0.52 * x + 0.48 * b[i]!) }] });
    const [top] = await searchKnowledgeBase('Functions API inside the VNet behind an Application Gateway WAF with private data services and an Azure SQL database', { kinds: ['pattern'], providers: ['azure'], k: 1 });
    expect(top!.id).toBe('pattern-azure-functions-private-api');
  });
});
