/**
 * AI review: numbers and findings come from CloudBuilder's engine, the model only explains them. The model is
 * mocked; the assessment engine, deploy-readiness gates and knowledge base are the real ones.
 */
const mockCreate = jest.fn();
jest.mock('@/lib/ai/foundryClient', () => ({
  foundryClient: () => ({ responses: { create: (...a: unknown[]) => mockCreate(...a) }, embeddings: { create: () => Promise.reject(new Error('offline')) } }),
  FOUNDRY_MODEL: 'test-model',
  FOUNDRY_EMBEDDING_MODEL: 'test-embed',
}));

import { AiReviewService } from '@/lib/services/AiReviewService';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { _resetKnowledgeBaseCacheForTests } from '@/lib/ai/knowledgeBase';
import type { CanvasNode } from '@/types';

const node = (id: string, resourceType: string, config: Record<string, unknown> = {}, label = id): CanvasNode =>
  ({ id, type: 'cloudNode', resourceType, provider: 'aws', label, position: { x: 0, y: 0 }, config } as CanvasNode);

// A security group open to the world on SSH — a finding the engine reliably reports.
const nodes = [node('sg', 'aws_sg', { allowSsh: true, sourceCidr: '0.0.0.0/0' }, 'web-sg'), node('vm', 'aws_ec2', { instanceType: 't3.medium' }, 'web-server')];

beforeEach(() => {
  mockCreate.mockReset();
  _resetKnowledgeBaseCacheForTests();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const reply = (o: unknown) => ({ output_text: JSON.stringify(o) });

describe('AiReviewService.review', () => {
  it('refuses an empty canvas', async () => {
    await expect(AiReviewService.review({ nodes: [], edges: [] })).rejects.toThrow(/nothing to review/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('takes scores and finding counts from the engine, not from the model', async () => {
    const engine = runAssessment({ nodes, edges: [] });
    mockCreate.mockResolvedValue(reply({ summary: 'A tiny web tier.', strengths: [], priorities: [], missing: [], answer: null, scores: { security: 100 } }));

    const out = await AiReviewService.review({ nodes, edges: [] });

    expect(out.facts.scores.security).toBe(engine.securityScore.score);
    expect(out.facts.findingCount).toBe(engine.findings.length);
    expect(out.facts.scores.security).not.toBe(100);
    expect(out.summary).toBe('A tiny web tier.');
  });

  it('shows the model the engine findings and the exact rule text from the knowledge base', async () => {
    mockCreate.mockResolvedValue(reply({ summary: 's', strengths: [], priorities: [], missing: [], answer: null }));
    await AiReviewService.review({ nodes, edges: [] });

    const user = (mockCreate.mock.calls[0]![0].input as { role: string; content: string }[])[1]!.content;
    expect(user).toContain('AWS-SG-001');                       // engine finding
    expect(user).toContain('Rules that fired');                 // knowledge-base section
    expect(user).toContain('SSH'); // the rule text itself mentions SSH
  });

  it('keeps priorities that cite a real finding and drops any that cite a rule the engine did not report', async () => {
    mockCreate.mockResolvedValue(reply({
      summary: 's', strengths: ['x'], missing: [], answer: null,
      priorities: [
        { ruleId: 'AWS-SG-001', problem: 'SSH is open to the internet', fix: 'Set sourceCidr to your admin range' },
        { ruleId: 'AWS-MADE-UP-999', problem: 'invented', fix: 'invented' },
      ],
    }));

    const out = await AiReviewService.review({ nodes, edges: [] });

    expect(out.priorities.map((p) => p.ruleId)).toEqual(['AWS-SG-001']);
    expect(out.priorities[0]!.severity).toBe('high');
    expect(out.priorities[0]!.resources).toContain('web-sg');
    expect(out.groundedIn.rules).toContain('AWS-SG-001');
  });

  it("replaces a problem line that merely repeats the rule title with the rule's own risk statement", async () => {
    mockCreate.mockResolvedValue(reply({ summary: 's', strengths: [], missing: [], answer: null, priorities: [{ ruleId: 'AWS-SG-001', problem: 'Security group allows SSH (22) from the entire internet', fix: 'x' }] }));
    const out = await AiReviewService.review({ nodes, edges: [] });
    expect(norm(out.priorities[0]!.problem)).not.toBe(norm(out.priorities[0]!.title));
    expect(out.priorities[0]!.problem.length).toBeGreaterThan(20);
  });

  it('answers a question only when one was asked', async () => {
    mockCreate.mockResolvedValue(reply({ summary: 's', strengths: [], priorities: [], missing: [], answer: 'Because SSH is open.' }));
    const asked = await AiReviewService.review({ nodes, edges: [], question: 'Why is my score low?' });
    expect(asked.answer).toBe('Because SSH is open.');
    expect((mockCreate.mock.calls[0]![0].input as { content: string }[])[1]!.content).toContain('QUESTION: Why is my score low?');

    const notAsked = await AiReviewService.review({ nodes, edges: [] });
    expect(notAsked.answer).toBeUndefined();
  });

  it('asks once more when a question was asked but the model left the answer empty', async () => {
    mockCreate
      .mockResolvedValueOnce(reply({ summary: 's', strengths: [], priorities: [], missing: [], answer: null }))
      .mockResolvedValueOnce(reply({ summary: 's', strengths: [], priorities: [], missing: [], answer: 'Your database is public and unencrypted.' }));

    const out = await AiReviewService.review({ nodes, edges: [], question: 'Why is my score low?' });

    expect(out.answer).toBe('Your database is public and unencrypted.');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect((mockCreate.mock.calls[1]![0].input as { content: string }[])[1]!.content).toContain('left "answer" empty');
  });

  it('makes a single model call when no question was asked', async () => {
    mockCreate.mockResolvedValue(reply({ summary: 's', strengths: [], priorities: [], missing: [], answer: null }));
    await AiReviewService.review({ nodes, edges: [] });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('throws a readable error when the model does not return JSON', async () => {
    mockCreate.mockResolvedValue({ output_text: 'sorry, I cannot help' });
    await expect(AiReviewService.review({ nodes, edges: [] })).rejects.toThrow(/unreadable answer/i);
  });
});
