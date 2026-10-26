/**
 * POST /api/projects/[id]/well-architected/agent-package — the project's generated Terraform as a zip for the AWS Well-Architected Agent (preview).
 * Read-only and nothing is sent to AWS: the person uploads the zip themselves. See lib/wellArchitectedTool/agentPackage.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { internalError, notFound, badRequest, forbidden, unauthorized, tooManyRequests, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import { AgentPackageError, buildAgentPackage } from '@/lib/wellArchitectedTool/agentPackage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Schema = z.object({ env: z.string().optional().default('production') });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const rl = await checkRateLimit(`${identity.userId}:wa-agent-package`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);
    const parsed = await parseBody(req, Schema);
    if (!parsed.ok) return parsed.response;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    if (!(await getOrgRole(identity.userId, orgId))) return forbidden();

    const ctx = await resolveArchitecture(projectId, orgId, parsed.data.env);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      return badRequest('Save the architecture first: the package is made from the persisted architecture.');
    }
    const { arch, project } = ctx;
    if (!arch.resources.some((r) => r.provider === 'aws')) return badRequest('This project has no AWS resources: the AWS Well-Architected Agent reviews AWS infrastructure code.');

    const name = project.name.replace(/\s+/g, '-').toLowerCase();
    const result = terraformGenerator.generate({ architectureId: arch.id, projectId, resources: arch.resources, connections: arch.connections, projectName: name });
    const zip = buildAgentPackage({
      projectName: project.name, files: result.files.map((f) => ({ filename: f.filename, content: f.content })), warnings: result.warnings,
      ...(result.blocking ? { blocking: result.blocking } : {}), generatedAt: new Date().toISOString(),
    });
    return new NextResponse(new Uint8Array(zip), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip', 'Content-Length': String(zip.length), 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="well-architected-agent-${name.replace(/[^a-z0-9-]+/g, '-').slice(0, 40)}.zip"`,
      },
    });
  } catch (err) {
    if (err instanceof AgentPackageError) return badRequest(err.message);
    console.error('[POST /api/projects/:id/well-architected/agent-package]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
