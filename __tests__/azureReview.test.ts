/** The Azure review sheet: Microsoft's checklist, pre-filled honestly (no evidence is never a pass). */
import type { Evaluation } from '@/lib/engines/assessment/types';
import { ALL_RULES, RULES_BY_ID } from '@/lib/engines/assessment/rules';
import { QUESTION_RULES } from '@/lib/engines/assessment/questionnaire/questionRules';
import { AZURE_CHECKLIST, AZURE_PILLAR_ORDER } from '@/lib/azureReview/checklist';
import { azureReviewMarkdown, buildAzureReview } from '@/lib/azureReview/review';

const meta = { project: 'Shop', environment: 'production', rulesetVersion: 'r1', evaluatedAt: '2026-10-26T00:00:00.000Z' };
const ev = (ruleId: string, status: Evaluation['status'], observation = 'observed'): Evaluation => ({ ruleId, status, observation } as Evaluation);
const row = (evs: Evaluation[], code: string) => buildAzureReview(evs, meta).rows.find((r) => r.code === code)!;

describe('the checklist data', () => {
  it('is Microsoft\'s: 59 recommendations over the five pillars, codes unique and in the pillar\'s own series', () => {
    expect(AZURE_CHECKLIST).toHaveLength(59);
    expect(new Set(AZURE_CHECKLIST.map((i) => i.code)).size).toBe(59);
    const prefix = { reliability: 'RE', security: 'SE', cost_optimization: 'CO', operational_excellence: 'OE', performance_efficiency: 'PE' } as const;
    for (const i of AZURE_CHECKLIST) expect(i.code.startsWith(`${prefix[i.pillar]}:`)).toBe(true);
    for (const p of AZURE_PILLAR_ORDER) expect(AZURE_CHECKLIST.some((i) => i.pillar === p)).toBe(true);
  });
  it('names only checks that exist', () => {
    const known = new Set([...ALL_RULES, ...QUESTION_RULES].map((r) => r.id));
    for (const i of AZURE_CHECKLIST) for (const id of i.evidence) { expect([id, known.has(id) || RULES_BY_ID.has(id)]).toEqual([id, true]); }
  });
});

describe('the states', () => {
  it('a recommendation with no checks is left for the team, never passed', () => {
    const r = row([], 'SE:11');
    expect(r.state).toBe('not_assessed');
  });
  it('a failing check makes it a gap, and says which', () => {
    const r = row([ev('AZ-SQL-002', 'FAIL', 'TDE is off on sql-1'), ev('AZ-STG-001', 'PASS')], 'SE:07');
    expect(r.state).toBe('gap');
    expect(r.basis[0]).toContain('AZ-SQL-002: TDE is off on sql-1');
  });
  it('a warning counts as a gap too', () => {
    expect(row([ev('WAQ-AZ-SEC-04', 'WARNING')], 'SE:12').state).toBe('gap');
  });
  it('passes only when something passed and nothing is unclear or unanswered', () => {
    expect(row([ev('AZ-STG-001', 'PASS'), ev('AZ-SQL-002', 'PASS')], 'SE:07').state).toBe('met');
    expect(row([ev('AZ-STG-001', 'PASS'), ev('AZ-SQL-002', 'INSUFFICIENT_DATA')], 'SE:07').state).toBe('answer_needed');
    expect(row([ev('WAQ-AZ-OPS-01', 'PASS')], 'OE:05').state).toBe('met');
    expect(row([ev('AZ-STG-001', 'PASS'), ev('AZ-SQL-002', 'PASS'), ev('AZ-EXT-SEC-02', 'NOT_EVALUATED')], 'SE:07').state).toBe('answer_needed'); // an unanswered question keeps it open
  });
  it('no evidence for something that has checks is "answer needed", not a pass', () => {
    expect(row([], 'SE:07').state).toBe('answer_needed');
    expect(row([ev('WAQ-AZ-SEC-04', 'NOT_EVALUATED')], 'SE:12').state).toBe('answer_needed');
    expect(row([ev('WAQ-AZ-SEC-04', 'NOT_APPLICABLE')], 'SE:12').state).toBe('answer_needed');
  });
});

describe('the sheet', () => {
  it('counts every recommendation once and states its coverage honestly', () => {
    const r = buildAzureReview([ev('AZ-SQL-002', 'FAIL'), ev('AZ-STG-001', 'PASS')], meta);
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBe(59);
    const md = azureReviewMarkdown(r);
    expect(md).toContain('# Azure Well-Architected review sheet: Shop');
    expect(md).toContain('**not** a Microsoft review');
    expect(md).toMatch(/\*\*Coverage\.\*\* \d+ of 59 recommendations have evidence/);
    expect(md).toContain('| SE:07 |');
    for (const p of ['Reliability', 'Security', 'Cost Optimization', 'Operational Excellence', 'Performance Efficiency']) expect(md).toContain(`## ${p}`);
    expect(md).toContain('https://learn.microsoft.com/azure/well-architected/cost-optimization/checklist');
  });
  it('keeps a table cell on one line', () => {
    const r = buildAzureReview([ev('AZ-SQL-002', 'FAIL', 'a | b\nc')], meta);
    const line = azureReviewMarkdown(r).split('\n').find((l) => l.startsWith('| SE:07 |'))!;
    expect(line).toContain('a \\| b c');
  });
});
