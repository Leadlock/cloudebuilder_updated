/**
 * POST /api/projects/[id]/readiness/soc2/entries   { kind, key?, data }
 *
 * Records something the team knows and CloudBuilder cannot: a significant change, a prior-period finding, a walkthrough, a complementary control's status, a provider
 * review, a limitation's owner, a remediation plan. A record kept once per subject (a control, a provider) is replaced when saved again; the others are added.
 * What is recorded is the team's own statement: it appears in the report as recorded, never as verified, and it never changes a score. Any save clears the sign-offs.
 */
import { NextRequest } from 'next/server';
import { created, notFound, badRequest, internalError } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { checkEntryInput } from '@/lib/compliance/entryInput';
import { readinessRepository } from '@/lib/repositories/readinessRepository';

export const dynamic = 'force-dynamic';
const MAX_ENTRIES = 600;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params, { limitKey: 'readiness-entry' });
    if ('response' in caller) return caller.response;
    if (caller.framework !== 'soc2') return notFound('Records for this framework');
    let body: unknown;
    try { body = JSON.parse(await req.text()); } catch { return badRequest('Invalid JSON body'); }
    const checked = checkEntryInput(caller.framework, body);
    if (!checked.ok) return badRequest(checked.message);
    const existing = await readinessRepository.entries(caller.projectId, caller.framework);
    const isReplacement = checked.key !== null && existing.some((e) => e.kind === checked.kind && e.key === checked.key);
    if (!isReplacement && existing.length >= MAX_ENTRIES) return badRequest(`This project already has ${MAX_ENTRIES} records. Remove some before adding more.`);
    const id = await readinessRepository.saveEntry(caller.projectId, caller.framework, checked.kind, checked.key, checked.data, caller.email);
    await readinessRepository.clearSignoffs(caller.projectId, caller.framework);
    return created({ id, kind: checked.kind, key: checked.key, replaced: isReplacement, signoffsCleared: true });
  } catch (err) {
    console.error('[POST readiness entry]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
