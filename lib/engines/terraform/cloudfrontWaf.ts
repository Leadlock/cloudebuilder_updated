/**
 * The AWS WAF web ACL CloudBuilder puts in front of a public CloudFront distribution by default (Security Hub CloudFront.6).
 *
 * A web ACL for CloudFront must be created in us-east-1 whichever region the rest of the design is in, so the generated Terraform gets a second
 * AWS provider (alias us_east_1) for it. It carries two AWS managed rule groups (the core rule set and known bad inputs) and costs about $7 a month
 * plus $0.60 per million requests; the cost estimate includes it. It is turned off with the distribution's "managedWaf" setting, and is not added
 * when the distribution already has a web ACL id, when a WAF with CLOUDFRONT scope is connected to it, or when it was imported from a live account.
 */
export const MANAGED_WAF_RULE_GROUPS = ['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet'] as const;
export const WAF_PROVIDER_ALIAS = 'us_east_1';

/** True when the generated files add a managed web ACL for this CloudFront distribution's settings. */
export function managedWafApplies(cfg: Record<string, unknown>): boolean {
  if (cfg['managedWaf'] === false) return false;
  if (typeof cfg['webAclId'] === 'string' && cfg['webAclId'].trim() !== '') return false;
  if (cfg['imported'] === true || cfg['importState'] === 'imported') return false;
  return true;
}
