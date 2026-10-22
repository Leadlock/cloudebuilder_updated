/**
 * A CloudBuilder template as the body of Neozaar's Create Service request (POST /catalog/product, multipart): the plain fields, the list fields as
 * JSON strings (as the controller reads them), and `service_solution_details` for a service. Pure: no database, no network.
 *
 * Where the template has no data for a required field the field is left out and named in `missing`; what was filled from a default or an estimate is
 * named in `review`, so a person looks at it before the service is published. Neozaar saves every created service as an unpublished draft.
 */
import { getResourceDefinition } from '@/lib/resources';
import { ALLOWED, CATEGORY_PROFILES, FALLBACK_PROFILE, FIXED, PLATFORM_MAP, SERVICE_DETAIL_KEYS, SUBCATEGORIES, usdInr, type CategoryProfile } from './neozaarConfig';
import type { PublicTemplate } from '@/lib/apiKeys/publicTemplate';

/** What an organization wrote for one template, on top of the defaults. Every field is optional. */
export interface TemplateListing {
  challenges?: string;
  outcomes?: string[];
  pricingModel?: string;
  /** In rupees, as the form takes it. */
  startingPrice?: number;
  audience?: string[];
  segments?: string[];
  industries?: string[];
  ctaModels?: string[];
  regions?: string[];
  category?: string;
  subCategory?: string;
  differentiator?: string;
  termsOfUseUrl?: string;
}

export interface NeozaarService {
  type: 'product';
  /** The multipart text fields. A list is a JSON string of an array. */
  fields: Record<string, string>;
  /** The JSON for the `service_solution_details` field (the controller reads it as a string). */
  service_solution_details: Record<string, unknown>;
}

export interface NeozaarExport {
  id: string;
  name: string;
  ready: boolean;
  /** Required fields with no value. */
  missing: string[];
  /** Fields that were filled from a default or an estimate and should be read before publishing. */
  review: string[];
  catalog: NeozaarService;
}

/** The fields the Create Service form marks as required, by the name this export gives them. */
export const REQUIRED = ['name', 'brand_name', 'short_description', 'overview', 'approach', 'scope', 'outcome', 'challenges_addressed', 'technical_prerequisites', 'pricing_model', 'starting_price', 'action_for', 'target_audience', 'target_segments', 'industry', 'cta_model', 'cloud_provider_support', 'category', 'category_subcategory', 'regions_supported'] as const;

const list = (v: readonly string[]) => JSON.stringify(v);
const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const known = (values: readonly string[] | undefined, allowed: readonly string[]) => (values ?? []).filter((v) => allowed.includes(v));

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40))}…`;
}

/** "10 resources: AKS, Application Gateway, Azure SQL (2) …" from the template's graph: what the customer needs the cloud account to be able to create. */
export function technicalPrerequisites(t: PublicTemplate): string | null {
  const nodes = t.graph?.nodes ?? [];
  if (nodes.length === 0) return null;
  const counts = new Map<string, number>();
  for (const n of nodes) {
    // A canvas node's `type` is how it is drawn (cloudNode, containerNode); `resourceType` is what it is (aws_ec2, azure_sql).
    const node = n as { type?: unknown; resourceType?: unknown };
    const type = String(node.resourceType ?? node.type ?? '');
    if (!type || /boundary$/.test(type)) continue;
    const label = getResourceDefinition(type)?.label ?? type.replace(/^(aws|azure)_/, '').replace(/_/g, ' ');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return null;
  const shown = entries.slice(0, 15).map(([label, n]) => (n > 1 ? `${label} (${n})` : label));
  const cloud = t.provider === 'aws' ? 'AWS' : t.provider === 'azure' ? 'Azure' : 'AWS and Azure';
  return `An ${cloud} account with permission to create these ${nodes.length} resources: ${shown.join(', ')}${entries.length > 15 ? `, and ${entries.length - 15} more kinds` : ''}.`;
}

export function toNeozaarService(t: PublicTemplate, listing: TemplateListing = {}): NeozaarExport {
  const profile: CategoryProfile = CATEGORY_PROFILES[t.category] ?? FALLBACK_PROFILE;
  const details = (t.details ?? {}) as { architecturePattern?: string; useCases?: string[]; dataFlowSummary?: string; sourceReferences?: Array<{ label: string }>; availabilityTarget?: string; supportedScale?: string };
  const review: string[] = [];
  const fields: Record<string, string> = {};
  const set = (k: string, v: string | undefined | null) => { if (v !== undefined && v !== null && String(v).trim() !== '') fields[k] = String(v); };

  // The estimate is the cloud running cost per month in dollars; the form wants rupees. It is an indication, never a sale price.
  const estimateInr = t.estimatedCostUsd > 0 ? Math.round(t.estimatedCostUsd * usdInr()) : 0;
  const price = listing.startingPrice ?? (estimateInr > 0 ? estimateInr : undefined);
  if (listing.startingPrice === undefined && estimateInr > 0) review.push('starting_price: the estimated monthly cloud running cost converted to rupees, not a sale price');

  const based = (details.sourceReferences ?? []).map((r) => r.label).filter(Boolean);
  const longDescription = [
    clean(t.description),
    details.dataFlowSummary ? `How it works: ${clean(details.dataFlowSummary)}` : '',
    details.availabilityTarget ? `Availability: ${clean(details.availabilityTarget)}.` : '',
    based.length > 0 ? `Based on: ${based.slice(0, 4).join('; ')}.` : '',
    estimateInr > 0 ? `Indicative cloud running cost: about ₹${estimateInr.toLocaleString('en-IN')} a month (an estimate, excluding the service fee).` : '',
  ].filter(Boolean).join('\n\n');

  const audience = known(listing.audience ?? profile.audience, ALLOWED.targetAudience);
  const segments = known(listing.segments ?? profile.segments, ALLOWED.targetSegments);
  const industries = known(listing.industries ?? profile.industries, ALLOWED.industry);
  const cta = known(listing.ctaModels ?? profile.cta, ALLOWED.ctaModel);
  const platform = [...(PLATFORM_MAP[t.provider] ?? [])];
  const regions = listing.regions && listing.regions.length > 0 ? listing.regions : [...FIXED.regions];
  const category = listing.category ?? profile.category;
  const subCategory = listing.subCategory ?? profile.subCategory;
  // A sub-category is checked against the known ones; for a category whose sub-categories are not known, the one an administrator wrote is taken as it is.
  const subOk = !!subCategory && (SUBCATEGORIES[category] ? SUBCATEGORIES[category]!.includes(subCategory) : !!listing.subCategory);
  const pricingModel = listing.pricingModel && (ALLOWED.pricingModel as readonly string[]).includes(listing.pricingModel) ? listing.pricingModel : FIXED.pricing_model;
  if (!listing.audience || !listing.segments || !listing.industries || !listing.ctaModels) review.push(`audience, segments, industry and CTA: the defaults for the "${t.category}" category`);
  if (!listing.category && !profile.confirmed) review.push(`category: "${category} > ${subCategory}" is a proposal for the "${t.category}" category, not yet confirmed`);
  if (!listing.pricingModel) review.push('pricing_model: set to Monthly Subscription because the estimate is a monthly figure');

  set('name', clean(t.name));
  set('brand_name', FIXED.brand_name);
  set('short_description', truncate(clean(t.description), 500));
  set('long_description', longDescription);
  set('key_features', t.features.map((f) => `• ${clean(f)}`).join('\n'));
  set('primary_use_cases', (details.useCases ?? []).map(clean).join('; '));
  set('solution_differentiator', listing.differentiator ?? clean(details.architecturePattern));
  set('technical_prerequisites', technicalPrerequisites(t));
  set('pricing_model', pricingModel);
  set('starting_price', price !== undefined ? String(price) : undefined);
  set('action_type', FIXED.action_type);
  set('action_for', FIXED.action_for);
  if (audience.length > 0) set('target_audience', list(audience));
  if (segments.length > 0) set('target_segments', list(segments));
  if (industries.length > 0) set('industry', list(industries));
  if (cta.length > 0) set('cta_model', list(cta));
  if (platform.length > 0) set('cloud_provider_support', list(platform));
  if (regions.length > 0) set('regions_supported', list(regions));
  if ((ALLOWED.category as readonly string[]).includes(category)) set('category', list([category]));
  if (subOk) set('category_subcategory', list([subCategory]));
  if (t.tags.length > 0) set('tags', list(t.tags));
  set('terms_of_use_url', listing.termsOfUseUrl);

  // A service keeps its overview, approach, scope, outcome and challenges in service_solution_details.
  const K = SERVICE_DETAIL_KEYS;
  const outcomes = listing.outcomes && listing.outcomes.length > 0 ? listing.outcomes : t.features.map(clean).filter(Boolean);
  if (!listing.outcomes && outcomes.length > 0) review.push('outcome: copied from the architecture\'s features, which describe what it contains rather than the result for a customer');
  const challenge = clean(listing.challenges) || clean(profile.challenge);
  if (!listing.challenges && challenge) review.push(`challenges_addressed: a first draft for the "${t.category}" category`);
  const overview = [clean(t.description), clean(details.dataFlowSummary)].filter(Boolean).join(' ');
  // Only the hand-built reference architectures say which pattern they follow and what they suit. The others get an approach and a scope worked out
  // from their category, features and resources, and these are listed for review.
  const cloudName = t.provider === 'aws' ? 'AWS' : t.provider === 'azure' ? 'Azure' : 'AWS and Azure';
  const derivedApproach = t.features.length > 0 ? `A ${t.complexity} ${cloudName} ${t.category.toLowerCase()} architecture: ${t.features.slice(0, 4).map(clean).join('; ')}.` : '';
  const derivedScope = t.resourceCount > 0 ? `Design of the ${t.resourceCount}-resource ${cloudName} architecture and its generation as deployable infrastructure code, to be adapted to the customer's environment.` : '';
  const approach = clean(details.architecturePattern) || derivedApproach;
  const scope = (details.useCases ?? []).length > 0 ? (details.useCases ?? []).map(clean).join('; ') : derivedScope;
  if (!clean(details.architecturePattern) && approach) review.push('approach: worked out from the template\'s category and features');
  if ((details.useCases ?? []).length === 0 && scope) review.push('scope: a standard description of the design work, as the template lists no use cases');

  const service_solution_details: Record<string, unknown> = {
    ...(overview ? { [K.overview]: overview } : {}),
    ...(approach ? { [K.approach]: approach } : {}),
    ...(scope ? { [K.scope]: scope } : {}),
    ...(outcomes.length > 0 ? { [K.outcome]: outcomes } : {}),
    ...(challenge ? { [K.challenges]: challenge } : {}),
    [K.coverage]: [...regions],
  };

  // What the form requires, by the names above (the details' keys are the form's names, whatever Neozaar calls them inside service_solution_details).
  const have: Record<string, boolean> = {
    overview: !!overview, approach: !!approach, scope: !!scope, outcome: outcomes.length > 0, challenges_addressed: !!challenge,
  };
  const missing = REQUIRED.filter((r) => (r in have ? !have[r] : !fields[r]));

  return { id: t.id, name: t.name, ready: missing.length === 0, missing: [...missing], review, catalog: { type: FIXED.type, fields, service_solution_details } };
}
