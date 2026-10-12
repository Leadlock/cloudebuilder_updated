/**
 * Turns each questionnaire question into assessment rules (one per cloud framework it belongs to), so an answered question is a check
 * like any other: it has a pillar, a severity weight, a finding when the answer is not "Yes", and it counts in the pillar's score and
 * coverage. Nothing downstream (scoring, pillar results, findings, reports) needs to know a check came from a person, not a config.
 *
 * They are NOT part of ALL_RULES: they only join an assessment when answers are supplied (runAssessment's `questionnaire` input), so
 * the Security tab, the AI generator's deploy gate and stored scans are unchanged by them.
 *
 * Status of an answer:
 *   Yes → PASS · Partly → WARNING (half a failure) · No → FAIL · Not applicable → NOT_APPLICABLE
 *   Don't know → INSUFFICIENT_DATA · not answered → NOT_EVALUATED   (the last two lower coverage and are never treated as passes)
 */
import type { Domain, RuleDefinition, RuleOutcome, WaPillarId } from '../types';
import { REVIEWED, rule } from '../ruleHelpers';
import { ANSWER_LABEL, QUESTIONS, type QuestionDefinition } from './questions';

export const QUESTION_RULE_PREFIX = 'WAQ-';

const DOMAIN: Record<WaPillarId, Domain> = {
  security: 'SECURITY',
  reliability: 'RELIABILITY',
  operational_excellence: 'OPERATIONAL_EXCELLENCE',
  performance_efficiency: 'PERFORMANCE_EFFICIENCY',
  cost_optimization: 'COST_OPTIMIZATION',
  sustainability: 'SUSTAINABILITY',
};

const PROVIDER_CODE = { aws: 'AWS', azure: 'AZ' } as const;

export const isQuestionRuleId = (ruleId: string): boolean => ruleId.startsWith(QUESTION_RULE_PREFIX);

/** The question a rule id was made from ("WAQ-AWS-REL-01" → "REL-01"), or null. */
export function questionIdOf(ruleId: string): string | null {
  const m = /^WAQ-(?:AWS|AZ)-(.+)$/.exec(ruleId);
  return m ? m[1]! : null;
}

function outcomeFor(q: QuestionDefinition, answers: Record<string, { answer: string; note?: string }> | undefined): RuleOutcome {
  const given = answers?.[q.id];
  const note = given?.note?.trim();
  const evidence = (observed: string) => [
    { label: 'Your answer', observed, expected: ANSWER_LABEL.yes, basis: 'QUESTIONNAIRE' as const },
    ...(note ? [{ label: 'Your note', observed: note, basis: 'QUESTIONNAIRE' as const }] : []),
  ];

  if (!given) {
    return {
      status: 'NOT_EVALUATED', observation: 'This question has not been answered.', evidence: evidence('Not answered'),
      requiredData: 'Answer this question in the Well-Architected questionnaire.',
    };
  }
  switch (given.answer) {
    case 'yes':
      return { status: 'PASS', observation: 'Answered "Yes".', evidence: evidence(ANSWER_LABEL.yes) };
    case 'partial':
      return { status: 'WARNING', observation: `Answered "Partly". ${q.gap}.`, evidence: evidence(ANSWER_LABEL.partial) };
    case 'no':
      return { status: 'FAIL', observation: `Answered "No". ${q.gap}.`, evidence: evidence(ANSWER_LABEL.no) };
    case 'na':
      return { status: 'NOT_APPLICABLE', observation: 'Marked not applicable.', evidence: evidence(ANSWER_LABEL.na) };
    case 'unknown':
    default:
      return {
        status: 'INSUFFICIENT_DATA', observation: 'Answered "Don\'t know", so this practice could not be assessed.', evidence: evidence(ANSWER_LABEL.unknown),
        requiredData: 'Find out whether this is in place, then answer the question.',
      };
  }
}

function toRule(q: QuestionDefinition, provider: 'aws' | 'azure'): RuleDefinition {
  const code = PROVIDER_CODE[provider];
  const pillarRef = `${code}-WA-${q.pillar}`;
  return rule({
    id: `${QUESTION_RULE_PREFIX}${code}-${q.id}`,
    version: '1.0.0', lastReviewed: REVIEWED, provider,
    service: 'Workload practices', scope: 'architecture',
    domain: DOMAIN[q.pillar], category: q.category, severity: q.severity, priority: 'RECOMMENDED_IMPROVEMENT',
    title: q.gap,
    description: q.question,
    rationale: q.why,
    risk: q.risk,
    impact: 'Weakens this pillar until it is addressed; this is a practice question answered by the team, not read from the architecture.',
    wellArchitected: { pillar: q.pillar, practice: q.practice },
    references: [pillarRef],
    soc1: [],
    remediation: { recommendation: q.recommendation, manualSteps: [...q.steps] },
    evaluateArchitecture: (ctx) => [outcomeFor(q, ctx.answers)],
  });
}

export const QUESTION_RULES: RuleDefinition[] = QUESTIONS.flatMap((q) => q.providers.map((p) => toRule(q, p)));
