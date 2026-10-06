/**
 * AI-proposed equivalents for resource types the hand-written AWS<->Azure table does not cover (EKS, ECS, SQS, App Service, Bastion ...).
 *
 * The model only chooses a resource TYPE from CloudCraft's own catalogue for the other cloud; it cannot invent a type, and it does not
 * translate settings or produce a price. The matched resource is priced from its default sizing by the normal pricing path, and the
 * cost screen marks it as an AI match so the user knows to check it.
 */
import { CloudCostComparisonService } from '@/lib/engines/comparison/CloudCostComparisonService';
import { allResources } from '@/lib/resources';
import type { AskModel } from './askModel';

type Provider = 'aws' | 'azure';

export interface AiMatch { resourceId: string; from: string; to: string; reason: string }

interface ResourceLike { id: string; resourceType: string; provider: string; configJson?: string; label?: string; region?: string | null }

/** Types that never cost anything on their own, or are only drawing helpers: not worth asking about. */
const NOT_BILLABLE = /(_vpc|_vnet|_subnet|_sg|_nsg|_nacl|_route_table|_igw|_internet|_iam|_resource_group|_nic|_cloud_boundary|_unsupported|_unknown)$/;

/**
 * Types that must never be matched by the model, because the catalogue has no service that does the same job and any candidate is a different
 * product with a different price. Route 53 (DNS) was matched to a Load Balancer ($18 against $0.50) because both "route traffic". They stay
 * unmatched, which the cost screen shows as having no equivalent, rather than as a wrong price.
 */
const NO_EQUIVALENT = new Set(['aws_route53']);

const sourceTypeCache = new Map<string, string | null>();

function catalogue(target: Provider) {
  return allResources.filter((r) => r.provider === target && !NOT_BILLABLE.test(r.type) && !r.isContainer);
}

const SYSTEM = `You map cloud resource types to the closest equivalent service on the other cloud. Choose ONLY from the candidate list you are given.
Answer with JSON only: {"matches":[{"resourceType":"<source type>","to":"<candidate type>","reason":"<one short sentence>"}]}.
Omit a source type when no candidate is a genuine functional equivalent. Never invent a type. Do not mention prices.`;

export async function translateResourcesWithAi<T extends ResourceLike>(
  resources: T[],
  target: Provider,
  ask: AskModel,
): Promise<{ resources: T[]; matches: AiMatch[] }> {
  const base = CloudCostComparisonService.translateResources(resources as never[], target) as T[];
  const candidates = catalogue(target);
  const allowed = new Set(candidates.map((c) => c.type));

  // Types the fixed table left alone (it only swaps the provider tag for a type it has no mapping for).
  const unmapped = [...new Set(resources.filter((r, i) => base[i]!.resourceType === r.resourceType && !NOT_BILLABLE.test(r.resourceType) && !NO_EQUIVALENT.has(r.resourceType)).map((r) => r.resourceType))];
  const wanted = unmapped.filter((t) => !sourceTypeCache.has(`${target}:${t}`));

  if (wanted.length > 0) {
    const list = candidates.map((c) => `${c.type}: ${c.label}`).join('\n');
    const labels = wanted.map((t) => `${t}: ${allResources.find((r) => r.type === t)?.label ?? t}`).join('\n');
    let answer: Record<string, unknown> | undefined;
    try {
      answer = await ask(SYSTEM, `Source types to map:\n${labels}\n\nCandidate types on ${target}:\n${list}`);
    } catch {
      answer = undefined; // a model failure just leaves these resources unmatched
    }
    const proposed = new Map<string, { to: string; reason: string }>();
    for (const m of Array.isArray(answer?.['matches']) ? (answer!['matches'] as unknown[]) : []) {
      const x = m as { resourceType?: unknown; to?: unknown; reason?: unknown };
      if (typeof x.resourceType === 'string' && typeof x.to === 'string' && wanted.includes(x.resourceType) && allowed.has(x.to)) {
        proposed.set(x.resourceType, { to: x.to, reason: typeof x.reason === 'string' ? x.reason.trim().slice(0, 200) : '' });
      }
    }
    for (const t of wanted) sourceTypeCache.set(`${target}:${t}`, proposed.get(t) ? JSON.stringify(proposed.get(t)) : null);
  }

  const matches: AiMatch[] = [];
  const out = base.map((b, i) => {
    const src = resources[i]!;
    if (b.resourceType !== src.resourceType) return b; // the fixed table handled it
    if (NO_EQUIVALENT.has(src.resourceType)) return b;  // never guessed: see NO_EQUIVALENT
    const cached = sourceTypeCache.get(`${target}:${src.resourceType}`);
    if (!cached) return b;
    const { to, reason } = JSON.parse(cached) as { to: string; reason: string };
    matches.push({ resourceId: src.id, from: src.resourceType, to, reason });
    // Default sizing for the new type: the source's settings use the other cloud's field names and would only mislead.
    return { ...b, provider: target, resourceType: to, configJson: '{}' };
  });
  return { resources: out, matches };
}

/** Test hook. */
export const _clearEquivalentCache = () => sourceTypeCache.clear();
