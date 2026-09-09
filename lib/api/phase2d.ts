/**
 * Shared helper for Phase 2D API routes.
 * Resolves architecture from a project given orgId + optional environmentKey.
 */
import { NextRequest } from 'next/server';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { projectRepository, environmentRepository } from '@/lib/repositories/projectRepository';
import { architectureRepository } from '@/lib/repositories/architectureRepository';
import type { DbArchitecture } from '@/lib/repositories/architectureRepository';
import type { DbProject } from '@/lib/repositories/projectRepository';

export async function resolveOrgId(req: NextRequest): Promise<string | null> {
  const orgId = req.nextUrl.searchParams.get('orgId') ?? '';
  if (orgId) return orgId;
  if (process.env.NODE_ENV === 'development') {
    const ctx = await orgRepository.ensureDevContext();
    return ctx.orgId;
  }
  return null;
}

export interface ResolvedArchContext {
  orgId: string;
  project: DbProject;
  arch: DbArchitecture;
}

export async function resolveArchitecture(
  projectId: string,
  orgId: string,
  envKey = 'production',
): Promise<ResolvedArchContext | { error: string }> {
  const project = await projectRepository.findById(projectId, orgId);
  if (!project) return { error: 'project_not_found' };

  const env = await environmentRepository.findByKey(projectId, envKey as import('@/types').Environment);
  if (!env) return { error: 'environment_not_found' };

  const arch = await architectureRepository.findByEnvironment(env.id);
  if (!arch) return { error: 'architecture_not_found' };

  return { orgId, project, arch };
}
