/**
 * GET /api/projects/[id]/readiness/[framework]/package
 *
 * The package for the auditor as one zip: the report (Word and PDF for SOC 2), the control matrix, findings, every evidence file with its fingerprint checked
 * again, sign-offs, the snapshot history, and a manifest of SHA-256 fingerprints. An evidence file that no longer matches its fingerprint is flagged in the package.
 */
import { NextRequest, NextResponse } from 'next/server';
import { notFound, badRequest, internalError } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { packageForProject } from '@/lib/compliance/packageService';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params, { limitKey: 'readiness-package' });
    if ('response' in caller) return caller.response;
    const pkg = await packageForProject({ orgId: caller.orgId, projectId: caller.projectId, framework: caller.framework, env: caller.env, preparedBy: caller.email });
    if (!pkg.ok) return pkg.reason === 'project_not_found' ? notFound('Project') : badRequest('Save the architecture first: the package is built from the saved architecture.');
    return new NextResponse(new Uint8Array(pkg.bytes), {
      status: 200,
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${pkg.name}"`, 'Content-Length': String(pkg.bytes.length), 'Cache-Control': 'no-store', 'X-Evidence-Problems': String(pkg.mismatches.length) },
    });
  } catch (err) {
    console.error('[GET readiness package]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
