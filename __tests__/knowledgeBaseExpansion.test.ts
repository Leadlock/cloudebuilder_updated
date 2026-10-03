import { evaluateSpec, CATALOG_TYPES } from '@/lib/ai/architectureSpec';
import { hardenSpec } from '../scripts/ai-dataset/harden';
import { awsStaticSite, awsEventDriven, awsLambdaPrivateApi, azureStaticSite, azureFunctionsPrivateApi } from '../scripts/ai-dataset/morePatterns';
import { PATTERN_TEXT, type Requirements } from '../scripts/ai-dataset/requirements';
import { embeddingHash, loadChunks } from '@/lib/ai/knowledgeBase';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const aws: Requirements = { provider: 'aws', pattern: 'x', region: 'us-east-1', scale: 'medium', db: 'postgres', cache: true, cdn: true, regulated: false, queue: false, app: 'storefront' };
const azure: Requirements = { ...aws, provider: 'azure', region: 'eastus' };

const patterns: [string, (r: Requirements) => ReturnType<typeof awsStaticSite>, Requirements][] = [
  ['aws-static-site', awsStaticSite, aws], ['aws-event-driven', awsEventDriven, aws], ['aws-lambda-private-api', awsLambdaPrivateApi, aws],
  ['azure-static-site', azureStaticSite, azure], ['azure-functions-private-api', azureFunctionsPrivateApi, azure],
];

describe.each(patterns)('new pattern %s', (id, fn, base) => {
  it.each([
    ['small', { scale: 'small' as const }], ['medium', {}], ['large + regulated', { scale: 'large' as const, regulated: true }],
  ])('passes every deploy-readiness gate (%s)', (_n, v) => {
    const spec = hardenSpec(fn({ ...base, pattern: id, ...v })).spec;
    const ev = evaluateSpec(spec);
    expect(ev.issues.map((i) => i.message)).toEqual([]);
    expect(ev.ok).toBe(true);
    for (const r of spec.resources) expect(CATALOG_TYPES).toContain(r.type);       // never invents a resource type
  });
  it('has prompt wording so it can be described to the model', () => {
    expect(PATTERN_TEXT[id]?.phrases.length).toBeGreaterThan(0);
  });
});

describe('the generated knowledge base', () => {
  const chunks = loadChunks();
  const ids = new Set(chunks.map((c) => c.id));

  it('contains the new patterns and the new guidelines', () => {
    for (const [id] of patterns) expect(ids).toContain(`pattern-${id}`);
    expect(ids).toContain('guideline-one-boundary-per-cloud');
    expect(ids).toContain('guideline-static-sites-and-event-driven-workloads');
  });

  it('keeps one chunk for every usable resource type, now listing the rules that check it', () => {
    for (const t of CATALOG_TYPES) expect(ids).toContain(`catalog-${t}`);
    const alb = chunks.find((c) => c.id === 'catalog-aws_alb')!;
    expect(alb.text).toMatch(/Assessment rules that check this type: .*\(/);
  });

  it('has an up-to-date vector for every chunk (otherwise search silently falls back to keywords)', () => {
    const file = JSON.parse(readFileSync(path.join(process.cwd(), 'datasets', 'ai-architect', 'knowledge-base', 'embeddings.json'), 'utf8')) as { chunks: Record<string, { hash: string }> };
    const stale = chunks.filter((c) => file.chunks[c.id]?.hash !== embeddingHash(c)).map((c) => c.id);
    expect(stale).toEqual([]);
  });
});
