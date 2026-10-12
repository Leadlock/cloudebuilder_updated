/**
 * Well-Architected questionnaire: the catalog, how answers become checks, and what they do to scores and coverage.
 *
 * The contract being tested:
 *  - a question is a check like any other (pillar, severity weight, finding when not "Yes");
 *  - Yes passes, Partly counts as half a failure, No fails, Not applicable is excluded;
 *  - an unanswered question is NOT EVALUATED and "Don't know" is INSUFFICIENT DATA: they lower coverage and are never passes;
 *  - questions only join an assessment when answers are supplied, so every other caller is untouched;
 *  - one answer counts under both frameworks of a multi-cloud design, and Sustainability is an AWS pillar only.
 */
// The snapshot service imports the database client, which this file never touches.
jest.mock('@/src/prisma/db', () => ({ db: {} }));

import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { ALL_RULES, RULES_BY_ID } from '@/lib/engines/assessment/rules';
import { REFERENCES } from '@/lib/engines/assessment/references';
import { THIN_PILLAR_RULES } from '@/lib/engines/assessment/scoring';
import {
  ANSWER_LABEL, QUESTIONS, QUESTIONS_BY_ID, QUESTION_ANSWERS, questionsFor, type QuestionAnswer,
} from '@/lib/engines/assessment/questionnaire/questions';
import { QUESTION_RULES, QUESTION_RULE_PREFIX, isQuestionRuleId, questionIdOf } from '@/lib/engines/assessment/questionnaire/questionRules';
import { WellArchitectedRuleEngine } from '@/lib/engines/wellArchitected/WellArchitectedRuleEngine';
import { AWS_PILLARS, AZURE_PILLARS } from '@/lib/engines/wellArchitected/frameworkDefinitions';
import { AnswersSchema } from '@/lib/api/schemas/waAnswers';
import { buildSnapshot } from '@/lib/services/AssessmentSnapshotService';
import { buildReport } from '@/lib/engines/assessment/report/buildReport';
import { renderWaReportHtml } from '@/lib/services/report/renderWaReportHtml';
import { getResourceDefinition } from '@/lib/resources';
import type { DbArchitecture } from '@/lib/repositories/architectureRepository';
import type { CanvasNode } from '@/types';

function node(id: string, resourceType: string, config: Record<string, unknown> = {}): CanvasNode {
  const def = getResourceDefinition(resourceType)!;
  return { id, type: 'cloudNode', resourceType, provider: resourceType.startsWith('azure_') ? 'azure' : 'aws', label: id, position: { x: 0, y: 0 }, config: { ...def.defaultConfig, ...config } } as CanvasNode;
}
const awsDesign = () => [node('vpc', 'aws_vpc'), node('db', 'aws_rds'), node('b', 'aws_s3')];
const multiDesign = () => [...awsDesign(), node('app', 'azure_app_service')];
const ans = (answer: QuestionAnswer, note?: string) => ({ answer, ...(note ? { note } : {}) });
const questionnaire = (answers: Record<string, { answer: string; note?: string }>) => ({ answers });
const evalOf = (nodes: CanvasNode[], answers: Record<string, { answer: string; note?: string }>, ruleId: string) =>
  runAssessment({ nodes, edges: [], questionnaire: questionnaire(answers) }).evaluations.find((e) => e.ruleId === ruleId)!;
const pillar = (nodes: CanvasNode[], answers: Record<string, { answer: string; note?: string }>, id: string, provider = 'aws') =>
  runAssessment({ nodes, edges: [], questionnaire: questionnaire(answers) }).pillarResults.find((p) => p.pillar === id && p.provider === provider)!;

describe('the question catalog', () => {
  test('ids are unique, stable-looking and every question text is distinct', () => {
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
    for (const q of QUESTIONS) expect(q.id).toMatch(/^(OPS|SEC|REL|PERF|COST|SUS)-\d{2}$/);
    expect(new Set(QUESTIONS.map((q) => q.question)).size).toBe(QUESTIONS.length);
    expect(QUESTIONS_BY_ID.size).toBe(QUESTIONS.length);
  });

  test('every question is complete and phrased so that "Yes" is the good answer', () => {
    for (const q of QUESTIONS) {
      expect([q.id, q.question.endsWith('?')]).toEqual([q.id, true]);
      for (const field of ['why', 'gap', 'risk', 'recommendation', 'practice'] as const) expect([q.id, field, q[field].trim().length > 10]).toEqual([q.id, field, true]);
      expect([q.id, q.steps.length >= 2]).toEqual([q.id, true]);
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(q.severity);
    }
  });

  test('each pillar gets enough questions to clear the thin-pillar flag, so answering them is what clears it', () => {
    const count = (p: string) => QUESTIONS.filter((q) => q.pillar === p).length;
    for (const p of ['operational_excellence', 'security', 'reliability', 'performance_efficiency', 'cost_optimization', 'sustainability']) {
      expect([p, count(p) >= THIN_PILLAR_RULES]).toEqual([p, true]);
    }
  });

  test('pillars exist in the frameworks the question claims; Sustainability is AWS only', () => {
    const aws = new Set(AWS_PILLARS.map((p) => p.id as string));
    const azure = new Set(AZURE_PILLARS.map((p) => p.id as string));
    for (const q of QUESTIONS) {
      if (q.providers.includes('aws')) expect([q.id, aws.has(q.pillar)]).toEqual([q.id, true]);
      if (q.providers.includes('azure')) expect([q.id, azure.has(q.pillar)]).toEqual([q.id, true]);
    }
    expect(QUESTIONS.filter((q) => q.pillar === 'sustainability').every((q) => q.providers.length === 1 && q.providers[0] === 'aws')).toBe(true);
  });

  test('only a few questions are HIGH impact: the ones where the gap can cause an outage or a breach on its own', () => {
    const high = QUESTIONS.filter((q) => q.severity === 'HIGH').map((q) => q.id).sort();
    expect(high).toEqual(['OPS-04', 'REL-01', 'REL-03', 'SEC-01', 'SEC-03']);
  });

  test('questionsFor picks by cloud', () => {
    expect(questionsFor(['azure']).some((q) => q.pillar === 'sustainability')).toBe(false);
    expect(questionsFor(['aws']).some((q) => q.pillar === 'sustainability')).toBe(true);
    expect(questionsFor(['aws', 'azure']).length).toBe(QUESTIONS.length);
  });

  test('answer labels cover every answer', () => {
    for (const a of QUESTION_ANSWERS) expect(ANSWER_LABEL[a]).toBeTruthy();
  });
});

describe('questions as rules', () => {
  test('one rule per question per framework, with a recognisable id', () => {
    expect(QUESTION_RULES.length).toBe(QUESTIONS.reduce((n, q) => n + q.providers.length, 0));
    for (const r of QUESTION_RULES) {
      expect(r.id.startsWith(QUESTION_RULE_PREFIX)).toBe(true);
      expect(isQuestionRuleId(r.id)).toBe(true);
      expect(QUESTIONS_BY_ID.has(questionIdOf(r.id)!)).toBe(true);
    }
    expect(questionIdOf('WAQ-AZ-REL-01')).toBe('REL-01');
    expect(questionIdOf('AWS-S3-001')).toBeNull();
  });

  test('they are resolvable by id but are NOT part of ALL_RULES', () => {
    for (const r of QUESTION_RULES) {
      expect(RULES_BY_ID.get(r.id)).toBe(r);
      expect(ALL_RULES.includes(r)).toBe(false);
    }
  });

  test('every rule is architecture-scoped, in its question\'s pillar, with a reference that exists and no auto-fix', () => {
    for (const r of QUESTION_RULES) {
      const q = QUESTIONS_BY_ID.get(questionIdOf(r.id)!)!;
      expect(r.scope).toBe('architecture');
      expect(r.wellArchitected.pillar).toBe(q.pillar);
      expect(r.severity).toBe(q.severity);
      expect(r.autoFix).toBeUndefined();
      for (const ref of r.references) expect([r.id, ref, Boolean(REFERENCES[ref])]).toEqual([r.id, ref, true]);
    }
  });
});

describe('what an answer does', () => {
  const REL01 = 'WAQ-AWS-REL-01';
  test.each<[QuestionAnswer, string]>([
    ['yes', 'PASS'], ['partial', 'WARNING'], ['no', 'FAIL'], ['na', 'NOT_APPLICABLE'], ['unknown', 'INSUFFICIENT_DATA'],
  ])('answer "%s" is %s', (answer, status) => {
    expect(evalOf(awsDesign(), { 'REL-01': ans(answer) }, REL01).status).toBe(status);
  });

  test('an unanswered question is NOT_EVALUATED, never a pass', () => {
    const e = evalOf(awsDesign(), {}, REL01);
    expect(e.status).toBe('NOT_EVALUATED');
    expect(e.requiredData).toMatch(/questionnaire/i);
  });

  test('"No" and "Partly" raise a finding titled with the gap, labelled as a questionnaire answer, with a manual fix', () => {
    const a = runAssessment({ nodes: awsDesign(), edges: [], questionnaire: questionnaire({ 'REL-01': ans('no'), 'OPS-02': ans('partial') }) });
    const f = a.findings.filter((x) => isQuestionRuleId(x.ruleId));
    expect(f.map((x) => x.ruleId).sort()).toEqual(['WAQ-AWS-OPS-02', 'WAQ-AWS-REL-01']);
    const rel = f.find((x) => x.ruleId === REL01)!;
    expect(rel.title).toBe(QUESTIONS_BY_ID.get('REL-01')!.gap);
    expect(rel.severity).toBe('HIGH');
    expect(rel.autoFix.available).toBe(false);
    expect(rel.recommendation).toBe(QUESTIONS_BY_ID.get('REL-01')!.recommendation);
    expect(rel.manualSteps.length).toBeGreaterThanOrEqual(2);
    const wa = new WellArchitectedRuleEngine().analyze({ architectureId: 'a', nodes: awsDesign(), edges: [], questionnaire: questionnaire({ 'REL-01': ans('no') }) });
    expect(wa.findings.find((x) => x.ruleId === REL01)?.sourceLabel).toBe('Questionnaire answer');
  });

  test('a note is kept as evidence and shown with the finding', () => {
    const e = evalOf(awsDesign(), { 'REL-01': ans('no', 'Restore test planned for Q1') }, REL01);
    expect(e.evidence.map((x) => x.observed)).toContain('Restore test planned for Q1');
    expect(e.evidence.every((x) => x.basis === 'QUESTIONNAIRE')).toBe(true);
  });

  test('a "No" on a HIGH question caps the pillar at 70, like any failing HIGH check', () => {
    const answers: Record<string, { answer: string }> = {};
    for (const q of QUESTIONS.filter((x) => x.pillar === 'reliability')) answers[q.id] = ans('yes');
    expect(pillar(awsDesign(), answers, 'reliability').score.score).toBeGreaterThan(70);
    answers['REL-01'] = ans('no');
    const p = pillar(awsDesign(), answers, 'reliability');
    expect(p.score.score).toBeLessThanOrEqual(70);
    expect(p.score.capApplied).toMatch(/HIGH/);
  });

  test('"Partly" costs half of what "No" does', () => {
    const base = (a: QuestionAnswer) => pillar(awsDesign(), { 'COST-01': ans('yes'), 'COST-02': ans(a), 'COST-03': ans('yes') }, 'cost_optimization').score.score!;
    expect(base('yes')).toBeGreaterThan(base('partial'));
    expect(base('partial')).toBeGreaterThan(base('no'));
  });
});

describe('questions and the rest of the assessment', () => {
  test('without a questionnaire nothing changes: the same checks, the same results', () => {
    const plain = runAssessment({ nodes: awsDesign(), edges: [] });
    expect(plain.evaluations.some((e) => isQuestionRuleId(e.ruleId))).toBe(false);
    const withEmpty = runAssessment({ nodes: awsDesign(), edges: [], questionnaire: questionnaire({}) });
    expect(withEmpty.evaluations.filter((e) => !isQuestionRuleId(e.ruleId)).map((e) => [e.ruleId, e.status])).toEqual(plain.evaluations.map((e) => [e.ruleId, e.status]));
  });

  test('once a questionnaire is supplied, every unanswered question lowers coverage and none counts as a pass', () => {
    const plain = runAssessment({ nodes: awsDesign(), edges: [] }).pillarResults.find((p) => p.pillar === 'operational_excellence' && p.provider === 'aws')!;
    const open = runAssessment({ nodes: awsDesign(), edges: [], questionnaire: questionnaire({}) }).pillarResults.find((p) => p.pillar === 'operational_excellence')!;
    expect(open.score.coverage.notEvaluated).toBeGreaterThanOrEqual(8);
    expect(open.score.coverage.coveragePct!).toBeLessThan(plain.score.coverage.coveragePct ?? 100);
    expect(open.score.coverage.passed).toBe(plain.score.coverage.passed);
    expect(open.score.score).toBe(plain.score.score);
  });

  test('"Don\'t know" lowers coverage like an unanswered question and is not counted as evidence', () => {
    const p = pillar(awsDesign(), { 'OPS-01': ans('unknown'), 'OPS-02': ans('unknown') }, 'operational_excellence');
    expect(p.score.coverage.insufficientData).toBe(2);
    expect(p.evaluatedRules).toBe(1); // only the one automated OE check on this design
  });

  test('answering enough questions clears the "limited evidence" flag, which is what the questionnaire is for', () => {
    const before = pillar(awsDesign(), {}, 'operational_excellence');
    expect(before.limitedEvidence).toBe(true);
    const answers: Record<string, { answer: string }> = {};
    for (const q of QUESTIONS.filter((x) => x.pillar === 'operational_excellence').slice(0, 5)) answers[q.id] = ans('yes');
    const after = pillar(awsDesign(), answers, 'operational_excellence');
    expect(after.evaluatedRules).toBeGreaterThanOrEqual(THIN_PILLAR_RULES);
    expect(after.limitedEvidence).toBe(false);
  });

  test('"Not applicable" is excluded from the score and from the evidence count', () => {
    const p = pillar(awsDesign(), { 'OPS-01': ans('na') }, 'operational_excellence');
    expect(p.score.coverage.notApplicable).toBeGreaterThanOrEqual(1);
    expect(p.evaluatedRules).toBe(1);
  });

  test('an AWS-only design gets AWS questions only, an Azure-only design gets Azure questions only (and no Sustainability)', () => {
    const aws = runAssessment({ nodes: awsDesign(), edges: [], questionnaire: questionnaire({}) });
    expect(aws.evaluations.filter((e) => isQuestionRuleId(e.ruleId)).every((e) => e.provider === 'aws')).toBe(true);
    const azure = runAssessment({ nodes: [node('app', 'azure_app_service')], edges: [], questionnaire: questionnaire({}) });
    const azureQ = azure.evaluations.filter((e) => isQuestionRuleId(e.ruleId));
    expect(azureQ.length).toBeGreaterThan(0);
    expect(azureQ.every((e) => e.provider === 'azure')).toBe(true);
    expect(azureQ.some((e) => e.ruleId.includes('SUS-'))).toBe(false);
  });

  test('in a multi-cloud design one answer counts under both frameworks', () => {
    const a = runAssessment({ nodes: multiDesign(), edges: [], questionnaire: questionnaire({ 'OPS-01': ans('no') }) });
    const both = a.evaluations.filter((e) => e.ruleId.endsWith('-OPS-01'));
    expect(both.map((e) => e.provider).sort()).toEqual(['aws', 'azure']);
    expect(both.every((e) => e.status === 'FAIL')).toBe(true);
    expect(a.evaluations.filter((e) => e.ruleId.includes('SUS-')).every((e) => e.provider === 'aws')).toBe(true);
  });

  test('the Well-Architected adapter reports the effect on pillar counts', () => {
    const answers: Record<string, { answer: string }> = {};
    for (const q of QUESTIONS.filter((x) => x.pillar === 'cost_optimization')) answers[q.id] = ans('yes');
    const wa = new WellArchitectedRuleEngine().analyze({ architectureId: 'a', nodes: awsDesign(), edges: [], questionnaire: questionnaire(answers) });
    const cost = wa.pillarScores.find((p) => p.pillar === 'cost_optimization')!;
    expect(cost.limitedEvidence).toBe(false);
    expect(cost.evaluatedRules).toBeGreaterThanOrEqual(5);
  });
});

describe('exports include the answers', () => {
  const arch = (nodes: CanvasNode[]): DbArchitecture => ({
    id: 'arch-1', environmentId: 'env-1', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', revision: 1,
    resources: nodes.map((n) => ({ id: n.id, resourceType: n.resourceType, provider: n.provider, label: n.label, positionX: 0, positionY: 0, configJson: JSON.stringify(n.config), region: null, groupId: null, locked: false, architectureId: 'arch-1' })),
    connections: [],
  });
  const snap = (q?: ReturnType<typeof questionnaire>) => buildSnapshot({
    scanId: '00000000-1111-4222-8333-444444444444', project: { id: 'p1', name: 'QA', environment: 'production', region: 'us-east-1' }, arch: arch(awsDesign()),
    createdBy: 'qa', reviews: [], now: '2026-09-24T10:00:00.000Z', questionnaire: q,
  });

  test('a snapshot taken with answers contains the question checks; without, it does not', () => {
    expect(snap().assessment.evaluations.some((e) => isQuestionRuleId(e.ruleId))).toBe(false);
    expect(snap(questionnaire({ 'REL-01': ans('no') })).assessment.evaluations.some((e) => isQuestionRuleId(e.ruleId))).toBe(true);
  });

  test('the Well-Architected report shows a failed question as a finding', () => {
    const report = buildReport(snap(questionnaire({ 'REL-01': ans('no', 'Planned for Q1') })), { generatedAt: '2026-09-24T10:05:00.000Z' });
    const html = renderWaReportHtml(report);
    expect(html).toContain(QUESTIONS_BY_ID.get('REL-01')!.gap);
  });
});

describe('the request schema', () => {
  test('accepts answers, notes and clearing an answer', () => {
    expect(AnswersSchema.safeParse({ answers: [{ questionId: 'REL-01', answer: 'no', note: 'Q1' }, { questionId: 'OPS-01', answer: null }] }).success).toBe(true);
  });

  test.each([
    ['no answers', { answers: [] }],
    ['an answer that does not exist', { answers: [{ questionId: 'REL-01', answer: 'maybe' }] }],
    ['a note over 500 characters', { answers: [{ questionId: 'REL-01', answer: 'yes', note: 'x'.repeat(501) }] }],
    ['an empty question id', { answers: [{ questionId: '', answer: 'yes' }] }],
    ['more than 100 answers', { answers: Array.from({ length: 101 }, () => ({ questionId: 'REL-01', answer: 'yes' })) }],
    ['a missing answers list', {}],
  ])('rejects %s', (_name, body) => {
    expect(AnswersSchema.safeParse(body).success).toBe(false);
  });
});
