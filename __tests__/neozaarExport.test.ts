/**
 * The Neozaar marketplace export: a template as the body of Create Service, what is missing, what is to be reviewed, and that every value is one the form offers.
 */
import { architectureTemplates } from '@/lib/templates';
import { builtInRow, fromRow, graphOf } from '@/lib/templates/stored';
import { publicTemplate, type PublicTemplate } from '@/lib/apiKeys/publicTemplate';
import { toNeozaarService, technicalPrerequisites, REQUIRED } from '@/lib/marketplace/neozaar';
import { ALLOWED, CATEGORY_PROFILES, FIXED, SUBCATEGORIES, SERVICE_DETAIL_KEYS, DEFAULT_USD_INR } from '@/lib/marketplace/neozaarConfig';
import { ListingSchema } from '@/lib/marketplace/listingSchema';

const pub = (t: (typeof architectureTemplates)[number], over: Partial<PublicTemplate> = {}): PublicTemplate => {
  const row = { ...builtInRow(t), createdBy: null, createdAt: 't', updatedAt: 't' } as unknown as Record<string, unknown>;
  return { ...publicTemplate(fromRow(row), graphOf(row)), ...over };
};
const all = architectureTemplates.map((t) => pub(t));
const json = (s: string | undefined) => JSON.parse(s ?? 'null') as string[];

describe('the configuration agrees with itself', () => {
  test('every default is a value the form offers, and every category and sub-category is real', () => {
    for (const [name, p] of Object.entries(CATEGORY_PROFILES)) {
      for (const [list, allowed] of [[p.audience, ALLOWED.targetAudience], [p.segments, ALLOWED.targetSegments], [p.industries, ALLOWED.industry], [p.cta, ALLOWED.ctaModel]] as const) {
        for (const v of list) expect({ name, v, ok: (allowed as readonly string[]).includes(v) }).toEqual({ name, v, ok: true });
      }
      expect((ALLOWED.category as readonly string[]).includes(p.category)).toBe(true);
      expect(SUBCATEGORIES[p.category]).toContain(p.subCategory);
      expect(p.challenge.length).toBeGreaterThan(40);
    }
    expect(ALLOWED.pricingModel).toContain(FIXED.pricing_model);
    expect(ALLOWED.actionFor).toContain(FIXED.action_for);
  });
  test('every category of the built-in templates has a profile', () => {
    const missing = [...new Set(architectureTemplates.map((t) => t.category))].filter((c) => !CATEGORY_PROFILES[c]);
    expect(missing).toEqual([]);
  });
});

describe('one template', () => {
  const t = all.find((x) => x.provider === 'azure' && x.category === 'Disaster Recovery')!;
  const r = toNeozaarService(t);
  test('is a draft service from Neozaar for customers and ISVs, with the form\'s own words for everything', () => {
    expect(r.catalog.type).toBe('product');
    expect(r.catalog.fields).toMatchObject({ action_type: 'service', brand_name: 'Neozaar', action_for: 'both', pricing_model: 'Monthly Subscription', name: t.name });
    expect(json(r.catalog.fields['cloud_provider_support'])).toEqual(['Azure']);
    expect(json(r.catalog.fields['regions_supported'])).toEqual(['Global']);
    expect(json(r.catalog.fields['category'])).toEqual(['Protect & Recover Data']);
    expect(json(r.catalog.fields['category_subcategory'])).toEqual(['Disaster Recovery']);
    expect(json(r.catalog.fields['tags'])).toEqual(t.tags);
  });
  test('the list fields are JSON strings and everything else is plain text, as the controller reads them', () => {
    for (const k of ['target_audience', 'target_segments', 'industry', 'cta_model', 'cloud_provider_support', 'regions_supported', 'category', 'category_subcategory', 'tags']) {
      expect(typeof r.catalog.fields[k]).toBe('string');
      expect(Array.isArray(JSON.parse(r.catalog.fields[k]!))).toBe(true);
    }
    expect(Object.values(r.catalog.fields).every((v) => typeof v === 'string')).toBe(true);
  });
  test('the service details carry the overview, approach, scope, outcome, challenges and coverage', () => {
    const d = r.catalog.service_solution_details;
    const K = SERVICE_DETAIL_KEYS;
    expect(Object.keys(d).sort()).toEqual([K.approach, K.challenges, K.coverage, K.outcome, K.overview, K.scope].sort());
    expect(d[K.coverage]).toEqual(['Global']);
    expect(Array.isArray(d[K.outcome])).toBe(true);
  });
  test('the price is the estimate in rupees, and it says what it is', () => {
    expect(r.catalog.fields['starting_price']).toBe(String(Math.round(t.estimatedCostUsd * DEFAULT_USD_INR)));
    expect(r.review.join('\n')).toMatch(/starting_price: the estimated monthly cloud running cost converted to rupees, not a sale price/);
    expect(r.catalog.fields['long_description']).toMatch(/Indicative cloud running cost: about ₹.* \(an estimate/);
  });
  test('the technical prerequisites name what the template creates, from its graph', () => {
    expect(r.catalog.fields['technical_prerequisites']).toMatch(/^An (AWS|Azure|AWS and Azure) account with permission to create these \d+ resources: /);
    expect(r.catalog.fields['technical_prerequisites']).not.toMatch(/cloudNode|containerNode/);       // the kinds of resource, not how the canvas draws them
  });
  test('what was defaulted or copied is to be reviewed', () => {
    const text = r.review.join('\n');
    expect(text).toMatch(/audience, segments, industry and CTA: the defaults for the "Disaster Recovery" category/);
    expect(text).toMatch(/outcome: copied from the architecture's features/);
    expect(text).toMatch(/challenges_addressed: a first draft/);
    expect(text).not.toMatch(/approach:|scope:/);          // this one is a hand-built reference architecture: it has its own pattern and use cases
    expect(text).toMatch(/pricing_model: set to Monthly Subscription/);
  });
});

describe('a quick-start template (no pattern or use cases of its own)', () => {
  const t = all.find((x) => !(x.details as { architecturePattern?: string }).architecturePattern)!;
  test('gets an approach and a scope worked out from what it has, and they are listed for review', () => {
    const r = toNeozaarService(t);
    const d = r.catalog.service_solution_details;
    expect(String(d[SERVICE_DETAIL_KEYS.approach])).toMatch(new RegExp(`^A ${t.complexity} (AWS|Azure|AWS and Azure) .* architecture: `));
    expect(String(d[SERVICE_DETAIL_KEYS.scope])).toContain(`${t.resourceCount}-resource`);
    expect(r.review.join('\n')).toMatch(/approach: worked out from/);
    expect(r.review.join('\n')).toMatch(/scope: a standard description/);
    expect(r.ready).toBe(true);
  });
});

describe('all the built-in templates', () => {
  const results = all.map((t) => toNeozaarService(t));
  test('every one can be exported, and the required fields are all filled (by the defaults, flagged for review)', () => {
    const notReady = results.filter((r) => !r.ready).map((r) => `${r.id}: ${r.missing.join(', ')}`);
    expect(notReady).toEqual([]);
    expect(results.length).toBe(architectureTemplates.length);
  });
  test('every value for a choice list is one the form offers, and nothing is too long', () => {
    for (const r of results) {
      const f = r.catalog.fields;
      for (const v of json(f['target_audience'])) expect(ALLOWED.targetAudience).toContain(v);
      for (const v of json(f['target_segments'])) expect(ALLOWED.targetSegments).toContain(v);
      for (const v of json(f['industry'])) expect(ALLOWED.industry).toContain(v);
      for (const v of json(f['cta_model'])) expect(ALLOWED.ctaModel).toContain(v);
      for (const v of json(f['cloud_provider_support'])) expect(ALLOWED.platform).toContain(v);
      expect(ALLOWED.pricingModel).toContain(f['pricing_model']);
      expect(f['short_description']!.length).toBeLessThanOrEqual(500);
      expect(Number(f['starting_price'])).toBeGreaterThan(0);
      expect(f['technical_prerequisites']).not.toMatch(/cloudNode|containerNode|groupNode|undefined/);
      for (const k of REQUIRED) if (!['overview', 'approach', 'scope', 'outcome', 'challenges_addressed'].includes(k)) expect(f[k]).toBeTruthy();
    }
  });
  test('no template is described as official or certified', () => {
    for (const r of results) expect(JSON.stringify(r)).not.toMatch(/officially|certified by|AWS-published|Microsoft-published/i);
  });
  test('the platform follows the template\'s cloud, and multi-cloud is both', () => {
    for (const t of all) {
      const r = toNeozaarService(t);
      expect(json(r.catalog.fields['cloud_provider_support'])).toEqual(t.provider === 'aws' ? ['AWS'] : t.provider === 'azure' ? ['Azure'] : ['AWS', 'Azure']);
    }
  });
});

describe('what an organization writes overrides the defaults', () => {
  const t = all[0]!;
  test('its own text, price, audience and category replace the drafts and the estimate, and leave nothing to review for them', () => {
    const r = toNeozaarService(t, {
      challenges: 'Our own text about the problem.', outcomes: ['Cut deployment time'], startingPrice: 12345, pricingModel: 'Yearly Subscription',
      audience: ['CISO'], segments: ['Government'], industries: ['Defense'], ctaModels: ['Free Trial'], regions: ['India'], category: 'Adapt AI & Data', subCategory: 'AI Agents', differentiator: 'Ours', termsOfUseUrl: 'https://example.com/terms',
    });
    const f = r.catalog.fields; const d = r.catalog.service_solution_details;
    expect(f).toMatchObject({ starting_price: '12345', pricing_model: 'Yearly Subscription', solution_differentiator: 'Ours', terms_of_use_url: 'https://example.com/terms' });
    expect(json(f['target_audience'])).toEqual(['CISO']);
    expect(json(f['regions_supported'])).toEqual(['India']);
    expect(json(f['category'])).toEqual(['Adapt AI & Data']);
    expect(json(f['category_subcategory'])).toEqual(['AI Agents']);
    expect(d[SERVICE_DETAIL_KEYS.challenges]).toBe('Our own text about the problem.');
    expect(d[SERVICE_DETAIL_KEYS.outcome]).toEqual(['Cut deployment time']);
    expect(d[SERVICE_DETAIL_KEYS.coverage]).toEqual(['India']);
    const text = r.review.join('\n');
    expect(text).not.toMatch(/starting_price|audience, segments|outcome:|challenges_addressed|pricing_model/);
  });
  test('a value the form does not offer is dropped (and its field is then missing), never sent', () => {
    const r = toNeozaarService(t, { audience: ['Astronaut'], ctaModels: ['Buy now'] } as never);
    expect(r.catalog.fields['target_audience']).toBeUndefined();
    expect(r.catalog.fields['cta_model']).toBeUndefined();
    expect(r.missing).toEqual(expect.arrayContaining(['target_audience', 'cta_model']));
    expect(r.ready).toBe(false);
  });
  test('without an estimate there is no price, and the template says so instead of sending a zero', () => {
    const r = toNeozaarService({ ...t, estimatedCostUsd: 0 });
    expect(r.catalog.fields['starting_price']).toBeUndefined();
    expect(r.missing).toContain('starting_price');
    expect(toNeozaarService({ ...t, estimatedCostUsd: 0 }, { startingPrice: 500 }).catalog.fields['starting_price']).toBe('500');
  });
  test('a custom template with a category of its own gets the general defaults and is flagged', () => {
    const r = toNeozaarService({ ...t, category: 'Custom', source: 'org' });
    expect(r.review.join('\n')).toMatch(/category: "Cloud Infrastructure > Cloud Environments" is a proposal for the "Custom" category/);
    expect(r.catalog.service_solution_details[SERVICE_DETAIL_KEYS.challenges]).toBeUndefined();
    expect(r.missing).toContain('challenges_addressed');
  });
  test('the rupee rate can be set', () => {
    process.env['CLOUDBUILDER_NEOZAAR_USD_INR'] = '100';
    try { expect(toNeozaarService(t).catalog.fields['starting_price']).toBe(String(Math.round(t.estimatedCostUsd * 100))); } finally { delete process.env['CLOUDBUILDER_NEOZAAR_USD_INR']; }
  });
});

describe('the technical prerequisites', () => {
  test('say nothing when there is no graph, and count repeated kinds', () => {
    expect(technicalPrerequisites({ ...all[0]!, graph: undefined })).toBeNull();
    const t = { ...all[0]!, graph: { nodes: [{ id: 'a', type: 'cloudNode', resourceType: 'aws_ec2' }, { id: 'b', type: 'cloudNode', resourceType: 'aws_ec2' }, { id: 'c', type: 'containerNode', resourceType: 'aws_cloud_boundary' }] as never, edges: [] } };
    expect(technicalPrerequisites(t)).toMatch(/these 3 resources: .*\(2\)/);
  });
});

describe('what an administrator may write', () => {
  test('values from the form\'s lists, in range, and nothing else', () => {
    expect(ListingSchema.safeParse({ audience: ['CTO'], startingPrice: 100, category: 'Cloud Infrastructure', subCategory: 'Containers' }).success).toBe(true);
    for (const bad of [{ audience: ['Astronaut'] }, { startingPrice: -1 }, { pricingModel: 'Weekly' }, { category: 'Made Up' }, { category: 'Cloud Infrastructure', subCategory: 'HRMS' }, { termsOfUseUrl: 'javascript:alert(1)' }, { outcomes: [] }, { surprise: 1 }, { challenges: ' ' }]) {
      expect(ListingSchema.safeParse(bad).success).toBe(false);
    }
  });
});
