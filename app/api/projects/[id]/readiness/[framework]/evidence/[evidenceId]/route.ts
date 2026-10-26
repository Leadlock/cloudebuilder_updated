/**
 * /api/projects/[id]/readiness/[framework]/evidence/[evidenceId]
 *
 * GET    — download the stored file (always as an attachment, never rendered in the browser).
 * PUT    — change which controls the evidence supports.
 * DELETE — remove it from the reports. The record stays (marked removed, with who and when) so an earlier report can still be traced; the file is dropped.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ok, notFound, badRequest, forbidden, internalError, parseBody } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { readinessRepository } from '@/lib/repositories/readinessRepository';
import { checkControlKeys } from '@/lib/compliance/evidenceInput';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; framework: string; evidenceId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const p = await params;
    const caller = await guardReadiness(req, p);
    if ('response' in caller) return caller.response;
    const row = await readinessRepository.evidenceById(caller.projectId, p.evidenceId);
    if (!row || row.deletedAt || row.kind !== 'file') return notFound('Evidence file');
    const bytes = await readinessRepository.evidenceFile(caller.projectId, p.evidenceId);
    if (!bytes) return internalError('The stored file could not be opened. Upload it again.');
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${(row.fileName ?? 'evidence').replace(/"/g, '')}"`,
        'Content-Length': String(bytes.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'X-Evidence-Sha256': row.sha256 ?? '',
      },
    });
  } catch (err) {
    console.error('[GET readiness evidence file]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

const LinkSchema = z.object({ controls: z.array(z.string().max(40)).max(60) });

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const p = await params;
    const caller = await guardReadiness(req, p);
    if ('response' in caller) return caller.response;
    const parsed = await parseBody(req, LinkSchema);
    if (!parsed.ok) return parsed.response;
    const bad = checkControlKeys(parsed.data.controls);
    if (bad) return badRequest(bad);
    const row = await readinessRepository.evidenceById(caller.projectId, p.evidenceId);
    if (!row || row.deletedAt) return notFound('Evidence');
    await readinessRepository.setEvidenceControls(caller.projectId, p.evidenceId, parsed.data.controls);
    await readinessRepository.clearSignoffs(caller.projectId, caller.framework);
    return ok({ saved: true, signoffsCleared: true });
  } catch (err) {
    console.error('[PUT readiness evidence]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const p = await params;
    const caller = await guardReadiness(req, p);
    if ('response' in caller) return caller.response;
    const row = await readinessRepository.evidenceById(caller.projectId, p.evidenceId);
    if (!row || row.deletedAt) return notFound('Evidence');
    if (!caller.isAdmin && row.uploadedBy !== caller.email) return forbidden('Only the person who added the evidence, or an owner or admin, can remove it.');
    await readinessRepository.removeEvidence(caller.projectId, p.evidenceId, caller.email);
    await readinessRepository.clearSignoffs(caller.projectId, caller.framework);
    return ok({ removed: true, signoffsCleared: true });
  } catch (err) {
    console.error('[DELETE readiness evidence]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
