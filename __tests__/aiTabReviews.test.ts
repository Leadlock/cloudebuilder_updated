/**
 * AI Security and Well-Architected tab reviews: CloudCraft's engine owns findings, severities and scores; the model
 * only explains, groups and orders them. The model is mocked; the assessment engine and knowledge base are real.
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
const nodes = [node('sg', 'aws_sg', { allowSsh: true, sourceCidr: '0.0.0.0/0' }, 'web-sg'), node('vm', 'aws_ec2', { instanceType: 't3.medium' }, 'web-server')];
const reply = (o: unknown) => ({ output_text: JSON.stringify(o) });

beforeEach(() => {
  mockCreate.mockReset();
  _resetKnowledgeBaseCacheForTests();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('AiReviewService.reviewSecurity', () => {
  it('refuses an empty canvas without calling the model', async () => {
    await expect(AiReviewService.reviewSecurity({ nodes: [], edges: [] })).rejects.toThrow(/nothing to review/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('takes score and counts from the engine and ignores any the model supplies', async () => {
    const engine = runAssessment({ nodes, edges: [] });
    mockCreate.mockResolvedValue(reply({ summary: 'Open SSH.', themes: [], priorities: [], suggestions: [], answer: null, score: 100 }));
    const out = await AiReviewService.reviewSecurity({ nodes, edges: [] });
    expect(out.facts.score).toBe(engine.securityScore.score);
    expect(out.facts.score).not.toBe(100);
    expect(out.facts.findingCount).toBe(new Set(engine.findings.filter((f) => f.domain === 'SECURITY').map((f) => f.ruleId)).size);
  });

  it('drops priorities and theme rules the engine did not report', async () => {
    mockCreate.mockResolvedValue(reply({
      summary: 's', suggestions: [], answer: null,
      themes: [{ title: 'Open access', explanation: 'x', ruleIds: ['AWS-SG-001', 'AWS-MADE-UP-999'] }, { title: 'Invented', explanation: 'x', ruleIds: ['AWS-MADE-UP-999'] }],
      priorities: [{ ruleId: 'AWS-MADE-UP-999', problem: 'p', fix: 'f' }, { ruleId: 'AWS-SG-001', problem: 'SSH open to the world', fix: 'Set sourceCidr' }],
    }));
    const out = await AiReviewService.reviewSecurity({ nodes, edges: [] });
    expect(out.priorities.map((p) => p.ruleId)).not.toContain('AWS-MADE-UP-999');
    expect(out.priorities.find((p) => p.ruleId === 'AWS-SG-001')?.fix).toBe('Set sourceCidr');
    expect(out.themes).toEqual([{ title: 'Open access', explanation: 'x', ruleIds: ['AWS-SG-001'] }]);
  });

  it('never lets a critical or high finding disappear, even if the model returns nothing', async () => {
    const engine = runAssessment({ nodes, edges: [] });
    const urgent = new Set(engine.findings.filter((f) => f.domain === 'SECURITY' && (f.severity === 'CRITICAL' || f.severity === 'HIGH')).map((f) => f.ruleId));
    expect(urgent.size).toBeGreaterThan(0);
    mockCreate.mockResolvedValue(reply({ summary: 's', themes: [], priorities: [], suggestions: [], answer: null }));
    const out = await AiReviewService.reviewSecurity({ nodes, edges: [] });
    for (const id of urgent) expect(out.priorities.map((p) => p.ruleId)).toContain(id);
  });

  it('enriches each priority with the engine\'s own fix data and never repeats a rule', async () => {
    mockCreate.mockResolvedValue(reply({
      summary: 's', themes: [], suggestions: [], answer: null,
      priorities: [{ ruleId: 'AWS-SG-001', problem: '', fix: '' }, { ruleId: 'AWS-SG-001', problem: 'dup', fix: 'dup' }],
    }));
    const out = await AiReviewService.reviewSecurity({ nodes, edges: [] });
    const ids = out.priorities.map((p) => p.ruleId);
    expect(new Set(ids).size).toBe(ids.length);
    const p = out.priorities.find((x) => x.ruleId === 'AWS-SG-001')!;
    expect(['safe', 'review', 'manual']).toContain(p.autoFix);
    expect(p.fix.length).toBeGreaterThan(0);       // empty model fix falls back to the engine recommendation
    expect(p.problem.length).toBeGreaterThan(0);
    expect(p.resources).toContain('web-sg');
  });

  it('passes AI-only suggestions through separately, and answers a question (retrying an empty answer)', async () => {
    mockCreate
      .mockResolvedValueOnce(reply({ summary: 's', themes: [], priorities: [], suggestions: ['Enable GuardDuty'], answer: null }))
      .mockResolvedValueOnce(reply({ summary: 's', themes: [], priorities: [], suggestions: [], answer: 'Because SSH is open to 0.0.0.0/0.' }));
    const out = await AiReviewService.reviewSecurity({ nodes, edges: [], question: 'Why is my score low?' });
    expect(out.suggestions).toEqual(['Enable GuardDuty']);
    expect(out.answer).toBe('Because SSH is open to 0.0.0.0/0.');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('reports an unreadable model reply as an error', async () => {
    mockCreate.mockResolvedValue({ output_text: 'not json' });
    await expect(AiReviewService.reviewSecurity({ nodes, edges: [] })).rejects.toThrow(/unreadable/i);
  });
});

describe('AiReviewService.reviewWellArchitected', () => {
  it('reports every pillar with the engine\'s score, rating and status', async () => {
    const engine = runAssessment({ nodes, edges: [] });
    mockCreate.mockResolvedValue(reply({ summary: 's', pillars: [], plan: [], suggestions: [], answer: null }));
    const out = await AiReviewService.reviewWellArchitected({ nodes, edges: [] });
    expect(out.pillars).toHaveLength(engine.pillarResults.length);
    for (const pr of engine.pillarResults) {
      const p = out.pillars.find((x) => x.key === `${pr.provider}:${pr.pillar}`)!;
      expect(p.score).toBe(pr.score.score);
      expect(p.status).toBe(pr.status);
      expect(p.rating).toBe(pr.score.rating);
    }
    expect(out.facts.overallScore).toBe(engine.overallScore.score);
  });

  it('uses fixed text for insufficient-evidence pillars and never lets the model opine on them', async () => {
    const engine = runAssessment({ nodes, edges: [] });
    const thin = engine.pillarResults.filter((pr) => pr.status === 'Insufficient evidence' || pr.score.score === null);
    expect(thin.length).toBeGreaterThan(0); // a two-resource design cannot evidence every pillar
    mockCreate.mockResolvedValue(reply({
      summary: 's', plan: [], suggestions: [], answer: null,
      pillars: thin.map((pr) => ({ pillar: `${pr.provider}:${pr.pillar}`, assessment: 'This pillar is excellent!', topFixes: [] })),
    }));
    const out = await AiReviewService.reviewWellArchitected({ nodes, edges: [] });
    for (const pr of thin) {
      const p = out.pillars.find((x) => x.key === `${pr.provider}:${pr.pillar}`)!;
      // too little evidence and "informational checks only" are different situations and must not be described alike
      expect(p.assessment).toMatch(pr.status === 'Insufficient evidence' ? /too few checks could be evaluated/i : /informational only/i);
      expect(p.assessment).not.toMatch(/excellent/i);
      expect(p.topFixes).toEqual([]);
    }
    // and those pillars were never sent to the model as evaluable
    const user = (mockCreate.mock.calls[0]![0].input as { content: string }[])[1]!.content;
    for (const pr of thin) expect(user).not.toContain(`"pillar":"${pr.provider}:${pr.pillar}"`);
  });

  it('keeps only plan items and top fixes that cite a real finding, once each', async () => {
    const engine = runAssessment({ nodes, edges: [] });
    const sec = engine.pillarResults.find((pr) => pr.pillar === 'security' && pr.findingIds.length > 0)!;
    mockCreate.mockResolvedValue(reply({
      summary: 's', suggestions: [], answer: null,
      pillars: [{ pillar: `${sec.provider}:security`, assessment: 'Open SSH weakens security.', topFixes: [{ ruleId: 'AWS-MADE-UP-999', fix: 'x' }, { ruleId: 'AWS-SG-001', fix: 'Restrict sourceCidr' }] }],
      plan: [{ ruleId: 'AWS-MADE-UP-999', action: 'x' }, { ruleId: 'AWS-SG-001', action: 'Restrict SSH' }, { ruleId: 'AWS-SG-001', action: 'again' }],
    }));
    const out = await AiReviewService.reviewWellArchitected({ nodes, edges: [] });
    const p = out.pillars.find((x) => x.key === `${sec.provider}:security`)!;
    expect(p.assessment).toBe('Open SSH weakens security.');
    expect(p.topFixes.map((f) => f.ruleId)).toEqual(['AWS-SG-001']);
    expect(out.plan.map((s) => s.ruleId)).toEqual(['AWS-SG-001']);
  });

  it('answers a question and passes unverified suggestions through', async () => {
    mockCreate.mockResolvedValue(reply({ summary: 's', pillars: [], plan: [], suggestions: ['Add a runbook'], answer: 'Reliability is weak because there is a single instance.' }));
    const out = await AiReviewService.reviewWellArchitected({ nodes, edges: [], question: 'Why is reliability weak?' });
    expect(out.answer).toContain('single instance');
    expect(out.suggestions).toEqual(['Add a runbook']);
  });

  it('refuses an empty canvas', async () => {
    await expect(AiReviewService.reviewWellArchitected({ nodes: [], edges: [] })).rejects.toThrow(/nothing to review/i);
  });
});
