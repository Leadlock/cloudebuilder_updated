/** PUT / DELETE /api/projects/[id]/readiness/soc2/entries/[entryId]: change or remove one record. Only records of this project can be reached. */
import { NextRequest } from 'next/server';
import { ok, notFound, badRequest, internalError } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { checkEntryInput } from '@/lib/compliance/entryInput';
import { readinessRepository } from '@/lib/repositories/readinessRepository';
import type { EntryKind } from '@/lib/compliance/entries';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; framework: string; entryId: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const p = await params;
    const caller = await guardReadiness(req, p);
    if ('response' in caller) return caller.response;
    const row = await readinessRepository.entryById(caller.projectId, p.entryId);
    if (!row || row.framework !== caller.framework) return notFound('Record');
    let body: { data?: unknown };
    try { body = JSON.parse(await req.text()); } catch { return badRequest('Invalid JSON body'); }
    // The kind and the key of a record never change by editing it.
    const checked = checkEntryInput(caller.framework, { kind: row.kind, key: row.key ?? undefined, data: body.data ?? {} });
    if (!checked.ok) return badRequest(checked.message);
    await readinessRepository.updateEntry(caller.projectId, p.entryId, checked.data, caller.email);
    await readinessRepository.clearSignoffs(caller.projectId, caller.framework);
    return ok({ saved: true, kind: row.kind as EntryKind, signoffsCleared: true });
  } catch (err) {
    console.error('[PUT readiness entry]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const p = await params;
    const caller = await guardReadiness(req, p);
    if ('response' in caller) return caller.response;
    const row = await readinessRepository.entryById(caller.projectId, p.entryId);
    if (!row || row.framework !== caller.framework) return notFound('Record');
    await readinessRepository.deleteEntry(caller.projectId, p.entryId);
    await readinessRepository.clearSignoffs(caller.projectId, caller.framework);
    return ok({ removed: true, signoffsCleared: true });
  } catch (err) {
    console.error('[DELETE readiness entry]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
