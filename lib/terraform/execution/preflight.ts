/**
 * Checks, against the real AWS account, for things Terraform cannot see in a plan and AWS only reports halfway through an apply.
 *
 * A plan is built from the files alone, so it passes even when AWS would refuse a resource when asked to create it. Each such refusal so
 * far came after dozens of other resources were already built. These checks are read-only and run before anything is created:
 *
 *  - a database engine version that AWS no longer offers (AWS retires old minor versions, so "postgres 16.4" can stop working).
 *
 * A check that cannot run (no permission to look, network trouble) says nothing and never blocks: it only ever stops a plan on a
 * definite answer from AWS.
 */
import { RDSClient, DescribeDBEngineVersionsCommand } from '@aws-sdk/client-rds';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

export interface PreflightClients { rds: { send(command: unknown): Promise<unknown> } }

/** The deployment region as the generated terraform.tfvars states it. */
export function regionFromTfvars(tfvars: string | undefined): string | null {
  return /aws_region\s*=\s*"([a-z0-9-]+)"/.exec(tfvars ?? '')?.[1] ?? null;
}

export function awsPreflightClients(env: Record<string, string>, region: string): PreflightClients {
  const credentials = { accessKeyId: env['AWS_ACCESS_KEY_ID']!, secretAccessKey: env['AWS_SECRET_ACCESS_KEY']!, sessionToken: env['AWS_SESSION_TOKEN'] };
  return { rds: new RDSClient({ region, credentials }) };
}

const RDS_ENGINES = new Set(['postgres', 'mysql', 'mariadb', 'aurora-postgresql', 'aurora-mysql']);

interface EngineVersionsAnswer { DBEngineVersions?: { EngineVersion?: string }[] }

const majorOf = (version: string) => version.split('.')[0]!;
const sortVersions = (v: string[]) => [...v].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

/** Returns one plain-language problem per definite finding (empty when everything checks out or cannot be checked). */
export async function runAwsPreflight(args: { resources: DbArchitectureResource[]; region: string; clients: PreflightClients }): Promise<string[]> {
  const { resources, region, clients } = args;
  const problems: string[] = [];
  const asked = new Map<string, DbArchitectureResource[]>();

  for (const r of resources) {
    if (r.resourceType !== 'aws_rds') continue;
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(r.configJson) as Record<string, unknown>; } catch { continue; }
    const engine = String(cfg['engine'] ?? '').trim();
    const version = String(cfg['engineVersion'] ?? '').trim();
    if (!RDS_ENGINES.has(engine) || !version) continue;
    const key = `${engine}\u0000${version}`;
    asked.set(key, [...(asked.get(key) ?? []), r]);
  }

  for (const [key, dbs] of asked) {
    const [engine, version] = key.split('\u0000') as [string, string];
    try {
      const exact = (await clients.rds.send(new DescribeDBEngineVersionsCommand({ Engine: engine, EngineVersion: version }))) as EngineVersionsAnswer;
      if ((exact.DBEngineVersions ?? []).length > 0) continue;                       // AWS offers it

      // AWS answered, and it is not offered: say which versions are (same major first).
      const all = (await clients.rds.send(new DescribeDBEngineVersionsCommand({ Engine: engine }))) as EngineVersionsAnswer;
      const names = (all.DBEngineVersions ?? []).map((v) => v.EngineVersion).filter((v): v is string => typeof v === 'string');
      const sameMajor = sortVersions(names.filter((v) => majorOf(v) === majorOf(version)));
      const shown = (sameMajor.length > 0 ? sameMajor : sortVersions(names)).slice(-4);
      const labels = dbs.map((d) => `"${d.label}"`).join(', ');
      problems.push(
        `${dbs.length === 1 ? 'The database' : 'The databases'} ${labels} ask for ${engine} ${version}, which AWS no longer offers in ${region} (AWS retires old minor versions). `
        + `${shown.length > 0 ? `Versions available now include ${shown.join(', ')}. ` : ''}`
        + `Change the Engine Version in the database's properties to one of those, or enter only the major version (${majorOf(version)}) and AWS picks a current one. `
        + 'CloudCraft stops here because AWS would only refuse it after the other resources had already been built.',
      );
    } catch {
      // Could not ask (permission or network): say nothing rather than guess.
    }
  }
  return problems;
}
