import { NextRequest, NextResponse } from 'next/server';
import { ComplianceEngine } from '@/lib/engines/compliance/ComplianceEngine';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import type { CanvasEdge, CanvasNode } from '@/types';

/**
 * POST /api/architecture/[id]/compliance
 *
 * Maps the live canvas graph's technical assessment to SOC 2 / HIPAA / PCI DSS
 * control areas (technical indicators only — never a compliance determination).
 * Results are persisted only when the caller is a member of the org that owns
 * the project (previously any signed-in user could write assessment rows for
 * any project ID).
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const params = await props.params;
    const identity = extractIdentity(req);
    if (!identity) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    void params.id; // kept for route compatibility; the architecture is resolved server-side
    const body = await req.json().catch(() => null);
    const { projectId, resources, edges, frameworks, env } = (body ?? {}) as {
      projectId?: string;
      env?: string;
      resources?: CanvasNode[];
      edges?: CanvasEdge[];
      frameworks?: ('SOC2' | 'HIPAA' | 'PCI-DSS')[];
    };
    if (!projectId || !Array.isArray(resources) || !Array.isArray(frameworks)) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }
    const allowed = new Set(['SOC2', 'HIPAA', 'PCI-DSS']);
    if (frameworks.some((f) => !allowed.has(f))) return NextResponse.json({ error: 'Unsupported framework' }, { status: 400 });

    let persistAs = 'draft';
    if (projectId !== 'draft-project') {
      const orgId = await resolveOrgId(req, identity.userId);
      const role = orgId ? await getOrgRole(identity.userId, orgId) : null;
      if (!orgId || !role) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      const ctx = await resolveArchitecture(projectId, orgId, env ?? 'production');
      if ('error' in ctx) {
        if (ctx.error === 'project_not_found') return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      } else {
        // Persist against the project's real architecture row, never a client-supplied ID.
        persistAs = ctx.arch.id;
      }
    }

    const result = await ComplianceEngine.evaluateArchitecture(projectId, persistAs, resources, frameworks, Array.isArray(edges) ? edges : []);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Compliance evaluation error:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Failed to run compliance evaluation' }, { status: 500 });
  }
}
