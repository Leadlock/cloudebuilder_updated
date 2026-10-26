/**
 * A third-party service (Datadog, MongoDB Atlas ...) has no price list CloudBuilder can read: what it costs is what the team enters on the node
 * ("Monthly cost (USD)"). That figure is used as it is, labelled as entered by the team and never as a list price, so the estimate counts the
 * service without pretending to know its price. Nothing entered means 0, with a line that says so.
 */
import type { NormalizedPrice } from './types';
import type { CostLineItem } from '@/lib/engines/cost/types';

export const isExternalServiceResource = (resourceType: string): boolean => resourceType.endsWith('_external_service');

export function enteredMonthlyCost(config: Record<string, unknown>): number {
  const n = Number(config['monthlyCostUsd']);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000_000) : 0;
}

const assumptions = (cost: number) => [cost > 0 ? 'The monthly cost was entered by the team: CloudBuilder cannot price a third-party service.' : 'No monthly cost has been entered for this service, so it counts as $0. Enter what it costs on the service\'s settings.'];

/** The normalized price the live pricing path expects. */
export function externalServiceNormalizedPrice(provider: 'aws' | 'azure', region: string, config: Record<string, unknown>): NormalizedPrice {
  const monthly = enteredMonthlyCost(config);
  const now = new Date().toISOString();
  return {
    provider, service: 'Third-party service', resourceType: `${provider}_external_service`, region, sku: 'entered-by-team', pricingModel: 'on-demand', unit: '1 Month',
    unitPrice: monthly / 730, monthlyPrice: monthly, currency: 'USD', description: 'Monthly cost entered by the team', source: 'entered-by-team', retrievedAt: now, expiresAt: now,
    assumptions: assumptions(monthly),
  };
}

/** The line item the built-in tables give. */
export function externalServiceLineItem(resource: { id: string; label: string; resourceType: string }, provider: 'aws' | 'azure', region: string, config: Record<string, unknown>): CostLineItem {
  const monthly = enteredMonthlyCost(config);
  return {
    resourceId: resource.id, resourceLabel: resource.label, resourceType: resource.resourceType, provider, region,
    hourlyUsd: monthly / 730, monthlyUsd: monthly,
    breakdown: [{ label: 'Entered by the team', monthlyUsd: monthly }],
    assumptions: assumptions(monthly), pricingSource: 'entered-by-team', confidence: 'estimate',
  };
}
