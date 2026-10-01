/**
 * ProjectRepository — all database access for projects and environments.
 *
 * Rules:
 * - All methods are org-scoped: callers MUST supply orgId.
 * - Never returns raw DB rows — always maps to clean domain objects.
 * - Never performs authorization; that belongs in the route handler.
 */
import { db, rawTransaction } from '@/src/prisma/db';
import { mockProjects } from '@/lib/mockData';
import { randomUUID as uuidv4 } from 'crypto';
import type { CloudProvider, Region, Environment } from '@/types';

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface DbProject {
  id: string;
  name: string;
  description: string;
  provider: CloudProvider;
  region: Region;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  orgId: string;
  ownerId: string;
  environments?: DbEnvironment[];
}

export interface DbEnvironment {
  id: string;
  envKey: Environment;
  label: string;
  region: Region;
  createdAt: string;
  updatedAt: string;
  projectId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now(): string { return new Date().toISOString(); }

function parseTags(raw: string): string[] {
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

function mapProject(row: { id: string; name: string; description: string; provider: string; region: string; tags: string; createdAt: string; updatedAt: string; orgId: string; ownerId: string }): Omit<DbProject, 'environments'> {
  return {
    id: row.id, name: row.name, description: row.description,
    provider: row.provider as CloudProvider, region: row.region as Region,
    tags: parseTags(row.tags), createdAt: row.createdAt, updatedAt: row.updatedAt,
    orgId: row.orgId, ownerId: row.ownerId,
  };
}

function mapEnv(row: { id: string; envKey: string; label: string; region: string; createdAt: string; updatedAt: string; projectId: string }): DbEnvironment {
  return { ...row, envKey: row.envKey as Environment, region: row.region as Region };
}

// ─── Project Repository ───────────────────────────────────────────────────────

export const projectRepository = {

  async list(orgId: string): Promise<DbProject[]> {
    const rows = await db.orm.public.Project
      .where({ orgId })
      .select('id', 'name', 'description', 'provider', 'region', 'tags', 'createdAt', 'updatedAt', 'orgId', 'ownerId')
      .all();
    return rows.map(mapProject);
  },

  async findById(id: string, orgId: string): Promise<DbProject | null> {
    const row = await db.orm.public.Project
      .where({ id, orgId })
      .select('id', 'name', 'description', 'provider', 'region', 'tags', 'createdAt', 'updatedAt', 'orgId', 'ownerId')
      .first();
    if (!row) return null;

    const envRows = await db.orm.public.Environment
      .where({ projectId: id })
      .select('id', 'envKey', 'label', 'region', 'createdAt', 'updatedAt', 'projectId')
      .all();

    return { ...mapProject(row), environments: envRows.map(mapEnv) };
  },

  async create(input: {
    name: string;
    provider: CloudProvider;
    region: Region;
    description?: string;
    tags?: string[];
    orgId: string;
    ownerId: string;
  }): Promise<DbProject> {
    const ts = now();
    const id = uuidv4();
    await db.orm.public.Project.create({
      id,
      name: input.name,
      description: input.description ?? '',
      provider: input.provider,
      region: input.region,
      tags: JSON.stringify(input.tags ?? []),
      orgId: input.orgId,
      ownerId: input.ownerId,
      createdAt: ts,
      updatedAt: ts,
    });
    // Seed three default environments
    const envDefs: Array<{ envKey: Environment; label: string }> = [
      { envKey: 'production',  label: 'Production'  },
      { envKey: 'staging',     label: 'Staging'     },
      { envKey: 'development', label: 'Development' },
    ];
    for (const def of envDefs) {
      await environmentRepository.create({
        envKey: def.envKey, label: def.label, region: input.region, projectId: id,
      });
    }
    return (await this.findById(id, input.orgId))!;
  },

  async update(id: string, orgId: string, input: Partial<{
    name: string;
    description: string;
    tags: string[];
    region: Region;
  }>): Promise<DbProject | null> {
    const existing = await db.orm.public.Project.where({ id, orgId }).first();
    if (!existing) return null;
    const ts = now();
    await db.orm.public.Project.where({ id, orgId }).update({
      ...(input.name !== undefined      && { name:        input.name        }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.tags !== undefined      && { tags:        JSON.stringify(input.tags) }),
      ...(input.region !== undefined    && { region:      input.region      }),
      updatedAt: ts,
    });
    return this.findById(id, orgId);
  },

  async delete(id: string, orgId: string): Promise<boolean> {
    const existing = await db.orm.public.Project.where({ id, orgId }).first();
    if (!existing) {
      const mockIdx = mockProjects.findIndex((p) => p.id === id);
      if (mockIdx >= 0) {
        mockProjects.splice(mockIdx, 1);
        return true;
      }
      return false;
    }

    try {
      if (typeof rawTransaction === 'function') {
        await rawTransaction(async (query) => {
          const envsRes = await query('SELECT "id" FROM "environment" WHERE "projectId" = $1', [id]);
          const envIds = (envsRes.rows as Array<{ id: string }>).map((r) => r.id);

          if (envIds.length > 0) {
            const archRes = await query('SELECT "id" FROM "architecture" WHERE "environmentId" = ANY($1::text[])', [envIds]);
            const archIds = (archRes.rows as Array<{ id: string }>).map((r) => r.id);
            if (archIds.length > 0) {
              await query('DELETE FROM "architectureConnection" WHERE "architectureId" = ANY($1::text[])', [archIds]);
              await query('DELETE FROM "architectureResource" WHERE "architectureId" = ANY($1::text[])', [archIds]);
              await query('DELETE FROM "architectureVersion" WHERE "architectureId" = ANY($1::text[])', [archIds]);
              await query('DELETE FROM "securityFinding" WHERE "scanId" IN (SELECT "id" FROM "securityScan" WHERE "architectureId" = ANY($1::text[]))', [archIds]);
              await query('DELETE FROM "securityScan" WHERE "architectureId" = ANY($1::text[])', [archIds]);
              await query('DELETE FROM "costEstimate" WHERE "architectureId" = ANY($1::text[])', [archIds]);
              await query('DELETE FROM "archOptimization" WHERE "architectureId" = ANY($1::text[])', [archIds]);
              await query('DELETE FROM "terraformGeneration" WHERE "architectureId" = ANY($1::text[])', [archIds]);
              await query('DELETE FROM "wellArchitectedFinding" WHERE "assessmentId" IN (SELECT "id" FROM "wellArchitectedAssessment" WHERE "architectureId" = ANY($1::text[]))', [archIds]);
              await query('DELETE FROM "wellArchitectedAssessment" WHERE "architectureId" = ANY($1::text[])', [archIds]);
              await query('DELETE FROM "aiGenerationHistory" WHERE "architectureId" = ANY($1::text[])', [archIds]);
              await query('DELETE FROM "complianceFinding" WHERE "assessmentId" IN (SELECT "id" FROM "complianceAssessment" WHERE "architectureId" = ANY($1::text[]))', [archIds]);
              await query('DELETE FROM "complianceAssessment" WHERE "architectureId" = ANY($1::text[])', [archIds]);
              await query('DELETE FROM "exportJob" WHERE "architectureId" = ANY($1::text[])', [archIds]);
              await query('DELETE FROM "architecture" WHERE "id" = ANY($1::text[])', [archIds]);
            }
            await query('DELETE FROM "environment" WHERE "id" = ANY($1::text[])', [envIds]);
          }

          await query('DELETE FROM "architectureVersion" WHERE "projectId" = $1', [id]);
          await query('DELETE FROM "securityScan" WHERE "projectId" = $1', [id]);
          await query('DELETE FROM "costEstimate" WHERE "projectId" = $1', [id]);
          await query('DELETE FROM "archOptimization" WHERE "projectId" = $1', [id]);
          await query('DELETE FROM "terraformGeneration" WHERE "projectId" = $1', [id]);
          await query('DELETE FROM "wellArchitectedAssessment" WHERE "projectId" = $1', [id]);
          await query('DELETE FROM "aiGenerationHistory" WHERE "projectId" = $1', [id]);
          await query('DELETE FROM "complianceAssessment" WHERE "projectId" = $1', [id]);
          await query('DELETE FROM "exportJob" WHERE "projectId" = $1', [id]);
          await query('DELETE FROM "gitOperation" WHERE "projectId" = $1', [id]);
          await query('DELETE FROM "githubConnection" WHERE "projectId" = $1', [id]);
          await query('DELETE FROM "findingReview" WHERE "projectId" = $1', [id]);
          await query('DELETE FROM "project" WHERE "id" = $1 AND "orgId" = $2', [id, orgId]);
        });
      } else {
        await db.orm.public.Project.where({ id, orgId }).delete();
      }
    } catch {
      await db.orm.public.Project.where({ id, orgId }).delete();
    }

    const mockIdx = mockProjects.findIndex((p) => p.id === id);
    if (mockIdx >= 0) {
      mockProjects.splice(mockIdx, 1);
    }
    return true;
  },
};

// ─── Environment Repository ───────────────────────────────────────────────────

export const environmentRepository = {

  async findByProject(projectId: string): Promise<DbEnvironment[]> {
    const rows = await db.orm.public.Environment
      .where({ projectId })
      .select('id', 'envKey', 'label', 'region', 'createdAt', 'updatedAt', 'projectId')
      .all();
    return rows.map(mapEnv);
  },

  async findByKey(projectId: string, envKey: Environment): Promise<DbEnvironment | null> {
    const row = await db.orm.public.Environment
      .where({ projectId, envKey })
      .select('id', 'envKey', 'label', 'region', 'createdAt', 'updatedAt', 'projectId')
      .first();
    return row ? mapEnv(row) : null;
  },

  async create(input: {
    envKey: Environment;
    label: string;
    region: Region;
    projectId: string;
  }): Promise<DbEnvironment> {
    const ts = now();
    const id = uuidv4();
    await db.orm.public.Environment.create({
      id, envKey: input.envKey, label: input.label, region: input.region,
      projectId: input.projectId, createdAt: ts, updatedAt: ts,
    });
    return { id, ...input, createdAt: ts, updatedAt: ts };
  },

  async update(projectId: string, envKey: Environment, input: { region?: Region }): Promise<DbEnvironment | null> {
    const existing = await this.findByKey(projectId, envKey);
    if (!existing) return null;
    const ts = now();
    await db.orm.public.Environment
      .where({ projectId, envKey })
      .update({
        ...(input.region !== undefined && { region: input.region }),
        updatedAt: ts,
      });
    return this.findByKey(projectId, envKey);
  },
};
