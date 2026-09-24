/**
 * GET /api/projects/[id]/canvas          — load nodes + edges for the active environment
 * PUT /api/projects/[id]/canvas          — save nodes + edges for the active environment
 */
import { NextRequest } from 'next/server';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { projectRepository, environmentRepository } from '@/lib/repositories/projectRepository';
import { architectureRepository, toCanvas, RevisionConflictError, ResourceIdConflictError } from '@/lib/repositories/architectureRepository';
import { resolveOrgId } from '@/lib/api/phase2d';
import { ArchitectureReviewService } from '@/lib/services/ArchitectureReviewService';
import { SaveCanvasSchema } from '@/lib/api/schemas/canvasSchema';
import type { Environment, CanvasNode, CanvasEdge } from '@/types';

export const dynamic = 'force-dynamic';

// Used ONLY by the dev-mode DB-unreachable fallback path below (no Postgres
// running locally). The real, production revision counter is DB-backed —
// see architectureRepository.saveCanvas / the "architecture.revision" column
// — specifically so it stays correct across multiple server instances. This
// Map exists purely so `npm run dev` still works with no database at all.
const _devFallbackRevisions = new Map<string, number>();

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const project = await projectRepository.findById(projectId, orgId);
    if (!project) return notFound('Project');

    const envKey = (req.nextUrl.searchParams.get('env') ?? 'production') as Environment;
    const env = await environmentRepository.findByKey(projectId, envKey);
    if (!env) return notFound('Environment');

    const arch = await architectureRepository.findByEnvironment(env.id);
    if (!arch) return ok({ nodes: [], edges: [], revision: 1 });

    return ok({ ...toCanvas(arch.resources, arch.connections), revision: arch.revision });
  } catch (err) {
    console.error('[GET /api/projects/:id/canvas]', err);
    return internalError();
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;

    const parsed = await parseBody(req, SaveCanvasSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role || role === 'viewer') return forbidden();

    try {
      const project = await projectRepository.findById(projectId, orgId);
      if (!project) {
        if (process.env.NODE_ENV === 'development') {
          return ok({ nodes: body.nodes, edges: body.edges });
        }
        return notFound('Project');
      }

      const envKey = body.env as Environment;
      const env = await environmentRepository.findByKey(projectId, envKey);
      if (!env) {
        if (process.env.NODE_ENV === 'development') {
          return ok({ nodes: body.nodes, edges: body.edges });
        }
        return notFound('Environment');
      }

      // Invalidate existing approval if architecture changed
      ArchitectureReviewService.checkAndInvalidateOnSave(
        projectId,
        envKey,
        body.nodes as CanvasNode[],
        body.edges as CanvasEdge[]
      );

      // Cast Zod-validated nodes (region is string) to CanvasNode[] (region is Region)
      const arch = await architectureRepository.saveCanvas(
        env.id,
        body.nodes as import('@/types').CanvasNode[],
        body.edges as import('@/types').CanvasEdge[],
        body.revision,
      );
      const canvasData = toCanvas(arch.resources, arch.connections);
      return ok({ ...canvasData, revision: arch.revision });
    } catch (dbErr) {
      if (dbErr instanceof ResourceIdConflictError) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: 'RESOURCE_ID_CONFLICT',
              message: 'Some resource IDs in this canvas already belong to another architecture. Re-create the resources (or re-apply the template) so they receive new IDs.',
              conflictingIds: dbErr.conflictingIds.slice(0, 20),
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (dbErr instanceof RevisionConflictError) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: 'CONFLICT',
              message: 'Revision conflict: a newer architecture version exists on the server.',
              serverRevision: dbErr.serverRevision,
              clientRevision: dbErr.clientRevision,
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }

      console.error('[PUT /api/projects/:id/canvas] architectureRepository.saveCanvas failed:', dbErr instanceof Error ? dbErr.stack ?? dbErr.message : dbErr);

      // Invalidate existing approval if architecture changed in dev fallback mode as well
      ArchitectureReviewService.checkAndInvalidateOnSave(
        projectId,
        body.env as Environment,
        body.nodes as CanvasNode[],
        body.edges as CanvasEdge[]
      );
      if (process.env.NODE_ENV === 'development') {
        const revKey = `${projectId}:${body.env}`;
        const serverRev = _devFallbackRevisions.get(revKey) ?? 1;
        if (body.revision !== undefined && body.revision < serverRev) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: {
                code: 'CONFLICT',
                message: 'Revision conflict: a newer architecture version exists on the server.',
                serverRevision: serverRev,
                clientRevision: body.revision,
              },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const newRev = Math.max(serverRev, body.revision ?? serverRev) + 1;
        _devFallbackRevisions.set(revKey, newRev);
        return ok({ nodes: body.nodes, edges: body.edges, revision: newRev });
      }
      throw dbErr;
    }
  } catch (err) {
    console.error('[PUT /api/projects/:id/canvas]', err);
    return internalError();
  }
}
