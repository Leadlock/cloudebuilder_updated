/**
 * POST /api/projects/[id]/readiness/[framework]/signoff   { role: preparer | reviewer | management }
 *
 * Signs the report as it stands now (the signature records the report's id, which changes with its content). The reviewer cannot be the preparer;
 * reviewer and management are owners or admins of the organization; management signs last. Any later change to a control, finding or the scope
 * clears the sign-offs.
 */
import { NextRequest } from 'next/server';
import { ok, badRequest, internalError, parseBody } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { checkSignoff, SignoffSchema } from '@/lib/compliance/rules';
import { buildProjectReport } from '@/lib/compliance/service';
import { readinessRepository } from '@/lib/repositories/readinessRepository';
import { orgRepository } from '@/lib/repositories/orgRepository';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params, { limitKey: 'readiness-signoff' });
    if ('response' in caller) return caller.response;
    const parsed = await parseBody(req, SignoffSchema);
    if (!parsed.ok) return parsed.response;
    const existing = await readinessRepository.signoffs(caller.projectId, caller.framework);
    const check = checkSignoff(parsed.data.role, existing, { email: caller.email, isAdmin: caller.isAdmin });
    if (!check.ok) return badRequest(check.message);
    const built = await buildProjectReport({ orgId: caller.orgId, projectId: caller.projectId, framework: caller.framework, env: caller.env, preparedBy: caller.email });
    if (!built.ok) return badRequest('Save the architecture first.');
    const user = await orgRepository.findUser(caller.userId).catch(() => null);
    const signed = await readinessRepository.sign(caller.projectId, caller.framework, { role: parsed.data.role, name: user?.name || caller.email, email: caller.email, reportHash: built.report.reportId });
    return ok({ signoff: signed });
  } catch (err) {
    console.error('[POST readiness signoff]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
