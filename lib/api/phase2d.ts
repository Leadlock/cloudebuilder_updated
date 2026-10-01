/**
 * Shared helper for Phase 2D API routes.
 * Resolves architecture from a project given orgId + optional environmentKey.
 */
import { NextRequest } from 'next/server';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { resolveOrgIds } from '@/lib/api/auth';
import { projectRepository, environmentRepository } from '@/lib/repositories/projectRepository';
import { architectureRepository } from '@/lib/repositories/architectureRepository';
import type { DbArchitecture } from '@/lib/repositories/architectureRepository';
import type { DbProject } from '@/lib/repositories/projectRepository';

/**
 * Resolves the org a request should operate against: an explicit orgId query
 * param first, then the calling user's own org membership. The dev-mode
 * fallback only applies when the caller has no org of their own — it must
 * never override a real user's actual membership.
 */
export async function resolveOrgId(req: NextRequest, userId?: string): Promise<string | null> {
  const orgId = req.nextUrl.searchParams.get('orgId') ?? '';
  if (orgId) return orgId;
  if (userId) {
    const memberOrgIds = await resolveOrgIds(userId);
    if (memberOrgIds[0]) return memberOrgIds[0];
  }
  if (process.env.NODE_ENV === 'development') {
    try {
      const ctx = await orgRepository.ensureDevContext();
      return ctx.orgId;
    } catch {
      return 'dev-org-id';
    }
  }
  return null;
}

export interface ResolvedArchContext {
  orgId: string;
  project: DbProject;
  arch: DbArchitecture;
}

import { mockProjects } from '@/lib/mockData';

export async function resolveArchitecture(
  projectId: string,
  orgId: string,
  envKey = 'production',
): Promise<ResolvedArchContext | { error: string }> {
  try {
    const project = await projectRepository.findById(projectId, orgId);
    if (project) {
      const env = await environmentRepository.findByKey(projectId, envKey as import('@/types').Environment);
      if (env) {
        const arch = await architectureRepository.findByEnvironment(env.id);
        if (arch) {
          return { orgId, project, arch };
        }
        return { error: 'architecture_not_found' };
      }
      return { error: 'environment_not_found' };
    }
  } catch {
    // Database connection error — fall through to dev mock fallback if in development
  }

  // Demo data stands in for the database ONLY on a developer machine. In production (or tests) a database error must
  // surface as an error, never as someone else's demo architecture.
  if (process.env.NODE_ENV === 'development') {
    const mock = mockProjects.find((p) => p.id === projectId);
    if (mock) {
      const mockOrgId = (mock as { orgId?: string }).orgId;
      if (mockOrgId && mockOrgId !== orgId) {
        return { error: 'project_not_found' };
      }
      const mockEnv = mock.environments[envKey as import('@/types').Environment] || mock.environments.production;
      const rawNodes = (mockEnv?.nodes && mockEnv.nodes.length > 0) ? mockEnv.nodes : (mock.nodes || []);
      const dbResources = rawNodes.map((n) => ({
        id: n.id,
        resourceType: n.resourceType,
        provider: n.provider,
        label: n.label,
        positionX: n.position?.x ?? 0,
        positionY: n.position?.y ?? 0,
        configJson: JSON.stringify(n.config || {}),
        region: n.region || mock.region || 'us-east-1',
        groupId: n.groupId || null,
        locked: n.locked || false,
        architectureId: `arch-${mock.id}`,
      }));
      return {
        orgId,
        project: {
          id: mock.id,
          name: mock.name,
          description: mock.description,
          provider: mock.provider,
          region: mock.region,
          tags: mock.tags,
          createdAt: mock.createdAt,
          updatedAt: mock.updatedAt,
          orgId,
          ownerId: 'dev-user-id',
          environments: [],
        },
        arch: {
          id: `arch-${mock.id}`,
          environmentId: `env-${mock.id}`,
          createdAt: mock.createdAt,
          updatedAt: mock.updatedAt,
          revision: 1,
          resources: dbResources,
          connections: [],
        },
      };
    } else {
      return {
        orgId,
        project: {
          id: projectId,
          name: projectId === 'draft' ? 'Active Canvas Architecture' : 'CloudCraft Project',
          description: 'Active deployment project',
          provider: 'aws',
          region: 'us-east-1',
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          orgId,
          ownerId: 'dev-user-id',
          environments: [],
        },
        arch: {
          id: `arch-${projectId}`,
          environmentId: `env-${projectId}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          revision: 1,
          resources: [],
          connections: [],
        },
      };
    }
  }
  return { error: 'project_not_found' };
}
