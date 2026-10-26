/**
 * Assessment rules for the "Third-party service" canvas node (aws_external_service / azure_external_service): a SaaS or hosted product the
 * workload depends on (Datadog, MongoDB Atlas, Auth0, Stripe, Cloudflare ...). One rule per question in externalQuestions.ts, per cloud framework.
 *
 * What these can and cannot say: the service lives outside the cloud account, so nothing here is read from it. Every result is the team's own answer,
 * stored on the node. An unanswered question is NOT EVALUATED and "Don't know" is INSUFFICIENT DATA: neither is ever a pass, they lower coverage.
 * Each finding is per service, so a design that uses two services gets findings for each.
 */
import type { AssessResource, RuleDefinition, RuleOutcome } from '../types';
import { REVIEWED, rule } from '../ruleHelpers';
import { EXTERNAL_QUESTIONS, type ExternalQuestion } from '../externalQuestions';
import { ANSWER_LABEL, type QuestionAnswer } from '../questionnaire/questions';

export const EXTERNAL_SERVICE_TYPES = { aws: 'aws_external_service', azure: 'azure_external_service' } as const;
export const isExternalServiceType = (t: string): boolean => t === EXTERNAL_SERVICE_TYPES.aws || t === EXTERNAL_SERVICE_TYPES.azure;

const DOMAIN = { security: 'SECURITY', reliability: 'RELIABILITY', operational_excellence: 'OPERATIONAL_EXCELLENCE', cost_optimization: 'COST_OPTIMIZATION' } as const;
const CODE = { aws: 'AWS', azure: 'AZ' } as const;

function outcomeFor(q: ExternalQuestion, r: AssessResource): RuleOutcome {
  const raw = r.config[q.key];
  const answer = typeof raw === 'string' && raw !== '' ? (raw as QuestionAnswer) : undefined;
  const vendor = typeof r.config['vendor'] === 'string' && r.config['vendor'].trim() !== '' ? r.config['vendor'].trim() : r.label;
  const evidence = (observed: string) => [{ label: q.label, field: q.key, observed, expected: ANSWER_LABEL.yes, basis: 'QUESTIONNAIRE' as const, source: 'DESIGN' as const }];
  const who = `For ${vendor}: your answer`;
  if (!answer) {
    return { status: 'NOT_EVALUATED', observation: `${vendor}: this question has not been answered.`, evidence: evidence('Not answered'), requiredData: 'Answer this question in the service\'s settings.' };
  }
  switch (answer) {
    case 'yes': return { status: 'PASS', observation: `${who} is "Yes".`, evidence: evidence(ANSWER_LABEL.yes) };
    case 'partial': return { status: 'WARNING', observation: `${who} is "Partly". ${q.gap}.`, evidence: evidence(ANSWER_LABEL.partial) };
    case 'no': return { status: 'FAIL', observation: `${who} is "No". ${q.gap}.`, evidence: evidence(ANSWER_LABEL.no) };
    case 'na': return { status: 'NOT_APPLICABLE', observation: `${vendor}: marked not applicable.`, evidence: evidence(ANSWER_LABEL.na) };
    default: return { status: 'INSUFFICIENT_DATA', observation: `${vendor}: answered "Don't know", so this practice could not be assessed.`, evidence: evidence(ANSWER_LABEL.unknown), requiredData: 'Find out whether this is in place, then answer the question.' };
  }
}

function toRule(q: ExternalQuestion, cloud: 'aws' | 'azure'): RuleDefinition {
  const code = CODE[cloud];
  return rule({
    id: `${code}-${q.id}`,
    version: '1.0.0', lastReviewed: REVIEWED, provider: cloud,
    service: 'Third-party service', scope: 'resource', resourceTypes: [EXTERNAL_SERVICE_TYPES[cloud]],
    domain: DOMAIN[q.pillar], category: q.category, severity: q.severity, priority: 'RECOMMENDED_IMPROVEMENT',
    title: q.gap,
    description: q.question,
    rationale: q.why,
    risk: q.risk,
    impact: 'Weakens this pillar until it is addressed. The service is outside the cloud account, so this rests on the team\'s answer, which CloudBuilder has not verified.',
    wellArchitected: { pillar: q.pillar, practice: q.practice },
    references: [`${code}-WA-${q.pillar}`],
    soc1: [],
    remediation: { recommendation: q.recommendation, manualSteps: [...q.steps] },
    evaluate: (r) => outcomeFor(q, r),
  });
}

export const externalServiceRules: RuleDefinition[] = EXTERNAL_QUESTIONS.flatMap((q) => (['aws', 'azure'] as const).map((c) => toRule(q, c)));
