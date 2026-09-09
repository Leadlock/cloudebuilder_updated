/**
 * GET /api/projects/[id]/canvas          — load nodes + edges for the active environment
 * PUT /api/projects/[id]/canvas          — save nodes + edges for the active environment
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { projectRepository, environmentRepository } from '@/lib/repositories/projectRepository';
import { architectureRepository, toCanvas } from '@/lib/repositories/architectureRepository';
import { orgRepository } from '@/lib/repositories/orgRepository';
import type { Environment } from '@/types';

export const dynamic = 'force-dynamic';

const CanvasNodeSchema = z.object({
  id:           z.string(),
  type:         z.string().default('cloudNode'),
  resourceType: z.string(),
  provider:     z.enum(['aws', 'azure']),
  label:        z.string(),
  position:     z.object({ x: z.number(), y: z.number() }),
  config:       z.record(z.string(), z.unknown()),
  region:       z.string().optional(),
  groupId:      z.string().optional(),
  locked:       z.boolean().optional(),
});

const CanvasEdgeSchema = z.object({
  id:       z.string(),
  source:   z.string(),
  target:   z.string(),
  label:    z.string().optional(),
  edgeType: z.enum(['data', 'network', 'security', 'management']).optional(),
});

const SaveCanvasSchema = z.object({
  env:   z.enum(['development', 'staging', 'production']).optional().default('production'),
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(CanvasEdgeSchema),
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
    if (!arch) return ok({ nodes: [], edges: [] });

    return ok(toCanvas(arch.resources, arch.connections));
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

    const orgId = await resolveOrgId(req);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role || role === 'viewer') return forbidden();

    const project = await projectRepository.findById(projectId, orgId);
    if (!project) return notFound('Project');

    const envKey = body.env as Environment;
    let env = await environmentRepository.findByKey(projectId, envKey);
    if (!env) return notFound('Environment');

    // Cast Zod-validated nodes (region is string) to CanvasNode[] (region is Region)
    const arch = await architectureRepository.saveCanvas(env.id, body.nodes as import('@/types').CanvasNode[], body.edges as import('@/types').CanvasEdge[]);
    return ok(toCanvas(arch.resources, arch.connections));
  } catch (err) {
    console.error('[PUT /api/projects/:id/canvas]', err);
    return internalError();
  }
}
