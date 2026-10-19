/**
 * Reads four AWS account-level controls, read-only: CloudTrail, GuardDuty, root MFA and AWS Config.
 *
 * These are settings of the account and its Regions, not of anything in the architecture diagram, so the assessment could only ever
 * report them as NOT EVALUATED. With a connected AWS account CloudBuilder can read them. Only Describe/List/Get calls are made.
 *
 *  - Each control is read on its own: a failure in one never hides the others.
 *  - A refused or failed read is UNAVAILABLE with the reason (and the permission to add), never a pass and never a fail.
 *  - A clear negative result is a FAIL even when another Region could not be read: a known gap stays a gap.
 *  - Results are plain sentences. Raw API output, account IDs and error messages are not kept.
 *
 * The clients are passed in (anything with `send`), so this is tested without AWS and the adapter owns the credentials.
 */
import { DescribeTrailsCommand, GetTrailStatusCommand } from '@aws-sdk/client-cloudtrail';
import { ListDetectorsCommand, GetDetectorCommand } from '@aws-sdk/client-guardduty';
import { GetAccountSummaryCommand } from '@aws-sdk/client-iam';
import { DescribeConfigurationRecordersCommand, DescribeConfigurationRecorderStatusCommand } from '@aws-sdk/client-config-service';
import type { AccountControlId, AccountEvidenceStatus } from '@/lib/engines/assessment/accountEvidence';

export interface Sender { send(command: unknown): Promise<unknown> }

export interface AccountControlClients {
  cloudtrail: Sender;
  iam: Sender;
  guardduty: (region: string) => Sender;
  config: (region: string) => Sender;
}

export interface AccountControlResult {
  controlId: AccountControlId;
  status: AccountEvidenceStatus;
  observation: string;
}

/** The read permissions each control needs, shown when AWS refuses. These are optional: discovery works without them. */
export const ACCOUNT_CONTROL_PERMISSIONS: Record<AccountControlId, string[]> = {
  'AWS-ACCT-001': ['cloudtrail:DescribeTrails', 'cloudtrail:GetTrailStatus'],
  'AWS-ACCT-002': ['guardduty:ListDetectors', 'guardduty:GetDetector'],
  'AWS-ACCT-003': ['iam:GetAccountSummary'],
  'AWS-ACCT-004': ['config:DescribeConfigurationRecorders', 'config:DescribeConfigurationRecorderStatus'],
};

const DENIED = new Set(['AccessDeniedException', 'AccessDenied', 'UnauthorizedOperation', 'UnauthorizedException', 'AuthorizationError', 'AuthFailure']);

export function isAccessDenied(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return Boolean(e && ((e.name && DENIED.has(e.name)) || e.$metadata?.httpStatusCode === 403));
}

function unavailable(id: AccountControlId, err: unknown, where = ''): AccountControlResult {
  const at = where ? ` in ${where}` : '';
  if (isAccessDenied(err)) {
    return { controlId: id, status: 'UNAVAILABLE', observation: `The connected role is not allowed to read this${at}. Add ${ACCOUNT_CONTROL_PERMISSIONS[id].join(' and ')} to its read-only policy.` };
  }
  const name = (err as { name?: string } | null)?.name;
  return { controlId: id, status: 'UNAVAILABLE', observation: `This could not be read${at}${name ? ` (${name})` : ''}. Try again later.` };
}

type Shape = Record<string, unknown>;
const asList = (v: unknown): Shape[] => (Array.isArray(v) ? (v as Shape[]) : []);

/** Combine per-Region outcomes: any clear failure fails; otherwise any unreadable Region makes it unavailable; otherwise it passes. */
function combine(id: AccountControlId, label: string, per: Array<{ region: string; status: AccountEvidenceStatus; note: string }>): AccountControlResult {
  const by = (s: AccountEvidenceStatus) => per.filter((p) => p.status === s);
  const list = (items: typeof per) => items.map((p) => p.region).join(', ');
  const fails = by('FAIL'); const warns = by('WARNING'); const gone = by('UNAVAILABLE'); const ok = by('PASS');
  if (fails.length > 0) {
    const parts = [`${label} is not in place in ${list(fails)}: ${fails[0]!.note}`];
    if (ok.length > 0) parts.push(`it is in place in ${list(ok)}`);
    if (gone.length > 0) parts.push(`${list(gone)} could not be read`);
    return { controlId: id, status: 'FAIL', observation: `${parts.join('; ')}.` };
  }
  if (gone.length > 0 && ok.length + warns.length === 0) return { controlId: id, status: 'UNAVAILABLE', observation: gone[0]!.note };
  if (warns.length > 0) return { controlId: id, status: 'WARNING', observation: `${label} is in place but incomplete in ${list(warns)}: ${warns[0]!.note}${gone.length ? `; ${list(gone)} could not be read` : ''}.` };
  if (gone.length > 0) return { controlId: id, status: 'UNAVAILABLE', observation: `${label} is in place in ${list(ok)}, but ${list(gone)} could not be read: ${gone[0]!.note}` };
  return { controlId: id, status: 'PASS', observation: `${label} is in place in ${list(ok)}.` };
}

// ─── CloudTrail ──────────────────────────────────────────────────────────────

async function readCloudTrail(client: Sender, region: string): Promise<AccountControlResult> {
  const id: AccountControlId = 'AWS-ACCT-001';
  try {
    const out = (await client.send(new DescribeTrailsCommand({ includeShadowTrails: true }))) as Shape;
    const multi = asList(out['trailList']).filter((t) => t['IsMultiRegionTrail'] === true);
    if (multi.length === 0) return { controlId: id, status: 'FAIL', observation: 'No multi-Region CloudTrail trail was found, so API activity in most Regions is not recorded.' };

    let logging: Shape | null = null;
    let readable = 0;
    for (const trail of multi) {
      try {
        const st = (await client.send(new GetTrailStatusCommand({ Name: String(trail['TrailARN'] ?? trail['Name']) }))) as Shape;
        readable++;
        if (st['IsLogging'] === true) { logging = trail; break; }
      } catch { /* try the next trail */ }
    }
    if (!logging) {
      return readable === 0
        ? unavailable(id, { name: 'Unreadable' }, region)
        : { controlId: id, status: 'FAIL', observation: 'A multi-Region CloudTrail trail exists but it is not logging.' };
    }
    return logging['LogFileValidationEnabled'] === true
      ? { controlId: id, status: 'PASS', observation: 'A multi-Region CloudTrail trail is logging, with log file validation on.' }
      : { controlId: id, status: 'WARNING', observation: 'A multi-Region CloudTrail trail is logging, but log file validation is off, so tampering with the logs would not be detected.' };
  } catch (err) {
    return unavailable(id, err, region);
  }
}

// ─── GuardDuty (per Region) ──────────────────────────────────────────────────

async function readGuardDuty(client: (r: string) => Sender, regions: string[]): Promise<AccountControlResult> {
  const id: AccountControlId = 'AWS-ACCT-002';
  const per = await Promise.all(regions.map(async (region) => {
    try {
      const c = client(region);
      const ids = ((await c.send(new ListDetectorsCommand({}))) as Shape)['DetectorIds'];
      const detectors = Array.isArray(ids) ? (ids as string[]) : [];
      if (detectors.length === 0) return { region, status: 'FAIL' as const, note: 'no detector exists' };
      const d = (await c.send(new GetDetectorCommand({ DetectorId: detectors[0]! }))) as Shape;
      return d['Status'] === 'ENABLED' ? { region, status: 'PASS' as const, note: '' } : { region, status: 'FAIL' as const, note: 'the detector is suspended' };
    } catch (err) {
      return { region, status: 'UNAVAILABLE' as const, note: unavailable(id, err).observation };
    }
  }));
  return combine(id, 'GuardDuty threat detection', per);
}

// ─── Root user MFA ───────────────────────────────────────────────────────────

async function readRootMfa(client: Sender): Promise<AccountControlResult> {
  const id: AccountControlId = 'AWS-ACCT-003';
  try {
    const summary = ((await client.send(new GetAccountSummaryCommand({}))) as Shape)['SummaryMap'] as Record<string, number> | undefined;
    if (!summary || summary['AccountMFAEnabled'] === undefined) return unavailable(id, { name: 'UnexpectedResponse' });
    return summary['AccountMFAEnabled'] === 1
      ? { controlId: id, status: 'PASS', observation: 'Multi-factor authentication is enabled on the root user.' }
      : { controlId: id, status: 'FAIL', observation: 'Multi-factor authentication is not enabled on the root user. (If your organization manages root access centrally and the root user has no credentials, this reading can be misleading; check it in IAM.)' };
  } catch (err) {
    return unavailable(id, err);
  }
}

// ─── AWS Config (per Region) ─────────────────────────────────────────────────

async function readConfig(client: (r: string) => Sender, regions: string[]): Promise<AccountControlResult> {
  const id: AccountControlId = 'AWS-ACCT-004';
  const per = await Promise.all(regions.map(async (region) => {
    try {
      const c = client(region);
      const recorders = asList(((await c.send(new DescribeConfigurationRecordersCommand({}))) as Shape)['ConfigurationRecorders']);
      if (recorders.length === 0) return { region, status: 'FAIL' as const, note: 'no configuration recorder exists' };
      const statuses = asList(((await c.send(new DescribeConfigurationRecorderStatusCommand({}))) as Shape)['ConfigurationRecordersStatus']);
      if (!statuses.some((s) => s['recording'] === true)) return { region, status: 'FAIL' as const, note: 'the recorder is not recording' };
      const all = recorders.some((r) => (r['recordingGroup'] as Shape | undefined)?.['allSupported'] === true);
      return all ? { region, status: 'PASS' as const, note: '' } : { region, status: 'WARNING' as const, note: 'it does not record all supported resource types' };
    } catch (err) {
      return { region, status: 'UNAVAILABLE' as const, note: unavailable(id, err).observation };
    }
  }));
  return combine(id, 'AWS Config recording', per);
}

/**
 * Read all four controls. `regions` are the Regions the workload uses (GuardDuty and Config are per Region); the first is also where
 * the CloudTrail and IAM reads are made.
 */
export async function readAwsAccountControls(clients: AccountControlClients, regions: string[]): Promise<AccountControlResult[]> {
  const unique = Array.from(new Set(regions.filter(Boolean)));
  const used = unique.length > 0 ? unique : ['us-east-1'];
  return Promise.all([
    readCloudTrail(clients.cloudtrail, used[0]!),
    readGuardDuty(clients.guardduty, used),
    readRootMfa(clients.iam),
    readConfig(clients.config, used),
  ]);
}
