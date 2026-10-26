/**
 * CloudFront has no flat fee: the bill is data transferred out plus HTTP/S requests. This is the one built-in estimate for it, shared by both
 * static fallbacks (lib/engines/cost/awsPricing.ts and lib/cloud/pricing/AwsPricingProvider.ts), and it follows the same model as the live
 * lookup in AwsPricingProvider so a figure does not change depending on which path answered:
 *   - the traffic is an assumption (1,000 GB out and 10 million HTTPS requests a month unless the resource sets estimatedDataTransferGb /
 *     estimatedRequests), and every line says so;
 *   - AWS's always-free 1 TB and 10 million requests are per account, not per distribution, so they are not applied.
 * Before this there were two flat figures ($12/$16/$22 by price class in one table, a flat $12 in the other) that matched no traffic at all.
 */
import { managedWafApplies, MANAGED_WAF_RULE_GROUPS } from '@/lib/engines/terraform/cloudfrontWaf';

export const CLOUDFRONT_DEFAULT_GB = 1000;
export const CLOUDFRONT_DEFAULT_REQUESTS = 10_000_000;

/** Data out per GB, first 10 TB. US/Canada/Europe (Price Class 100) is the AWS list price; the wider classes add costlier regions and are a blended approximation. */
const EGRESS_PER_GB: Record<string, number> = { PriceClass_100: 0.085, PriceClass_200: 0.1, PriceClass_All: 0.12 };
/** HTTPS requests, US/Europe: $0.01 per 10,000. */
const PER_HTTPS_REQUEST = 0.01 / 10_000;
/** WAF charges $0.60 per million requests it inspects; the web ACL itself is priced as its own resource. */
const WAF_PER_REQUEST = 0.6 / 1_000_000;
const WAF_ACL_MONTHLY = 5;
const WAF_RULE_MONTHLY = 1;

export interface CloudFrontEstimate {
  monthlyUsd: number;
  ratePerGb: number;
  dataGb: number;
  requests: number;
  priceClass: string;
  breakdown: { label: string; monthlyUsd: number }[];
  assumptions: string[];
}

function count(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function estimateCloudFront(config: Record<string, unknown>): CloudFrontEstimate {
  const priceClass = (config['priceClass'] as string) || 'PriceClass_100';
  const ratePerGb = EGRESS_PER_GB[priceClass] ?? EGRESS_PER_GB['PriceClass_100']!;
  const dataGb = count(config['estimatedDataTransferGb'], CLOUDFRONT_DEFAULT_GB);
  const requests = count(config['estimatedRequests'] ?? config['estimatedRequestsPerMonth'], CLOUDFRONT_DEFAULT_REQUESTS);

  const egress = dataGb * ratePerGb;
  const requestCost = requests * PER_HTTPS_REQUEST;
  const waf = config['webAclId'] ? requests * WAF_PER_REQUEST : 0;
  // The managed web ACL the generated Terraform adds: $5 for the ACL, $1 for each of its two rule groups, and the requests it inspects.
  const managed = managedWafApplies(config) ? WAF_ACL_MONTHLY + MANAGED_WAF_RULE_GROUPS.length * WAF_RULE_MONTHLY + requests * WAF_PER_REQUEST : 0;

  return {
    monthlyUsd: egress + requestCost + waf + managed,
    ratePerGb,
    dataGb,
    requests,
    priceClass,
    breakdown: [
      { label: `Data transfer out (${dataGb.toLocaleString('en-US')} GB at $${ratePerGb}/GB, ${priceClass})`, monthlyUsd: egress },
      { label: `HTTPS requests (${requests.toLocaleString('en-US')})`, monthlyUsd: requestCost },
      ...(waf > 0 ? [{ label: 'Associated WAF request processing', monthlyUsd: waf }] : []),
      ...(managed > 0 ? [{ label: `Managed AWS WAF (web ACL, ${MANAGED_WAF_RULE_GROUPS.length} rule groups, requests inspected)`, monthlyUsd: managed }] : []),
    ],
    assumptions: [
      `Assumed traffic: ${dataGb.toLocaleString('en-US')} GB out and ${requests.toLocaleString('en-US')} HTTPS requests a month (set estimatedDataTransferGb and estimatedRequests to change it)`,
      'The first-10-TB rate is applied to all traffic; larger volumes are cheaper per GB',
      'The always-free 1 TB and 10 million requests a month are per AWS account and are not applied',
      ...(priceClass === 'PriceClass_100' ? [] : [`${priceClass} adds edge locations in Asia, Africa and Oceania; its rate is a blended approximation`]),
      'The associated WAF web ACL is priced as its own resource',
    ],
  };
}
