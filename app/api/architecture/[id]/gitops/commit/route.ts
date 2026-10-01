/**
 * POST /api/architecture/[id]/gitops/commit — commit the architecture's generated Terraform to a GitHub repository
 * (optionally opening a pull request) using a GitHub token the caller supplies.
 *
 * Everything the caller sends is validated: the repository, branch and token are restricted to what GitHub itself
 * allows, the canvas is bounded in size, the caller must belong to the project's organisation, and commits are rate
 * limited. The Terraform that gets committed goes through the same HCL escaping and safety scan as every other
 * generation path (see lib/engines/terraform/hclSafety.ts). The GitHub token is used for this request only and is
 * never logged or stored.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { GitOpsService } from '@/lib/services/GitOpsService';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import { TerraformSafetyError } from '@/lib/engines/terraform/hclSafety';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';

export const dynamic = 'force-dynamic';

const NodeSchema = z.object({
  id: z.string().min(1).max(200),
  resourceType: z.string().min(1).max(100),
  provider: z.string().max(20),
  label: z.string().max(300).default(''),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
  groupId: z.string().max(200).nullish(),
  width: z.number().finite().nullish(),
  height: z.number().finite().nullish(),
  config: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

const EdgeSchema = z.object({
  id: z.string().min(1).max(200),
  source: z.string().min(1).max(200),
  target: z.string().min(1).max(200),
  label: z.unknown().optional(),
  type: z.string().max(50).optional(),
}).passthrough();

// GitHub's own rules: owner = 1–39 letters/digits/hyphens; repo = letters, digits, '.', '_', '-'; tokens are one word.
const RequestSchema = z.object({
  projectId: z.string().min(1).max(200),
  githubOrg: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'Invalid GitHub owner'),
  githubRepo: z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/, 'Invalid GitHub repository name'),
  branch: z.string().min(1).max(200).regex(/^[A-Za-z0-9._\/-]+$/, 'Invalid branch name')
    .refine((b) => !b.startsWith('/') && !b.startsWith('-') && !b.endsWith('/') && !b.endsWith('.lock') && !b.includes('..') && !b.includes('//'), 'Invalid branch name'),
  // An empty message falls back to a default rather than failing the request.
  commitMessage: z.string().trim().max(500).optional().transform((m) => m || 'Update infrastructure from CloudCraft'),
  createPullRequest: z.boolean().default(false),
  githubToken: z.string().min(20).max(255).regex(/^[A-Za-z0-9_-]+$/, 'Invalid GitHub token format'),
  nodes: z.array(NodeSchema).max(500),
  edges: z.array(EdgeSchema).max(1500).default([]),
});

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const { id: architectureId } = await props.params;

    const identity = extractIdentity(req);
    if (!identity) return fail('Unauthorized', 401);

    const rl = checkRateLimit(`${identity.userId}:gitops-commit`, 10, 10 * 60_000);
    if (!rl.allowed) {
      const res = fail('Too many commits — please slow down and try again shortly.', 429);
      if (rl.retryAfterSeconds) res.headers.set('Retry-After', String(rl.retryAfterSeconds));
      return res;
    }

    let raw: unknown;
    try { raw = await req.json(); } catch { return fail('Invalid JSON body', 400); }
    const parsed = RequestSchema.safeParse(raw);
    if (!parsed.success) return fail(`Invalid request: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ')}`, 400);
    const { projectId, githubOrg, githubRepo, branch, commitMessage, createPullRequest, githubToken, nodes, edges } = parsed.data;

    // The caller must belong to the organisation that owns this project.
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return fail('orgId required', 400);
    if (!(await getOrgRole(identity.userId, orgId))) return fail('Forbidden', 403);
    const ctx = await resolveArchitecture(projectId, orgId, 'production');
    if ('error' in ctx && ctx.error === 'project_not_found') return fail('Project not found', 404);

    // Convert CanvasNode/Edge to DbArchitectureResource/Connection for TerraformGenerator
    const now = new Date().toISOString();
    const resources: DbArchitectureResource[] = nodes.map((n) => ({
      id: n.id,
      architectureId,
      resourceType: n.resourceType,
      provider: n.provider,
      label: n.label,
      groupId: n.groupId || null,
      configJson: JSON.stringify(n.config),
      positionX: n.position?.x ?? 0,
      positionY: n.position?.y ?? 0,
      width: n.width ?? null,
      height: n.height ?? null,
      region: typeof n.config['region'] === 'string' ? (n.config['region'] as string) : 'us-east-1',
      locked: false,
      createdAt: now,
      updatedAt: now,
    })) as unknown as DbArchitectureResource[];

    const connections: DbArchitectureConnection[] = edges.map((e) => ({
      id: e.id,
      architectureId,
      sourceId: e.source,
      targetId: e.target,
      relationshipType: 'connects_to',
      edgeType: e.type || 'default',
      label: typeof e.label === 'string' ? e.label : null,
      configJson: '{}',
      createdAt: now,
      updatedAt: now,
    })) as unknown as DbArchitectureConnection[];

    let tfResult;
    try {
      tfResult = new TerraformGenerator().generate({ architectureId, projectId, resources, connections, projectName: 'cloudcraft-deployment' });
    } catch (err) {
      if (err instanceof TerraformSafetyError) return fail('The generated Terraform was refused by CloudCraft\'s safety checks, so nothing was committed.', 422);
      throw err;
    }

    const files = tfResult.files.map((f) => ({ path: `terraform/${f.filename}`, content: f.content }));
    // If no terraform files generated, fallback to an empty main.tf
    if (files.length === 0) files.push({ path: 'terraform/main.tf', content: '# No resources to generate' });

    const result = await GitOpsService.commitArchitecture({ projectId, githubOrg, githubRepo, branch, commitMessage, files, createPullRequest, githubToken });
    return NextResponse.json(result);
  } catch (error) {
    // Message only: a GitHub client error can carry the request, including the Authorization header.
    console.error('GitOps commit error:', error instanceof Error ? error.message : String(error));
    return fail('Failed to commit to GitHub. Check the repository, branch and token, then try again.', 500);
  }
}
