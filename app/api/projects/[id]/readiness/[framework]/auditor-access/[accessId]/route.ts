/** DELETE /api/projects/[id]/readiness/[framework]/auditor-access/[accessId]: revoke an auditor's access at once (owner or admin). */
import { NextRequest } from 'next/server';
import { ok, notFound, internalError } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { readinessRepository } from '@/lib/repositories/readinessRepository';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string; accessId: string }> }) {
  try {
    const p = await params;
    const caller = await guardReadiness(req, p, { adminOnly: true });
    if ('response' in caller) return caller.response;
    // The row is looked up within this project, so another project's access cannot be revoked (or confirmed to exist) from here.
    const existing = (await readinessRepository.auditorAccesses(caller.projectId, caller.framework)).find((a) => a.id === p.accessId);
    if (!existing) return notFound('Auditor access');
    await readinessRepository.revokeAuditorAccess(caller.projectId, p.accessId);
    return ok({ revoked: true });
  } catch (err) {
    console.error('[DELETE readiness auditor-access]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
