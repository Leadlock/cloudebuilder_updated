/** GET /api/auditor/package   Authorization: Bearer ca_…   The auditor package as one zip (same as the company's own download). */
import { NextRequest, NextResponse } from 'next/server';
import { notFound, internalError } from '@/lib/api/response';
import { authenticateAuditor } from '@/lib/compliance/auditorAuth';
import { packageForProject } from '@/lib/compliance/packageService';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const a = await authenticateAuditor(req);
    if ('response' in a) return a.response;
    const pkg = await packageForProject({ orgId: a.orgId, projectId: a.projectId, framework: a.framework, preparedBy: `Read by auditor ${a.access.name}` });
    if (!pkg.ok) return notFound('Report');
    return new NextResponse(new Uint8Array(pkg.bytes), { status: 200, headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${pkg.name}"`, 'Content-Length': String(pkg.bytes.length), 'Cache-Control': 'no-store', 'X-Evidence-Problems': String(pkg.mismatches.length) } });
  } catch (err) {
    console.error('[GET auditor package]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
