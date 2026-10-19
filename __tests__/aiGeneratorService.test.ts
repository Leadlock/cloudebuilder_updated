/**
 * Tests for lib/services/AiGeneratorService.ts after switching the AI
 * architecture generator from Gemini to Azure AI Foundry (OpenAI-SDK-compatible
 * v1 Responses API). Covers: the RDE catalog validation still rejects
 * unsupported resource types, the Foundry client is built from the expected
 * env vars, and generation history is recorded via the (mocked) db layer.
 */
process.env['AZURE_AI_FOUNDRY_ENDPOINT'] = 'https://test-resource.services.ai.azure.com/openai/v1/responses';
process.env['AZURE_AI_FOUNDRY_API_KEY'] = 'test-key';
process.env['AZURE_AI_FOUNDRY_DEPLOYMENT'] = 'gpt-4o';

const mockCreate = jest.fn();
const mockOpenAIConstructor = jest.fn().mockImplementation(() => ({
  responses: { create: mockCreate },
}));
jest.mock('openai', () => ({
  __esModule: true,
  default: mockOpenAIConstructor,
}));

const mockBuildContext = jest.fn().mockResolvedValue('');
jest.mock('@/lib/ai/knowledgeBase', () => ({ buildGenerationContext: (...args: unknown[]) => mockBuildContext(...args) }));

const mockHistoryCreate = jest.fn().mockResolvedValue({ id: 'hist-1' });
jest.mock('@/src/prisma/db', () => ({
  db: { orm: { public: { AIGenerationHistory: { create: (...args: unknown[]) => mockHistoryCreate(...args) } } } },
}));

const mockFindByEnvironment = jest.fn().mockResolvedValue({ id: 'arch-1' });
jest.mock('@/lib/repositories/architectureRepository', () => ({
  architectureRepository: { findByEnvironment: (...args: unknown[]) => mockFindByEnvironment(...args) },
}));

import { AiGeneratorService } from '@/lib/services/AiGeneratorService';

describe('AiGeneratorService — Azure AI Foundry backend', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockOpenAIConstructor.mockClear();
    mockHistoryCreate.mockClear();
    mockFindByEnvironment.mockClear();
  });

  it('builds the Foundry client from the "/responses"-suffixed endpoint env var', async () => {
    mockCreate.mockResolvedValue({ output_text: JSON.stringify({ resources: [], connections: [] }) });

    await AiGeneratorService.generateArchitecture('a vpc', 'proj-1', 'env-1', 'aws');

    expect(mockOpenAIConstructor).toHaveBeenCalledWith({
      baseURL: 'https://test-resource.services.ai.azure.com/openai/v1',
      apiKey: 'test-key',
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o', text: { format: { type: 'json_object' } } })
    );
  });

  it('keeps a valid, catalog-recognized resource', async () => {
    mockCreate.mockResolvedValue({
      output_text: JSON.stringify({
        resources: [{ id: 'r1', resourceType: 'aws_vpc', label: 'VPC' }],
        connections: [],
      }),
    });

    const result = await AiGeneratorService.generateArchitecture('a vpc', 'proj-1', 'env-1', 'aws');

    expect(result.architectureJson.resources).toEqual([{ id: 'r1', resourceType: 'aws_vpc', label: 'VPC' }]);
    expect(result.rejectedTypes).toEqual([]);
  });

  it('rejects resource types outside the RDE catalog and drops their connections', async () => {
    mockCreate.mockResolvedValue({
      output_text: JSON.stringify({
        resources: [
          { id: 'r1', resourceType: 'aws_vpc', label: 'VPC' },
          { id: 'r2', resourceType: 'not_a_real_type', label: 'Bogus' },
        ],
        connections: [{ sourceId: 'r1', targetId: 'r2' }],
      }),
    });

    const result = await AiGeneratorService.generateArchitecture('a vpc and something fake', 'proj-1', 'env-1', 'aws');

    expect(result.architectureJson.resources).toEqual([{ id: 'r1', resourceType: 'aws_vpc', label: 'VPC' }]);
    expect(result.architectureJson.connections).toEqual([]);
    expect(result.rejectedTypes).toEqual(['not_a_real_type']);
  });

  it('falls back to an empty graph when the model returns non-JSON output', async () => {
    mockCreate.mockResolvedValue({ output_text: 'not json at all' });

    const result = await AiGeneratorService.generateArchitecture('a vpc', 'proj-1', 'env-1', 'aws');

    expect(result.architectureJson).toEqual({ resources: [], connections: [] });
  });

  it('records generation history against the resolved architecture', async () => {
    mockCreate.mockResolvedValue({ output_text: JSON.stringify({ resources: [], connections: [] }) });

    const result = await AiGeneratorService.generateArchitecture('a vpc', 'proj-1', 'env-1', 'aws');

    expect(mockFindByEnvironment).toHaveBeenCalledWith('env-1');
    expect(mockHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', architectureId: 'arch-1', model: 'gpt-4o', provider: 'aws' })
    );
    expect(result.historyId).toBe('hist-1');
  });

  it('still returns a result when history recording fails', async () => {
    mockCreate.mockResolvedValue({ output_text: JSON.stringify({ resources: [], connections: [] }) });
    mockFindByEnvironment.mockRejectedValueOnce(new Error('db down'));

    const result = await AiGeneratorService.generateArchitecture('a vpc', 'proj-1', 'env-1', 'aws');

    expect(result.historyId).toBe('');
    expect(result.architectureJson).toEqual({ resources: [], connections: [] });
  });

  it('includes provider-specific quality guidelines (SPOF, encryption, no open SSH/RDP) in the system prompt', async () => {
    mockCreate.mockResolvedValue({ output_text: JSON.stringify({ resources: [], connections: [] }) });

    await AiGeneratorService.generateArchitecture('a vpc', 'proj-1', 'env-1', 'aws');
    const awsSystemPrompt = mockCreate.mock.calls[0]![0].input[0].content;
    expect(awsSystemPrompt).toContain('single point of failure');
    expect(awsSystemPrompt).toContain('Block Public Access');
    expect(awsSystemPrompt).toContain('0.0.0.0/0');
    expect(awsSystemPrompt).not.toContain('NSGs:');

    mockCreate.mockClear();
    await AiGeneratorService.generateArchitecture('a vnet', 'proj-1', 'env-1', 'azure');
    const azureSystemPrompt = mockCreate.mock.calls[0]![0].input[0].content;
    expect(azureSystemPrompt).toContain('Transparent Data Encryption');
    expect(azureSystemPrompt).not.toContain('Block Public Access');
  });

  it('generates structured discovery questionnaire with gap analysis', async () => {
    mockCreate.mockResolvedValue({
      output_text: JSON.stringify({
        summary: 'Identified missing scale and security specs',
        suggestedProjectName: 'Production SaaS Platform',
        identifiedGaps: [
          { id: 'gap-1', title: 'WAF Missing', description: 'Public facing API needs WAF', severity: 'critical' },
        ],
        questions: [
          {
            id: 'q-1',
            category: 'security',
            categoryLabel: 'Security & WAF',
            question: 'Is WAF required?',
            options: [{ id: 'opt-1', label: 'Yes, AWS WAF', isRecommended: true }],
            defaultOptionId: 'opt-1',
          },
        ],
      }),
    });

    const result = await AiGeneratorService.generateQuestionnaire('SaaS app with Postgres', 'aws');
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]?.id).toBe('q-1');
    expect(result.identifiedGaps).toHaveLength(1);
    expect(result.suggestedProjectName).toBe('Production SaaS Platform');
  });

  it('falls back to heuristic discovery when AI questionnaire generation encounters error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('AI endpoint timeout'));

    const result = await AiGeneratorService.generateQuestionnaire('SaaS app with Postgres and Redis cache', 'aws');
    expect(result.questions.length).toBeGreaterThanOrEqual(4);
    expect(result.identifiedGaps.length).toBeGreaterThan(0);
    expect(result.questions.some((q) => q.category === 'security')).toBe(true);
    expect(result.questions.some((q) => q.category === 'availability')).toBe(true);
  });
});

describe('AiGeneratorService.generateValidatedArchitecture — compile, gate, repair', () => {
  // A design from the fine-tuning set, which the dataset builder verified against every deploy-readiness gate.
  const { readFileSync } = jest.requireActual('fs') as typeof import('fs');
  const goodDesign = (JSON.parse(readFileSync('datasets/ai-architect/validation.jsonl', 'utf8').split('\n')[0]!) as {
    messages: { role: string; content: string }[];
  }).messages[2]!.content;

  beforeEach(() => {
    mockCreate.mockReset();
    mockFindByEnvironment.mockClear();
    mockHistoryCreate.mockClear();
  });

  it('includes user questionnaire answers and custom requirements in the validated-generation request', async () => {
    mockCreate.mockResolvedValue({ output_text: 'not json' });

    await AiGeneratorService.generateValidatedArchitecture(
      'SaaS web application', 'proj-1', 'env-1', 'aws',
      { 'Security & WAF': 'Enterprise Hardened (WAF + KMS)', 'High Availability': 'Multi-AZ Active-Active' },
      'Must follow HIPAA compliance and automated backups',
      1,
    );

    const userPrompt = (mockCreate.mock.calls[0]![0].input as { content: string }[])[1]!.content;
    expect(userPrompt).toContain('SaaS web application');
    expect(userPrompt).toContain('USER SPECIFICATIONS & ANSWERS:');
    expect(userPrompt).toContain('Security & WAF: Enterprise Hardened');
    expect(userPrompt).toContain('High Availability: Multi-AZ Active-Active');
    expect(userPrompt).toContain('ADDITIONAL USER REQUIREMENTS:\nMust follow HIPAA compliance and automated backups');
  });

  it('returns the compiled, laid-out graph when the model answers correctly first time', async () => {
    mockCreate.mockResolvedValue({ output_text: goodDesign });

    const result = await AiGeneratorService.generateValidatedArchitecture('a web app', 'proj-1', 'env-1', 'aws');

    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.graph!.nodes.length).toBeGreaterThan(5);
    expect(result.graph!.edges.length).toBeGreaterThan(0);
    // Every node was positioned by the layout engine, not left at the origin.
    expect(result.graph!.nodes.some((n) => n.position.x !== 0 || n.position.y !== 0)).toBe(true);
    expect(mockHistoryCreate).toHaveBeenCalledTimes(1);
  });

  it('sends the exact validation issues back to the model and accepts the corrected design', async () => {
    mockCreate
      .mockResolvedValueOnce({ output_text: 'not json at all' })
      .mockResolvedValueOnce({ output_text: goodDesign });

    const result = await AiGeneratorService.generateValidatedArchitecture('a web app', 'proj-1', 'env-1', 'aws');

    expect(result.ok).toBe(true);
    expect(result.attempts.map((a) => a.ok)).toEqual([false, true]);
    const repairInput = mockCreate.mock.calls[1]![0].input as { role: string; content: string }[];
    expect(repairInput[1]!.content).toContain('failed CloudCraft validation');
  });

  it('never returns a graph that failed the gates — it reports the remaining issues instead', async () => {
    mockCreate.mockResolvedValue({ output_text: JSON.stringify({ name: 'x', summary: 'y', resources: [{ id: 'a', type: 'aws_not_real', label: 'A' }], connections: [] }) });

    const result = await AiGeneratorService.generateValidatedArchitecture('a web app', 'proj-1', 'env-1', 'aws', undefined, undefined, 3);

    expect(result.ok).toBe(false);
    expect(result.graph).toBeUndefined();
    expect(result.attempts).toHaveLength(3);
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(mockHistoryCreate).not.toHaveBeenCalled();
  });

  it('appends knowledge-base context to the request the model sees, and keeps it on repair rounds', async () => {
    mockBuildContext.mockResolvedValueOnce('Reference material: aws_subnet settings are cidrBlock, availabilityZone');
    mockCreate.mockResolvedValueOnce({ output_text: 'not json' }).mockResolvedValueOnce({ output_text: goodDesign });

    await AiGeneratorService.generateValidatedArchitecture('a web app', 'p', 'e', 'aws');

    const first = (mockCreate.mock.calls[0]![0].input as { content: string }[])[1]!.content;
    const repair = (mockCreate.mock.calls[1]![0].input as { content: string }[])[1]!.content;
    expect(first).toContain('Reference material: aws_subnet settings');
    expect(repair).toContain('Reference material: aws_subnet settings');
    expect(mockBuildContext).toHaveBeenCalledWith('a web app', 'aws');
  });

  it('adds a target-cloud hint only when the request does not already name a cloud', async () => {
    mockCreate.mockResolvedValue({ output_text: goodDesign });

    await AiGeneratorService.generateValidatedArchitecture('a web app', 'p', 'e', 'azure');
    expect((mockCreate.mock.calls[0]![0].input as { content: string }[])[1]!.content).toContain('Target cloud: Azure.');

    mockCreate.mockClear();
    await AiGeneratorService.generateValidatedArchitecture('AWS primary with Azure DR', 'p', 'e', 'azure');
    expect((mockCreate.mock.calls[0]![0].input as { content: string }[])[1]!.content).toBe('AWS primary with Azure DR');
  });
});

describe('withSettingHints', () => {
  it('collapses repeated unknown-setting issues per (type, key) and lists the real setting names', async () => {
    const { withSettingHints } = await import('@/lib/services/AiGeneratorService');
    const issues = ['subnet-1a', 'subnet-1b', 'subnet-2a'].map((id) => ({
      code: 'UNKNOWN_CONFIG_KEY', message: `Resource "${id}" (aws_subnet) has no setting "cidr_block".`, resourceId: id,
    }));
    const out = withSettingHints([...issues, { code: 'CONNECTIVITY', message: 'x is not connected' }]);

    expect(out).toHaveLength(2); // 3 identical mistakes -> 1 hint, plus the untouched issue
    expect(out[0]!.message).toContain('subnet-1a, subnet-1b, subnet-2a');
    expect(out[0]!.message).toContain('cidrBlock'); // the real, camelCase name
    expect(out[1]!.message).toBe('x is not connected');
  });
});

describe('withContainmentHints', () => {
  it('tells the model which container types may hold a resource it placed in the wrong parent', async () => {
    const { withContainmentHints } = await import('@/lib/services/AiGeneratorService');
    const [out] = withContainmentHints([{ code: 'CHILD_NOT_ALLOWED', message: 'aws_vpc cannot contain aws_ecs.' }]);
    expect(out!.message).toContain('aws_ecs must be placed inside one of:');
    expect(out!.message).toContain('aws_subnet');
    expect(out!.message).not.toContain('aws_vpc, ');
  });

  it('leaves unrelated issues untouched', async () => {
    const { withContainmentHints } = await import('@/lib/services/AiGeneratorService');
    const issue = { code: 'CONNECTIVITY', message: 'db-1 is not connected' };
    expect(withContainmentHints([issue])).toEqual([issue]);
  });
});

describe('withContainmentHints — non-container parents', () => {
  it('lists the only types that may act as a parent when a model nests a resource inside a non-container', async () => {
    const { withContainmentHints } = await import('@/lib/services/AiGeneratorService');
    const [out] = withContainmentHints([{ code: 'PARENT_NOT_CONTAINER', message: '"waf-1" is placed inside "alb-1" (aws_alb), which cannot contain resources.' }]);
    expect(out!.message).toContain('Only these types may be a "parent":');
    expect(out!.message).toContain('aws_vpc');
    expect(out!.message).toContain('aws_subnet');
  });
});

describe('generateValidatedArchitecture — service notices', () => {
  const { readFileSync } = jest.requireActual('fs') as typeof import('fs');
  const goodDesign = (JSON.parse(readFileSync('datasets/ai-architect/validation.jsonl', 'utf8').split('\n')[0]!) as {
    messages: { content: string }[];
  }).messages[2]!.content;

  beforeEach(() => { mockCreate.mockReset(); mockBuildContext.mockResolvedValue(''); });

  it('reports an unsupported service the model silently worked around', async () => {
    mockCreate.mockResolvedValue({ output_text: goodDesign });
    const result = await AiGeneratorService.generateValidatedArchitecture('AWS web app with an API Gateway in front', 'p', 'e', 'aws');
    expect(result.ok).toBe(true);
    expect(result.notices.unsupported.map((u) => u.service)).toEqual(['API Gateway']);
  });

  it('carries the unsupported services on a failure too, so the route can name the real reason', async () => {
    mockCreate.mockResolvedValue({ output_text: JSON.stringify({ name: 'x', summary: 'y', resources: [{ id: 'a', type: 'aws_kinesis', label: 'A' }], connections: [] }) });
    const result = await AiGeneratorService.generateValidatedArchitecture('real-time pipeline with Kinesis and Redshift', 'p', 'e', 'aws', undefined, undefined, 2);
    expect(result.ok).toBe(false);
    expect(result.notices.unsupported.map((u) => u.service)).toEqual(['Kinesis', 'Redshift']);
  });

  it('reports nothing for a request that names only supported services', async () => {
    mockCreate.mockResolvedValue({ output_text: goodDesign });
    const result = await AiGeneratorService.generateValidatedArchitecture('AWS web app', 'p', 'e', 'aws');
    expect(result.notices.unsupported).toEqual([]);
  });
});

describe('generateValidatedArchitecture — setting-name clean-up', () => {
  const { readFileSync } = jest.requireActual('fs') as typeof import('fs');
  // A design with an AWS load balancer (the tests below point a monitoring alarm at it). The dataset's order changes whenever it is regenerated.
  const good = JSON.parse(readFileSync('datasets/ai-architect/validation.jsonl', 'utf8').split('\n').filter(Boolean)
    .map((l) => (JSON.parse(l) as { messages: { content: string }[] }).messages[2]!.content)
    .find((c) => c.trim().startsWith('{') && c.includes('"type":"aws_alb"'))!);

  beforeEach(() => { mockCreate.mockReset(); mockBuildContext.mockResolvedValue(''); });

  it('accepts a design on the first attempt when its setting names are only spelled differently, and says nothing about it', async () => {
    const snake = JSON.parse(JSON.stringify(good));
    for (const r of snake.resources) if (r.config) r.config = Object.fromEntries(Object.entries(r.config).map(([k, v]) => [k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), v]));
    mockCreate.mockResolvedValue({ output_text: JSON.stringify(snake) });

    const result = await AiGeneratorService.generateValidatedArchitecture('a web app', 'p', 'e', 'aws');

    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.sanitized.renamed.length).toBeGreaterThan(0);
    expect(result.sanitized.dropped).toEqual([]);
  });

  it('accepts a design that contains an invented setting, and reports exactly what was ignored', async () => {
    const invented = JSON.parse(JSON.stringify(good));
    invented.resources[0].config = { ...(invented.resources[0].config ?? {}), totallyMadeUpSetting: 1 };
    mockCreate.mockResolvedValue({ output_text: JSON.stringify(invented) });

    const result = await AiGeneratorService.generateValidatedArchitecture('a web app', 'p', 'e', 'aws');

    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.sanitized.dropped).toEqual([{ type: invented.resources[0].type, setting: 'totallyMadeUpSetting', resources: [invented.resources[0].id] }]);
  });

  it('resets a wrong VALUE for a choice setting to its default, and says so, instead of failing the design', async () => {
    const badValue = JSON.parse(JSON.stringify(good));
    badValue.resources.push({ id: 'cw-alarm', type: 'aws_cloudwatch', label: 'Alarm', config: { periodSeconds: 45, invented_thing: true } });
    badValue.connections.push({ from: 'cw-alarm', to: badValue.resources.find((r: { type: string }) => r.type === 'aws_alb').id });   // monitoring points at a workload
    mockCreate.mockResolvedValueOnce({ output_text: JSON.stringify(badValue) });

    const result = await AiGeneratorService.generateValidatedArchitecture('a web app', 'p', 'e', 'aws');

    expect(result.attempts.map((a) => a.ok)).toEqual([true]);                       // no second round trip to the model
    expect(result.sanitized.specRepairs?.choices).toBe(1);                         // the reset is reported
    expect(result.sanitized.dropped.map((d) => d.setting)).toEqual(['invented_thing']);
  });

  it('still fails a design with a wrong VALUE that is not a choice (a number out of range), and sends the cleaned design back for repair', async () => {
    const badValue = JSON.parse(JSON.stringify(good));
    badValue.resources.push({ id: 'cw-alarm', type: 'aws_cloudwatch', label: 'Alarm', config: { threshold: 'lots', invented_thing: true } });
    badValue.connections.push({ from: 'cw-alarm', to: badValue.resources.find((r: { type: string }) => r.type === 'aws_alb').id });   // monitoring points at a workload
    mockCreate.mockResolvedValueOnce({ output_text: JSON.stringify(badValue) }).mockResolvedValueOnce({ output_text: JSON.stringify(good) });

    const result = await AiGeneratorService.generateValidatedArchitecture('a web app', 'p', 'e', 'aws');

    expect(result.attempts.map((a) => a.ok)).toEqual([false, true]);
    const repair = (mockCreate.mock.calls[1]![0].input as { content: string }[])[1]!.content;
    expect(repair).toContain('threshold');              // the real mistake is reported
    expect(repair).not.toContain('invented_thing');     // the dropped setting is not sent back as if it still mattered
  });
});

describe('questionnaire only offers services CloudBuilder can model', () => {
  const { detectServiceNotices } = jest.requireActual('@/lib/ai/serviceCoverage') as typeof import('@/lib/ai/serviceCoverage');
  const { dropUnsupportedOptions } = jest.requireActual('@/lib/services/AiGeneratorService') as typeof import('@/lib/services/AiGeneratorService');
  const optionText = (o: { label?: string; description?: string; technicalImpact?: string }) => `${o.label} ${o.description} ${o.technicalImpact}`;

  it.each(['aws', 'azure'] as const)('the built-in %s options name no unsupported service, even for a serverless request', async (provider) => {
    mockCreate.mockRejectedValue(new Error('offline'));            // force the built-in questionnaire
    const q = await AiGeneratorService.generateQuestionnaire('SaaS app with lambda serverless functions and a redis cache', provider);
    const offenders = q.questions.flatMap((qu) => qu.options).filter((o) => detectServiceNotices(optionText(o)).unsupported.length > 0);
    expect(offenders.map((o) => o.label)).toEqual([]);
    expect(q.questions.some((qu) => qu.options.some((o) => /serverless/i.test(o.label)))).toBe(true);   // the serverless choice is still there
  });

  it('tells the model which services not to offer', async () => {
    mockCreate.mockResolvedValue({ output_text: JSON.stringify({ questions: [] }) });
    await AiGeneratorService.generateQuestionnaire('a web app', 'aws');
    const system = (mockCreate.mock.calls.at(-1)![0].input as { content: string }[])[0]!.content;
    expect(system).toMatch(/NEVER offer them as options/);
    expect(system).toContain('API Gateway');
  });

  it('removes options the model offered anyway, re-points a removed default, and drops a question with nothing left', () => {
    const q = (id: string, options: { id: string; label: string; isRecommended?: boolean }[], defaultOptionId: string) =>
      ({ id, category: 'compute', categoryLabel: 'Compute', question: 'Q?', rationale: '', options: options.map((o) => ({ description: '', technicalImpact: '', isRecommended: false, ...o })), defaultOptionId }) as never;
    const out = dropUnsupportedOptions([
      q('q1', [{ id: 'a', label: 'Lambda + API Gateway', isRecommended: true }, { id: 'b', label: 'ECS Fargate' }, { id: 'c', label: 'EC2 instances' }], 'a'),
      q('q2', [{ id: 'x', label: 'API Gateway only' }], 'x'),
      q('q3', [{ id: 'm', label: 'Multi-AZ RDS', isRecommended: true }], 'm'),
    ]);
    expect(out.map((x) => x.id)).toEqual(['q1', 'q3']);
    expect(out[0]!.options.map((o) => o.id)).toEqual(['b', 'c']);
    expect(out[0]!.defaultOptionId).toBe('b');            // the default was removed, so it points at a remaining option
    expect(out[1]!.defaultOptionId).toBe('m');            // untouched
  });
});
