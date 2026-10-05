/**
 * When the AI's own design cannot pass, the generator rebuilds from the closest verified pattern, and as a last resort returns that
 * pattern itself — never an error and never a design that fails the gates.
 */
process.env['AZURE_AI_FOUNDRY_ENDPOINT'] = 'https://test-resource.services.ai.azure.com/openai/v1/responses';
process.env['AZURE_AI_FOUNDRY_API_KEY'] = 'test-key';
process.env['AZURE_AI_FOUNDRY_DEPLOYMENT'] = 'gpt-4o';

const mockCreate = jest.fn();
jest.mock('openai', () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({ responses: { create: mockCreate } })) }));

// Real knowledge base, keyword search only (no embedding calls).
jest.mock('@/lib/ai/knowledgeBase', () => {
  const actual = jest.requireActual('@/lib/ai/knowledgeBase') as typeof import('@/lib/ai/knowledgeBase');
  return {
    ...actual,
    buildGenerationContext: async () => '',
    searchKnowledgeBase: async (q: string, o: { kinds?: never; k?: number }) => actual.lexicalSearch(q, actual.candidates(o), o.k ?? 3),
  };
});
jest.mock('@/src/prisma/db', () => ({ db: { orm: { public: { AIGenerationHistory: { create: jest.fn().mockResolvedValue({ id: 'h' }) } } } } }));
jest.mock('@/lib/repositories/architectureRepository', () => ({ architectureRepository: { findByEnvironment: jest.fn().mockResolvedValue({ id: 'a' }) } }));

import { AiGeneratorService } from '@/lib/services/AiGeneratorService';
import { closestVerifiedDesign, adjustPrompt, sampleOf } from '@/lib/ai/verifiedBase';
import { loadChunks, searchKnowledgeBase } from '@/lib/ai/knowledgeBase';
import { evaluateSpec } from '@/lib/ai/architectureSpec';

const hopeless = JSON.stringify({ name: 'x', summary: 'y', resources: [{ id: 'a', type: 'aws_not_real', label: 'A' }], connections: [] });

describe('verified designs', () => {
  it('every pattern in the knowledge base carries a design that passes every gate', () => {
    const patterns = loadChunks().filter((c) => c.metadata.kind === 'pattern');
    expect(patterns.length).toBeGreaterThanOrEqual(10);
    for (const p of patterns) {
      const spec = sampleOf(p);
      expect(spec).not.toBeNull();
      expect({ id: p.id, ok: evaluateSpec(spec).ok }).toEqual({ id: p.id, ok: true });
    }
  });

  it('finds the closest verified design for a request, and builds the adjust prompt from it', async () => {
    const base = await closestVerifiedDesign('highly available web app on EC2 behind a load balancer with a database', 'aws', searchKnowledgeBase as never);
    expect(base).not.toBeNull();
    expect(evaluateSpec(base!.spec).ok).toBe(true);
    const text = adjustPrompt('my request', base!);
    expect(text).toContain('my request');
    expect(text).toContain('Verified design:');
    expect(text).toContain(JSON.stringify(base!.spec).slice(0, 40));
  });

  it('returns null instead of throwing when the knowledge base is unavailable', async () => {
    expect(await closestVerifiedDesign('anything', 'aws', (async () => { throw new Error('down'); }) as never)).toBeNull();
  });
});

describe('generation ladder', () => {
  beforeEach(() => mockCreate.mockReset());

  it('falls back to the verified pattern itself when the AI cannot produce or adapt anything valid', async () => {
    mockCreate.mockResolvedValue({ output_text: hopeless });
    const r = await AiGeneratorService.generateValidatedArchitecture('highly available web app on EC2 behind a load balancer with a database', 'p', 'e', 'aws', undefined, undefined, 2);
    expect(r.ok).toBe(true);
    expect(r.verifiedFallback).toBe(true);
    expect(r.needsReview).toBe(false);
    expect(r.basedOnPattern).toBeTruthy();
    expect(r.issues).toEqual([]);
    expect(r.graph!.nodes.length).toBeGreaterThan(5);
    expect(mockCreate).toHaveBeenCalledTimes(4);      // 2 own attempts + 2 adjust attempts
  });

  it('uses the AI\'s adapted version of the verified pattern when it passes', async () => {
    const base = (await closestVerifiedDesign('highly available web app on EC2 behind a load balancer with a database', 'aws', searchKnowledgeBase as never))!;
    mockCreate.mockResolvedValueOnce({ output_text: hopeless }).mockResolvedValueOnce({ output_text: hopeless })
      .mockResolvedValueOnce({ output_text: JSON.stringify(base.spec) });
    const r = await AiGeneratorService.generateValidatedArchitecture('highly available web app on EC2 behind a load balancer with a database', 'p', 'e', 'aws', undefined, undefined, 2);
    expect(r.ok).toBe(true);
    expect(r.verifiedFallback).toBe(false);
    expect(r.basedOnPattern).toBe(base.title);
    expect(mockCreate).toHaveBeenCalledTimes(3);
    const adjustInput = (mockCreate.mock.calls[2]![0].input as { content: string }[])[1]!.content;
    expect(adjustInput).toContain('Verified design:');
  });

  it('does not touch the ladder when the AI\'s own design passes', async () => {
    const base = (await closestVerifiedDesign('web app on EC2 with load balancer', 'aws', searchKnowledgeBase as never))!;
    mockCreate.mockResolvedValue({ output_text: JSON.stringify(base.spec) });
    const r = await AiGeneratorService.generateValidatedArchitecture('web app on EC2 with load balancer', 'p', 'e', 'aws');
    expect(r.ok).toBe(true);
    expect(r.basedOnPattern).toBeUndefined();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
