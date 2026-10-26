/**
 * The "Third-party service" node: it is a resource of both clouds, its settings hold the review answers, the assessment turns them into findings
 * per service (never a pass for a missing answer), and Terraform leaves it out.
 */
jest.mock('@/src/prisma/db', () => ({ db: {}, rawTransaction: jest.fn() }));

import { getResourceDefinition, fullAwsResources, fullAzureResources } from '@/lib/resources';
import type { CanvasNode } from '@/types';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { ALL_RULES, RULES_BY_ID } from '@/lib/engines/assessment/rules';
import { externalServiceRules } from '@/lib/engines/assessment/rules/externalService';
import { EXTERNAL_QUESTIONS } from '@/lib/engines/assessment/externalQuestions';
import { REFERENCES } from '@/lib/engines/assessment/references';
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

let seq = 0;
function ext(cloud: 'aws' | 'azure', config: Record<string, unknown>, label: string): CanvasNode {
  const type = `${cloud}_external_service`;
  const def = getResourceDefinition(type)!;
  return { id: `ext-${++seq}`, type: 'cloudNode', resourceType: type, provider: cloud, label, position: { x: 0, y: 0 }, config: { ...def.defaultConfig, ...config } };
}
const run = (nodes: CanvasNode[]) => runAssessment({ nodes, edges: [], evaluatedAt: '2026-10-26T00:00:00.000Z' });
const allAnswers = (a: string) => Object.fromEntries(EXTERNAL_QUESTIONS.map((q) => [q.key, a]));

describe('the resource', () => {
  it('exists for both clouds, with a setting for every question and no Terraform of its own', () => {
    for (const [cloud, list] of [['aws', fullAwsResources], ['azure', fullAzureResources]] as const) {
      const def = list.find((r) => r.type === `${cloud}_external_service`);
      expect(def).toBeDefined();
      expect(def!.provider).toBe(cloud);
      for (const q of EXTERNAL_QUESTIONS) expect(def!.configSchema.some((f) => f.key === q.key && f.type === 'select')).toBe(true);
      expect(def!.terraform).toBeUndefined();
    }
  });

  it('costs what the team enters, and nothing by default', () => {
    const def = getResourceDefinition('aws_external_service')!;
    expect(def.costCalculator!({ monthlyCostUsd: 0 }).monthlyCost).toBe(0);
    expect(def.costCalculator!({ monthlyCostUsd: 450 }).monthlyCost).toBe(450);
    expect(def.costCalculator!({ monthlyCostUsd: -5 }).monthlyCost).toBe(0);
  });
});

describe('the rules', () => {
  it('are in the catalogue once per question and cloud, with references that exist', () => {
    expect(externalServiceRules).toHaveLength(EXTERNAL_QUESTIONS.length * 2);
    for (const r of externalServiceRules) {
      expect(ALL_RULES).toContain(r);
      expect(RULES_BY_ID.get(r.id)).toBe(r);
      for (const ref of r.references) expect(REFERENCES[ref]).toBeDefined();
    }
    expect(new Set(EXTERNAL_QUESTIONS.map((q) => q.key)).size).toBe(EXTERNAL_QUESTIONS.length);
  });

  it('say nothing when the design has no third-party service', () => {
    const r = run([]);
    expect(r.evaluations.filter((e) => e.ruleId.includes('EXT-'))).toHaveLength(0);
  });

  it('never pass a question nobody answered', () => {
    const r = run([ext('aws', { vendor: 'Datadog' }, 'Datadog')]);
    const evs = r.evaluations.filter((e) => e.ruleId.startsWith('AWS-EXT-'));
    expect(evs).toHaveLength(EXTERNAL_QUESTIONS.length);
    expect(evs.every((e) => e.status === 'NOT_EVALUATED')).toBe(true);
    expect(r.findings.filter((f) => f.ruleId.startsWith('AWS-EXT-'))).toHaveLength(0);
  });

  it('turn each answer into the right result', () => {
    const q = EXTERNAL_QUESTIONS[0]!;
    const status = (answer: string) => run([ext('aws', { vendor: 'Auth0', [q.key]: answer }, 'Auth0')]).evaluations.find((e) => e.ruleId === `AWS-${q.id}`)!.status;
    expect(status('yes')).toBe('PASS');
    expect(status('partial')).toBe('WARNING');
    expect(status('no')).toBe('FAIL');
    expect(status('na')).toBe('NOT_APPLICABLE');
    expect(status('unknown')).toBe('INSUFFICIENT_DATA');
    expect(status('')).toBe('NOT_EVALUATED');
  });

  it('give each service its own findings, named after it, with the answer as evidence', () => {
    const a = ext('aws', { vendor: 'Atlas', ...allAnswers('no') }, 'Atlas prod');
    const b = ext('aws', { vendor: 'Datadog', ...allAnswers('yes') }, 'Datadog');
    const r = run([a, b]);
    const failing = r.findings.filter((f) => f.ruleId.startsWith('AWS-EXT-'));
    expect(failing).toHaveLength(EXTERNAL_QUESTIONS.length);
    expect(failing.every((f) => f.resourceIds[0] === a.id)).toBe(true);
    expect(failing[0]!.observation).toContain('Atlas');
    expect(failing[0]!.evidence[0]!.basis).toBe('QUESTIONNAIRE');
    expect(r.evaluations.filter((e) => e.resourceIds[0] === b.id && e.ruleId.startsWith('AWS-EXT-')).every((e) => e.status === 'PASS')).toBe(true);
  });

  it('use the Azure rules for an Azure design', () => {
    const r = run([ext('azure', { vendor: 'Cloudflare', ...allAnswers('no') }, 'Cloudflare')]);
    expect(r.evaluations.filter((e) => e.ruleId.startsWith('AZ-EXT-'))).toHaveLength(EXTERNAL_QUESTIONS.length);
    expect(r.evaluations.some((e) => e.ruleId.startsWith('AWS-EXT-'))).toBe(false);
  });
});

describe('Terraform', () => {
  it('leaves the service out and says so once, without an "unsupported" warning', () => {
    const resource = {
      id: 'ext1', resourceType: 'aws_external_service', provider: 'aws', label: 'Datadog', positionX: 0, positionY: 0, configJson: JSON.stringify({ vendor: 'Datadog' }),
      region: null, groupId: null, locked: false, architectureId: 'a',
    } as unknown as DbArchitectureResource;
    const out = new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources: [resource], connections: [] });
    const main = out.files.find((f) => f.filename === 'main.tf')?.content ?? '';
    expect(main).not.toMatch(/external_service|Datadog/);
    expect(out.warnings.some((w) => /Unsupported/i.test(w))).toBe(false);
    expect(out.warnings.some((w) => /third-party service/.test(w) && w.includes('Datadog'))).toBe(true);
  });
});

describe('the cost estimate', () => {
  // The cost engine never read the node's costCalculator hook: the entered monthly cost was dropped and the service counted as "no pricing data".
  const { CostEstimator } = jest.requireActual('@/lib/engines/cost/CostEstimator') as typeof import('@/lib/engines/cost/CostEstimator');
  const res = (cloud: 'aws' | 'azure', config: Record<string, unknown>) => ({ id: 'x', resourceType: `${cloud}_external_service`, provider: cloud, label: 'Datadog', positionX: 0, positionY: 0, configJson: JSON.stringify(config), region: null, groupId: null, locked: false, architectureId: 'a' });
  const total = (cloud: 'aws' | 'azure', config: Record<string, unknown>) => new CostEstimator().estimate({ architectureId: 'a', projectId: 'p', resources: [res(cloud, config) as never] }, 'TEST').items[0]!;

  it.each(['aws', 'azure'] as const)('counts what the team entered for a %s design, labelled as entered by the team', (cloud) => {
    const item = total(cloud, { vendor: 'Datadog', monthlyCostUsd: 450 });
    expect(item.monthlyUsd).toBe(450);
    expect(item.pricingSource).toBe('entered-by-team');
    expect(item.assumptions.join(' ')).toMatch(/entered by the team/);
  });
  it('counts $0, and says so, when nothing was entered; and ignores a negative or silly figure', () => {
    expect(total('aws', {}).monthlyUsd).toBe(0);
    expect(total('aws', {}).assumptions.join(' ')).toMatch(/No monthly cost has been entered/);
    expect(total('aws', { monthlyCostUsd: -50 }).monthlyUsd).toBe(0);
    expect(total('aws', { monthlyCostUsd: 'abc' }).monthlyUsd).toBe(0);
    expect(total('aws', { monthlyCostUsd: 9e12 }).monthlyUsd).toBe(1_000_000);
  });
  it('is also what the live pricing path returns', async () => {
    const { AwsPricingProvider } = jest.requireActual('@/lib/cloud/pricing/AwsPricingProvider') as typeof import('@/lib/cloud/pricing/AwsPricingProvider');
    const { AzurePricingProvider } = jest.requireActual('@/lib/cloud/pricing/AzurePricingProvider') as typeof import('@/lib/cloud/pricing/AzurePricingProvider');
    const aws = await new AwsPricingProvider().getPrice({ provider: 'aws', resourceType: 'aws_external_service', region: 'eu-west-1', configuration: { monthlyCostUsd: 99 } });
    const az = await new AzurePricingProvider().getPrice({ provider: 'azure', resourceType: 'azure_external_service', region: 'westeurope', configuration: { monthlyCostUsd: 99 } });
    expect(aws).toMatchObject({ monthlyPrice: 99, source: 'entered-by-team' });
    expect(az).toMatchObject({ monthlyPrice: 99, source: 'entered-by-team' });
  });
});
