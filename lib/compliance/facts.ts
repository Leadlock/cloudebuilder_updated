/**
 * Facts about the organization's own use of CloudBuilder, read from the platform's records (not typed in by anyone):
 * how many members have a second sign-in factor, how many infrastructure changes were approved, whether an audit trail is being written.
 * Each read is independent: if one fails the fact is left out (the control is then scored without it), never guessed.
 */
import { db } from '@/src/prisma/db';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { discoveryRepository } from '@/lib/repositories/discoveryRepository';
import { restrictedFeaturesClosed } from '@/lib/auth/restrictedFeatures';
import type { PlatformFacts } from './signals';

const DAY = 86_400_000;

async function attempt<T>(label: string, run: () => Promise<T>): Promise<T | undefined> {
  try { return await run(); } catch (err) { console.warn(`[compliance facts] ${label} unavailable:`, err instanceof Error ? err.message : err); return undefined; }
}

export async function gatherPlatformFacts(orgId: string, projectId: string, asOf = new Date()): Promise<PlatformFacts | undefined> {
  const since = new Date(asOf.getTime() - 90 * DAY).toISOString();
  const members = await attempt('members', async () => (await db.orm.public.OrgMember.where({ orgId }).select('userId').all()) as Array<{ userId: string }>);
  if (!members) return undefined;

  const enrolled = await attempt('second factor', async () => {
    let n = 0;
    for (const m of members) {
      const t = await db.orm.public.UserTotp.where({ userId: m.userId }).select('enabled').first() as { enabled: boolean } | null;
      if (t?.enabled) n++;
    }
    return n;
  });
  const approvals = await attempt('approvals', async () => {
    const rows = await db.orm.public.TerraformApproval.where({ orgId }).select('createdAt', 'status').all() as Array<{ createdAt: string; status: string }>;
    return rows.filter((r) => r.createdAt >= since && (r.status === 'approved' || r.status === 'used')).length;
  });
  const audit = await attempt('audit trail', async () => {
    const rows = await db.orm.public.TerraformAuditEvent.where({ orgId }).select('createdAt').all() as Array<{ createdAt: string }>;
    return rows.filter((r) => r.createdAt >= since).length;
  });
  const lastAssessmentAt = await attempt('assessments', async () => {
    const rows = await db.orm.public.SecurityScan.where({ projectId }).select('createdAt').all() as Array<{ createdAt: string }>;
    return rows.map((r) => r.createdAt).sort().pop();
  });
  const lastDiscoveryAt = await attempt('discovery', async () => {
    const times: string[] = [];
    for (const a of await cloudAccountRepository.list(orgId)) {
      const run = await discoveryRepository.findLatest(a.id);
      if (run?.completedAt) times.push(run.completedAt);
    }
    return times.sort().pop();
  });

  return {
    // If the second-factor records could not be read, members is 0 so the check gives no signal at all (neither pass nor fail).
    members: enrolled === undefined ? 0 : members.length,
    mfaEnrolled: enrolled ?? 0,
    approvalsLast90d: approvals ?? 0,
    auditEventsLast90d: audit ?? 0,
    deployRestricted: restrictedFeaturesClosed(),
    ...(lastAssessmentAt ? { lastAssessmentAt } : {}),
    ...(lastDiscoveryAt ? { lastDiscoveryAt } : {}),
  };
}
