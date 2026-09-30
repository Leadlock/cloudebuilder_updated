/**
 * Fine-tuning dataset guarantees: blueprints pass the real gates, the committed JSONL is
 * well-formed and gate-verified, and the repair loop behaves.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHITECT_SYSTEM_PROMPT, evaluateSpec, parseSpec, type ArchitectureSpec } from '@/lib/ai/architectureSpec';
import { buildRepairPrompt, extractJson, generateWithRepair } from '@/lib/ai/architectRepair';
import { getResourceDefinition } from '@/lib/resources';
import { hardenSpec } from '../scripts/ai-dataset/harden';
import { awsThreeTier, awsEcs, awsEks, awsServerless } from '../scripts/ai-dataset/awsPatterns';
import { azureThreeTier, azureAppService, azureServerless, azureAks } from '../scripts/ai-dataset/azurePatterns';
import { multiAwsAzureDr, multiActiveActive } from '../scripts/ai-dataset/multiPatterns';
import type { Requirements } from '../scripts/ai-dataset/requirements';

jest.setTimeout(240_000);

const base: Requirements = { provider: 'aws', pattern: 'x', region: 'us-east-1', regionB: 'westeurope', scale: 'medium', db: 'postgres', cache: true, cdn: true, regulated: false, queue: false, app: 'storefront' };
const azureBase: Requirements = { ...base, provider: 'azure', region: 'eastus', queue: false };
const multiBase: Requirements = { ...base, provider: 'multi', cdn: false, queue: false };

const BLUEPRINTS: [string, (r: Requirements) => ArchitectureSpec, Requirements][] = [
  ['aws-three-tier', awsThreeTier, base], ['aws-ecs', awsEcs, base], ['aws-eks', awsEks, base], ['aws-serverless', awsServerless, { ...base, db: 'nosql' }],
  ['azure-three-tier', azureThreeTier, azureBase], ['azure-app-service', azureAppService, azureBase], ['azure-serverless', azureServerless, { ...azureBase, db: 'nosql' }], ['azure-aks', azureAks, azureBase],
  ['multi-aws-azure-dr', multiAwsAzureDr, multiBase], ['multi-active-active', multiActiveActive, multiBase],
];

describe('blueprints pass every deploy-readiness gate', () => {
  test.each(BLUEPRINTS)('%s (default and regulated/large variants)', (_id, fn, req) => {
    for (const v of [{}, { regulated: true, scale: 'large' as const }]) {
      const spec = hardenSpec(fn({ ...req, ...v })).spec;
      const ev = evaluateSpec(spec);
      expect(ev.issues).toEqual([]);
      expect(ev.ok).toBe(true);
      expect(ev.readiness!.gates.every((g) => g.passed)).toBe(true);
    }
  });
});

describe('gates reject broken designs', () => {
  const good = () => JSON.parse(JSON.stringify(hardenSpec(awsThreeTier(base)).spec)) as ArchitectureSpec;

  test('unknown setting is a parse error', () => {
    const s = good(); s.resources.find((r) => r.type === 'aws_alb')!.config!.nonsense = true;
    expect(evaluateSpec(s)).toMatchObject({ ok: false, stage: 'parse' });
  });
  test('reversed connection is rejected', () => {
    const s = good(); const c = s.connections.find((x) => x.to === 'rds')!; [c.from, c.to] = [c.to, c.from];
    expect(evaluateSpec(s).ok).toBe(false);
  });
  test('unconnected resource fails connectivity', () => {
    const s = good(); s.connections = s.connections.filter((x) => x.from !== 'assets' && x.to !== 'assets');
    const ev = evaluateSpec(s);
    expect(ev.ok).toBe(false);
    expect(ev.issues.some((i) => i.code === 'CONNECTIVITY')).toBe(true);
  });
  test('overlapping subnet CIDRs fail addressing', () => {
    const s = good(); const subs = s.resources.filter((r) => r.type === 'aws_subnet');
    subs[1].config = { ...subs[1].config, cidrBlock: subs[0].config!.cidrBlock };
    expect(evaluateSpec(s).issues.some((i) => i.code === 'NETWORK-ADDRESSING')).toBe(true);
  });
  test('missing WAF on the ALB fails the assessment gate', () => {
    const s = good(); s.resources = s.resources.filter((r) => r.id !== 'waf-alb'); s.connections = s.connections.filter((c) => c.from !== 'waf-alb');
    expect(evaluateSpec(s).issues.some((i) => i.code === 'ASSESSMENT')).toBe(true);
  });
  test('placeholder values are reported as deployment inputs, not hidden', () => {
    const ev = evaluateSpec(good());
    expect(ev.ok).toBe(true);
    expect(ev.deploymentInputs!.some((d) => d.placeholder.includes('REPLACE-WITH-YOUR'))).toBe(true);
  });
  test('parseSpec rejects non-objects', () => {
    expect(parseSpec('nope').spec).toBeUndefined();
  });
});

describe('catalog regression: subnet availability zones', () => {
  test('cover every authoritative AWS region, not just us-east-1/us-west-2', () => {
    const field = getResourceDefinition('aws_subnet')!.configSchema.find((f) => f.key === 'availabilityZone')!;
    const values = field.options!.map((o) => o.value);
    for (const az of ['us-east-1a', 'us-east-1c', 'eu-west-1a', 'eu-central-1b', 'ap-south-1a', 'ap-southeast-1b']) expect(values).toContain(az);
  });
});

describe('repair loop', () => {
  const good = JSON.stringify(hardenSpec(awsServerless({ ...base, db: 'nosql' })).spec);
  test('extractJson accepts fenced JSON only', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('sure! {"a":1}')).toBeUndefined();
  });
  test('recovers on the second attempt and sends the issues back', async () => {
    const seen: string[] = [];
    const replies = ['{"name":"x"}', good];
    const out = await generateWithRepair(async (m) => { seen.push(m[1].content); return replies.shift()!; }, 'Design something', 3);
    expect(out.ok).toBe(true);
    expect(out.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(seen[1]).toContain('failed CloudCraft validation');
    expect(seen[1]).toContain('Validation issues:');
  });
  test('gives up after maxAttempts', async () => {
    const out = await generateWithRepair(async () => 'not json', 'Design something', 2);
    expect(out.ok).toBe(false);
    expect(out.attempts).toHaveLength(2);
  });
  test('buildRepairPrompt is the format used in training data', () => {
    expect(buildRepairPrompt('P', '{}', 'parse', [{ code: 'C', message: 'm' }])).toBe('P\n\nYour previous design failed CloudCraft validation. Fix every issue and return the complete corrected JSON.\nPrevious design:\n{}\nValidation issues:\n- [parse] C: m');
  });
});

const dir = join(process.cwd(), 'datasets/ai-architect');
const hasDataset = existsSync(join(dir, 'train.jsonl'));
(hasDataset ? describe : describe.skip)('committed dataset files', () => {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const train = read('train.jsonl'); const val = read('validation.jsonl');

  test('OpenAI chat format with the constant system prompt', () => {
    for (const row of [...train, ...val]) {
      expect(row.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant']);
      expect(row.messages[0].content).toBe(ARCHITECT_SYSTEM_PROMPT);
      expect(() => JSON.parse(row.messages[2].content)).not.toThrow();
    }
  });
  test('meets OpenAI minimums and has a validation split', () => {
    expect(train.length).toBeGreaterThanOrEqual(100);
    expect(val.length).toBeGreaterThanOrEqual(10);
  });
  test('assistant designs pass all gates (every 8th row checked here; build-dataset verifies all)', () => {
    let checked = 0;
    [...train, ...val].forEach((row, i) => {
      if (i % 8 !== 0) return;
      const ev = evaluateSpec(JSON.parse(row.messages[2].content));
      expect(ev.issues).toEqual([]);
      checked++;
    });
    expect(checked).toBeGreaterThan(50);
  });
  test('no real-looking credentials or account ids', () => {
    const text = readFileSync(join(dir, 'train.jsonl'), 'utf8') + readFileSync(join(dir, 'validation.jsonl'), 'utf8');
    expect(text).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(text).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    const accounts = new Set(text.match(/arn:aws:[a-z0-9-]+:[a-z0-9-]*:(\d{12}):/g)?.map((m) => m.match(/(\d{12})/)![1]));
    expect([...accounts]).toEqual(['123456789012'].filter((a) => accounts.has(a)));
  });
  test('validation contains no design the model trained on (paraphrases and repairs stay on one side)', () => {
    const design = (r: { messages: { content: string }[] }) => r.messages[2]!.content;
    const trained = new Set(train.map(design));
    expect(val.filter((r) => trained.has(design(r)))).toHaveLength(0);
  });
  test('requests are phrased in many styles, including vague ones that rely on defaults', () => {
    const users = train.map((r) => r.messages[1].content as string).filter((u) => !u.includes('failed CloudCraft validation'));
    expect(users.some((u) => /^I need /.test(u))).toBe(true);        // vague: cloud + kind + scale only
    expect(users.some((u) => /^hey, we need /.test(u))).toBe(true);  // casual
    expect(users.some((u) => /^What's a good /.test(u))).toBe(true); // question
    expect(users.some((u) => /^Provision /.test(u))).toBe(true);     // technical
    // A vague request must not name a region — the design uses the default one.
    for (const u of users.filter((x) => /^I need /.test(x))) expect(u).not.toMatch(/(us|eu|ap|ca|sa|me|af)-[a-z]+-d|eastus|westeurope|northeurope|westus/);
  });
  test('repair examples use the same hinted message format as the app and cover the mistakes models actually make', () => {
    const repairs = train.map((r) => r.messages[1].content as string).filter((u) => u.includes('failed CloudCraft validation'));
    expect(repairs.length).toBeGreaterThan(100);
    expect(repairs.some((u) => u.includes('Valid settings for') && u.includes('camelCase'))).toBe(true);   // snake_case settings
    expect(repairs.some((u) => u.includes('must be placed inside one of'))).toBe(true);                    // wrong parent
    expect(repairs.some((u) => u.includes('BAD_ID'))).toBe(true);                                           // Web_Server-style ids
  });
  test('covers AWS, Azure and multi-cloud', () => {
    const names = train.map((r) => (JSON.parse(r.messages[2].content).name as string));
    expect(names.some((n) => / on AWS /.test(n))).toBe(true);
    expect(names.some((n) => / on Azure /.test(n))).toBe(true);
    expect(names.some((n) => /AWS and Azure|AWS primary with Azure/.test(n))).toBe(true);
  });
});

describe('select settings with numeric options', () => {
  const withCloudwatch = (config: Record<string, unknown>) => ({
    name: 'x', summary: 'y', resources: [{ id: 'cw', type: 'aws_cloudwatch', label: 'Alarm', config }], connections: [],
  });

  test('a number that matches an option is accepted (the catalog default is itself a number)', () => {
    expect(parseSpec(withCloudwatch({ periodSeconds: 300 })).issues).toEqual([]);
    expect(parseSpec(withCloudwatch({ periodSeconds: '300' })).issues).toEqual([]);
  });
  test('a number that is not an option is still rejected, with the allowed values in the message', () => {
    const { issues } = parseSpec(withCloudwatch({ periodSeconds: 45 }));
    expect(issues[0]!.code).toBe('BAD_CONFIG_VALUE');
    expect(issues[0]!.message).toContain('10, 30, 60, 300, 900');
  });
});
