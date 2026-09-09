/**
 * GET  /api/projects/[id]/versions          — list all versions
 * POST /api/projects/[id]/versions          — create a new version snapshot
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { projectRepository, environmentRepository } from '@/lib/repositories/projectRepository';
import { architectureRepository, toCanvas } from '@/lib/repositories/architectureRepository';
import { orgRepository } from '@/lib/repositories/orgRepository';
import type { Environment } from '@/types';

export const dynamic = 'force-dynamic';

const CreateVersionSchema = z.object({
  label:   z.string().min(1).max(120),
  summary: z.string().max(500).optional().default(''),
  env:     z.enum(['development', 'staging', 'production']).optional().default('production'),
  author:  z.string().optional(),
});

async function resolveOrgId(req: NextRequest): Promise<string | null> {
  const orgId = req.nextUrl.searchParams.get('orgId') ?? '';
  if (orgId) return orgId;
  if (process.env.NODE_ENV === 'development') {
    const ctx = await orgRepository.ensureDevContext();
    return ctx.orgId;
  }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;

    const orgId = await resolveOrgId(req);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const project = await projectRepository.findById(projectId, orgId);
    if (!project) return notFound('Project');

    const envKey = (req.nextUrl.searchParams.get('env') ?? 'production') as Environment;
    const env = await environmentRepository.findByKey(projectId, envKey);
    if (!env) return notFound('Environment');

    const arch = await architectureRepository.findByEnvironment(env.id);
    if (!arch) return ok([]);

    const versions = await architectureRepository.listVersions(projectId, arch.id);
    return ok(versions.map((v) => {
      let nodeCount = 0;
      try {
        const snap = JSON.parse(v.snapshotJson);
        nodeCount = Array.isArray(snap?.nodes) ? snap.nodes.length : 0;
      } catch {}
      return {
        id: v.id,
        version: v.versionNumber,
        label: v.label,
        summary: v.summary,
        author: v.author,
        timestamp: v.createdAt,
        nodeCount,
      };
    }));
  } catch (err) {
    console.error('[GET /api/projects/:id/versions]', err);
    return internalError();
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;

    const parsed = await parseBody(req, CreateVersionSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const orgId = await resolveOrgId(req);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role || role === 'viewer') return forbidden();

    const project = await projectRepository.findById(projectId, orgId);
    if (!project) return notFound('Project');

    const envKey = body.env as Environment;
    const env = await environmentRepository.findByKey(projectId, envKey);
    if (!env) return notFound('Environment');

    const arch = await architectureRepository.findByEnvironment(env.id);
    if (!arch) return badRequest('No architecture found for this environment. Save canvas first.');

    const canvas = toCanvas(arch.resources, arch.connections);
    const version = await architectureRepository.createVersion({
      projectId,
      architectureId: arch.id,
      label: body.label,
      summary: body.summary,
      author: body.author ?? identity.userId,
      nodes: canvas.nodes,
      edges: canvas.edges,
    });

    return created({
      id: version.id,
      version: version.versionNumber,
      label: version.label,
      summary: version.summary,
      author: version.author,
      timestamp: version.createdAt,
      nodeCount: canvas.nodes.length,
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/versions]', err);
    return internalError();
  }
}
