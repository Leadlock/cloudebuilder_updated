/**
 * GET /api/projects/[id]/readiness/[framework]
 *
 * The readiness view of one framework (soc2 | aws-waf | azure-waf): every control with its score and the reasons, the findings, limitations,
 * sign-offs, the evidence index, the scope, and the versions already issued. Built fresh from the saved architecture and the team's records.
 */
import { NextRequest } from 'next/server';
import { ok, notFound, badRequest, internalError } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { buildProjectReport, loadScope } from '@/lib/compliance/service';
import { readinessRepository } from '@/lib/repositories/readinessRepository';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params, { limitKey: 'readiness' });
    if ('response' in caller) return caller.response;
    const built = await buildProjectReport({ orgId: caller.orgId, projectId: caller.projectId, framework: caller.framework, env: caller.env, preparedBy: caller.email });
    if (!built.ok) return built.reason === 'project_not_found' ? notFound('Project') : badRequest('Save the architecture first: the readiness view is built from the saved architecture.');
    const [versions, scope] = await Promise.all([readinessRepository.reports(caller.projectId, caller.framework), caller.framework === 'soc2' ? loadScope(caller.projectId) : Promise.resolve(null)]);
    const { report } = built;
    return ok({ report, scope, versions: versions.map((v) => ({ version: v.version, reportId: v.reportId, readiness: v.readiness, asOf: v.asOf, generatedBy: v.generatedBy, generatedAt: v.generatedAt })), canAdminister: caller.isAdmin });
  } catch (err) {
    console.error('[GET readiness]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
