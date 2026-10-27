/** GET /api/auditor/evidence/[evidenceId]   Authorization: Bearer ca_…   One evidence file, only if it is linked to the framework the link was made for. */
import { NextRequest, NextResponse } from 'next/server';
import { notFound, internalError } from '@/lib/api/response';
import { authenticateAuditor } from '@/lib/compliance/auditorAuth';
import { readinessRepository } from '@/lib/repositories/readinessRepository';
import { evidenceControls } from '@/lib/compliance/evidenceInput';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ evidenceId: string }> }) {
  try {
    const a = await authenticateAuditor(req);
    if ('response' in a) return a.response;
    const { evidenceId } = await params;
    const row = await readinessRepository.evidenceById(a.projectId, evidenceId);
    if (!row || row.deletedAt || row.kind !== 'file' || evidenceControls(row, a.framework).length === 0) return notFound('Evidence file');
    const bytes = await readinessRepository.evidenceFile(a.projectId, evidenceId);
    if (!bytes) return notFound('Evidence file');
    return new NextResponse(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${(row.fileName ?? 'evidence').replace(/"/g, '')}"`, 'Content-Length': String(bytes.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'X-Evidence-Sha256': row.sha256 ?? '' } });
  } catch (err) {
    console.error('[GET auditor evidence]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
