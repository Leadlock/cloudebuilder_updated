/**
 * POST /api/projects/[id]/security-scans
 * Run a real security scan against the persisted architecture.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, parseBody, tooManyRequests } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { securityAnalyzer } from '@/lib/engines/security/SecurityAnalyzer';
import { db } from '@/src/prisma/db';
import { randomUUID } from 'crypto';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  env:       z.string().optional().default('production'),
  versionId: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const rl = checkRateLimit(`${identity.userId}:security-scans`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const { id: projectId } = await params;

    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const ctx = await resolveArchitecture(projectId, orgId, body.env);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      if (ctx.error === 'architecture_not_found') return ok({ findings: [], score: 100, scanId: null, message: 'No architecture saved yet.' });
      return notFound('Environment');
    }

    const { arch } = ctx;

    // Run the analysis
    const result = securityAnalyzer.analyze({
      architectureId: arch.id,
      projectId,
      versionId: body.versionId,
      resources: arch.resources,
      connections: arch.connections,
    });

    const now = new Date().toISOString();
    const scanId = randomUUID();

    // Persist scan record (graceful offline fallback if DB is unavailable)
    try {
      await db.orm.public.SecurityScan.create({
        id: scanId,
        projectId,
        architectureId: arch.id,
        versionId: body.versionId ?? null,
        status: 'completed',
        score: result.score,
        findingsJson: JSON.stringify(result.findings),
        createdAt: now,
        completedAt: now,
      });

      // Persist individual findings
      for (const finding of result.findings) {
        await db.orm.public.SecurityFinding.create({
          id: finding.id,
          scanId,
          ruleId: finding.ruleId,
          severity: finding.severity,
          title: finding.title,
          description: finding.description,
          resourceId: finding.resourceId ?? null,
          provider: finding.provider ?? null,
          resourceType: finding.resourceType ?? null,
          remediation: finding.remediation,
          metaJson: JSON.stringify(finding.meta ?? {}),
          createdAt: now,
        });
      }
    } catch {
      // Continue gracefully in offline/in-memory mode
    }

    return created({
      scanId,
      architectureId: arch.id,
      score: result.score,
      findingCount: result.findings.length,
      findings: result.findings,
      createdAt: now,
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/security-scans]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
