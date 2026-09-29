/**
 * AWS <-> Azure region equivalence, by real-world geography (nearest metro).
 *
 * Bug this fixes: Cost Comparison's cross-cloud translation (see
 * CloudCostComparisonService.translateResources) used to leave a resource's
 * `region` field completely untouched when translating its resourceType and
 * config — so an AWS resource in "us-east-1" translated to Azure kept the
 * literal string "us-east-1" as its region. That string isn't a real Azure
 * region, so AzurePricingProvider's region filter matched nothing and the
 * comparison silently fell back to a static estimate (correctly tagged
 * FALLBACK_ESTIMATE — not shown as live), but the UI still displayed a
 * nonexistent "us-east-1" region label on the Azure side, and the two sides
 * of the comparison were not priced in matching geographies.
 *
 * Only pairs the mapping is confident about (same city/metro, or same
 * declared geography in CloudRegionService) are included; anything else
 * falls back to the target provider's default region rather than guessing.
 */
import { cloudRegionService } from './CloudRegionService';

type Provider = 'aws' | 'azure';

const AWS_TO_AZURE_REGION: Record<string, string> = {
  'us-east-1': 'eastus',
  'us-east-2': 'eastus2',
  'us-west-1': 'westus',
  'us-west-2': 'westus2',
  'ca-central-1': 'canadacentral',
  'ca-west-1': 'canadacentral',
  'mx-central-1': 'mexicocentral',
  'eu-west-1': 'northeurope',
  'eu-west-2': 'uksouth',
  'eu-west-3': 'francecentral',
  'eu-central-1': 'germanywestcentral',
  'eu-central-2': 'switzerlandnorth',
  'eu-north-1': 'swedencentral',
  'eu-south-1': 'italynorth',
  'eu-south-2': 'spaincentral',
  'ap-south-1': 'centralindia',
  'ap-south-2': 'southindia',
  'ap-southeast-1': 'southeastasia',
  'ap-southeast-2': 'australiaeast',
  'ap-southeast-3': 'indonesiacentral',
  'ap-southeast-4': 'australiasoutheast',
  'ap-northeast-1': 'japaneast',
  'ap-northeast-2': 'koreacentral',
  'ap-northeast-3': 'japanwest',
  'ap-east-1': 'eastasia',
  'sa-east-1': 'brazilsouth',
  'me-south-1': 'qatarcentral',
  'me-central-1': 'uaenorth',
  'il-central-1': 'israelcentral',
  'af-south-1': 'southafricanorth',
};
const AZURE_TO_AWS_REGION: Record<string, string> = Object.fromEntries(
  Object.entries(AWS_TO_AZURE_REGION).map(([aws, azure]) => [azure, aws]),
);

/**
 * Maps a region id from `fromProvider` to its nearest `toProvider`
 * equivalent. Returns the target provider's default region if there's no
 * confident mapping (e.g. an already-invalid/unrecognized source region) —
 * never returns the source region string unchanged for a different provider.
 */
export function translateRegion(region: string | null | undefined, fromProvider: Provider, toProvider: Provider): string {
  if (fromProvider === toProvider) {
    return region || cloudRegionService.getDefaultRegion(toProvider);
  }
  if (!region) return cloudRegionService.getDefaultRegion(toProvider);

  const cleanRegion = region.toLowerCase().trim();
  const map = fromProvider === 'aws' ? AWS_TO_AZURE_REGION : AZURE_TO_AWS_REGION;
  return map[cleanRegion] ?? cloudRegionService.getDefaultRegion(toProvider);
}
