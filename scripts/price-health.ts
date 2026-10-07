/**
 * Price health check: prices a fixed set of reference resources from the official price lists and compares each with the amount saved in
 * scripts/price-health.baseline.json. Run it on a schedule (nightly is enough) to learn about a price change, a changed price-list format or a
 * broken lookup before a person sees a wrong number.
 *
 *   npm run price:health            compare, print any line that drifted or could not be priced, exit 1 if there is one
 *   npm run price:health -- --update   accept today's prices as the new baseline (after checking a change is a real price change)
 *
 * Azure's price list is public, so those lines always run. AWS lines run only when AWS_PRICING_ACCESS_KEY_ID and AWS_PRICING_SECRET_ACCESS_KEY
 * are set, because AWS requires a signed request. Only deterministic lookups are used (no AI), so a result can only change when a price does.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { AzurePricingProvider } from '@/lib/cloud/pricing/AzurePricingProvider';
import { AwsPricingProvider } from '@/lib/cloud/pricing/AwsPricingProvider';
import type { ICloudPricingProvider, PriceQuery } from '@/lib/cloud/pricing/types';

/** A drift above this share of the saved amount is reported. List prices change rarely, and by more than this when they do. */
const TOLERANCE = 0.05;

interface Reference { name: string; query: PriceQuery }

const AZURE: Reference[] = [
  { name: 'azure_vm Standard_D2s_v3', query: { provider: 'azure', resourceType: 'azure_vm', region: 'eastus', configuration: { size: 'Standard_D2s_v3' } } },
  { name: 'azure_sql GP_Gen5_2 zone redundant 200GB', query: { provider: 'azure', resourceType: 'azure_sql', region: 'eastus', configuration: { tier: 'GP_Gen5_2', maxSizeGb: 200, zoneRedundant: true } } },
  { name: 'azure_sql S1 DTU', query: { provider: 'azure', resourceType: 'azure_sql', region: 'eastus', configuration: { tier: 'S1', maxSizeGb: 250 } } },
  { name: 'azure_app_gateway', query: { provider: 'azure', resourceType: 'azure_app_gateway', region: 'eastus', configuration: {} } },
  { name: 'azure_front_door Standard base fee', query: { provider: 'azure', resourceType: 'azure_front_door', region: 'eastus', configuration: { sku: 'Standard_AzureFrontDoor' } } },
  { name: 'azure_cosmos_db serverless 100M RUs 10GB', query: { provider: 'azure', resourceType: 'azure_cosmos_db', region: 'eastus', configuration: { throughputMode: 'Serverless' } } },
  { name: 'azure_cosmos_db autoscale 4000 RU/s 10GB', query: { provider: 'azure', resourceType: 'azure_cosmos_db', region: 'eastus', configuration: { throughputMode: 'Provisioned', maxThroughputRu: 4000 } } },
  { name: 'azure_storage Standard_LRS 100GB', query: { provider: 'azure', resourceType: 'azure_storage', region: 'eastus', configuration: { sku: 'Standard_LRS', estimatedCapacityGb: 100 } } },
];

const AWS: Reference[] = [
  { name: 'aws_ec2 t3.medium', query: { provider: 'aws', resourceType: 'aws_ec2', region: 'us-east-1', configuration: { instanceType: 't3.medium' } } },
  { name: 'aws_rds db.m5.large postgres multi-AZ 200GB', query: { provider: 'aws', resourceType: 'aws_rds', region: 'us-east-1', configuration: { instanceClass: 'db.m5.large', engine: 'postgres', multiAz: true, allocatedStorage: 200 } } },
  { name: 'aws_alb', query: { provider: 'aws', resourceType: 'aws_alb', region: 'us-east-1', configuration: {} } },
  { name: 'aws_nat', query: { provider: 'aws', resourceType: 'aws_nat', region: 'us-east-1', configuration: {} } },
];

const baselineFile = path.join(process.cwd(), 'scripts', 'price-health.baseline.json');

async function priceAll(provider: ICloudPricingProvider, refs: Reference[], liveSources: string[]): Promise<Record<string, { monthly: number | null; source: string | null }>> {
  const out: Record<string, { monthly: number | null; source: string | null }> = {};
  for (const ref of refs) {
    const p = await provider.getPrice(ref.query).catch(() => null);
    // A price from the built-in table says nothing about the official list, so it counts as "could not be priced".
    out[ref.name] = p && liveSources.includes(p.source) ? { monthly: Math.round(p.monthlyPrice * 100) / 100, source: p.source } : { monthly: null, source: p?.source ?? null };
  }
  return out;
}

async function main(): Promise<void> {
  const update = process.argv.includes('--update');
  const today: Record<string, { monthly: number | null; source: string | null }> = await priceAll(new AzurePricingProvider({ aiMeterMatching: false }), AZURE, ['azure-retail-api']);
  const haveAws = Boolean(process.env['AWS_PRICING_ACCESS_KEY_ID'] && process.env['AWS_PRICING_SECRET_ACCESS_KEY']);
  if (haveAws) Object.assign(today, await priceAll(new AwsPricingProvider(), AWS, ['aws-price-list-api']));
  else console.log('AWS lines skipped: AWS_PRICING_ACCESS_KEY_ID and AWS_PRICING_SECRET_ACCESS_KEY are not set.');

  const baseline: Record<string, number> = existsSync(baselineFile) ? (JSON.parse(readFileSync(baselineFile, 'utf8')) as Record<string, number>) : {};

  if (update) {
    const next = { ...baseline };
    for (const [name, v] of Object.entries(today)) if (v.monthly !== null) next[name] = v.monthly;
    writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.log(`Baseline saved for ${Object.keys(next).length} lines.`);
    return;
  }

  const problems: string[] = [];
  for (const [name, v] of Object.entries(today)) {
    const saved = baseline[name];
    if (v.monthly === null) problems.push(`${name}: could not be priced from the official list (source: ${v.source ?? 'none'})`);
    else if (saved === undefined) problems.push(`${name}: no saved baseline (run with --update once the amount ${v.monthly} is checked)`);
    else if (Math.abs(v.monthly - saved) > saved * TOLERANCE) problems.push(`${name}: was ${saved}, now ${v.monthly} (${(((v.monthly - saved) / saved) * 100).toFixed(1)}%)`);
    else console.log(`ok   ${name}: ${v.monthly}`);
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} price problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nAll reference prices match the baseline.');
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
