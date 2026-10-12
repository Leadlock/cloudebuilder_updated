/**
 * Shared by the report routes (security assessment report, Well-Architected report): authentication, tenant checks,
 * rate limiting, and building the report from an immutable assessment snapshot — either an existing one (`scanId`)
 * or a new one taken from the persisted architecture.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { notFound, forbidden, unauthorized, badRequest, tooManyRequests } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import { buildSnapshot, persistSnapshot, getSnapshot, previousSnapshot, compareSnapshots, loadActiveReviews } from '@/lib/services/AssessmentSnapshotService';
import { buildReport, type AssessmentReport, type AutoFixHistoryEntry } from '@/lib/engines/assessment/report/buildReport';
import { db } from '@/src/prisma/db';
import { loadQuestionnaire } from '@/lib/api/waQuestionnaire';
import { loadAccountEvidence } from '@/lib/api/accountEvidence';

async function autoFixHistory(architectureId: string): Promise<AutoFixHistoryEntry[]> {
  try {
    const rows = await db.orm.public.ArchitectureVersion.where({ architectureId }).select('label', 'summary', 'author', 'createdAt').all();
    return rows
      .filter((r) => r.label.startsWith('Security Auto-Fix'))
      .map((r) => ({ timestamp: r.createdAt, summary: r.summary, author: r.author }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch { return []; }
}

export interface LoadedReport {
  report: AssessmentReport;
  scanId: string;
  projectName: string;
}

/** Returns the report, or the HTTP response to send instead (401/403/404/400/429). */
export async function loadAssessmentReport(
  req: NextRequest,
  projectId: string,
  body: { env: string; scanId?: string },
  rateLimitKey: string,
  opts: { includeQuestionnaire?: boolean } = {},
): Promise<LoadedReport | { response: NextResponse }> {
  const identity = extractIdentity(req);
  if (!identity) return { response: unauthorized() };
  const rl = await checkRateLimit(`${identity.userId}:${rateLimitKey}`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
  if (!rl.allowed) return { response: tooManyRequests(rl.retryAfterSeconds) };

  const orgId = await resolveOrgId(req, identity.userId);
  if (!orgId) return { response: badRequest('orgId required') };
  if (!(await getOrgRole(identity.userId, orgId))) return { response: forbidden() };

  const ctx = await resolveArchitecture(projectId, orgId, body.env);
  if ('error' in ctx) {
    if (ctx.error === 'project_not_found') return { response: notFound('Project') };
    return { response: badRequest('Save the architecture before generating a report — reports are generated from the persisted architecture.') };
  }

  let snapshot;
  if (body.scanId) {
    snapshot = await getSnapshot(projectId, body.scanId);
    if (!snapshot) return { response: notFound('Assessment snapshot') };
  } else {
    snapshot = buildSnapshot({
      project: { id: projectId, name: ctx.project.name, environment: body.env, region: ctx.project.region },
      arch: ctx.arch,
      createdBy: identity.userId,
      reviews: await loadActiveReviews(projectId),
      // The Well-Architected report must say what the Well-Architected tab says, so it includes the answers.
      questionnaire: opts.includeQuestionnaire ? await loadQuestionnaire(projectId) : undefined,
      // Both reports say what the tabs say, so both include the readings of the account's own controls.
      accountEvidence: await loadAccountEvidence(projectId),
    });
    await persistSnapshot(snapshot);
  }

  const prev = await previousSnapshot(projectId, snapshot.architecture.architectureId, snapshot.createdAt, {
    graphHash: snapshot.architecture.graphHash, rulesetVersion: snapshot.assessment.rulesetVersion,
  }).catch(() => null);
  const cmp = prev ? compareSnapshots(prev, snapshot) : undefined;
  const report = buildReport(snapshot, {
    comparison: cmp ? { ...cmp, unchangedCount: cmp.unchangedFindings.length } : undefined,
    autoFixHistory: (await autoFixHistory(snapshot.architecture.architectureId)).filter((h) => h.timestamp <= snapshot.createdAt),
  });
  return { report, scanId: snapshot.scanId, projectName: ctx.project.name };
}
