/**
 * Plain-code sanity limits for a single resource's monthly cost. No AI involved.
 *
 * These bounds are deliberately wide: they are not a price, they only catch the kind of mistake where a figure is orders of magnitude off
 * (a small SQL database priced at $105,980/month came from reading a per-day meter as per-hour). A line outside its range is flagged to the
 * user as suspicious, and an AI-matched price outside it is thrown away in favour of the built-in table.
 */
const MAX_MONTHLY_USD: Record<string, number> = {
  // AWS
  aws_ec2: 20_000, aws_rds: 60_000, aws_s3: 60_000, aws_alb: 1_000, aws_nat: 1_000, aws_lambda: 8_000, aws_cloudfront: 30_000,
  aws_dynamodb: 60_000, aws_elasticache: 30_000, aws_eks: 120_000, aws_ecs: 30_000, aws_ebs: 30_000, aws_sqs: 3_000, aws_route53: 1_000,
  aws_cloudwatch: 5_000, aws_waf: 2_000, aws_kms: 500,
  // Azure
  azure_vm: 20_000, azure_vmss: 120_000, azure_sql: 30_000, azure_storage: 60_000, azure_lb: 800, azure_app_gateway: 4_000, azure_nat: 1_000,
  azure_public_ip: 100, azure_redis: 30_000, azure_cosmos_db: 60_000, azure_functions: 8_000, azure_aks: 120_000, azure_key_vault: 500,
  azure_bastion: 2_000, azure_front_door: 5_000, azure_waf: 2_000, azure_app_service: 10_000,
};
const DEFAULT_MAX_MONTHLY_USD = 100_000;

export const maxPlausibleMonthlyUsd = (resourceType: string): number => MAX_MONTHLY_USD[resourceType] ?? DEFAULT_MAX_MONTHLY_USD;

export interface CostAnomaly { resourceId: string; label: string; resourceType: string; monthlyUsd: number; reason: string }

interface LineLike { resourceId: string; resourceLabel: string; resourceType: string; monthlyUsd: number; confidence?: string }

/** Lines whose monthly cost is negative, not a number, or above the type's plausible maximum. Unpriced lines are not anomalies. */
export function findCostAnomalies(items: LineLike[]): CostAnomaly[] {
  const out: CostAnomaly[] = [];
  for (const i of items) {
    if (i.confidence === 'unsupported') continue;
    const max = maxPlausibleMonthlyUsd(i.resourceType);
    if (!Number.isFinite(i.monthlyUsd) || i.monthlyUsd < 0) {
      out.push({ resourceId: i.resourceId, label: i.resourceLabel, resourceType: i.resourceType, monthlyUsd: 0, reason: 'The price is not a valid number.' });
    } else if (i.monthlyUsd > max) {
      out.push({
        resourceId: i.resourceId, label: i.resourceLabel, resourceType: i.resourceType, monthlyUsd: i.monthlyUsd,
        reason: `This is far above what a single ${i.resourceType.replace(/^(aws|azure)_/, '').replace(/_/g, ' ')} normally costs (over $${max.toLocaleString('en-US')}/month), so the price is probably wrong. Check the sizing, and treat the total with caution.`,
      });
    }
  }
  return out;
}
