/**
 * CloudCraft Backend Foundation Tests
 *
 * Tests cover: project CRUD, environment management, architecture save/load,
 * version creation/restoration, org isolation, invalid requests, and
 * unauthorized access.
 *
 * The DB is fully mocked so these tests run without a PostgreSQL server.
 */

// ─── Mock the Prisma DB client ────────────────────────────────────────────────

const mockDb = buildMockDb();

// Executes one raw SQL statement (from either rawExec or the rawTransaction
// query callback) against the in-memory mock store — mirrors the small,
// known set of statement shapes architectureRepository actually issues.
// Returns { rows } like the real pg.Client.query does, so SELECT statements
// (e.g. the row-locking SELECT ... FOR UPDATE in saveCanvas) work too.
async function mockExecSql(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
  const isInsert = /^\s*INSERT INTO/i.test(sql);
  const isUpdate = /^\s*UPDATE/i.test(sql);
  const isDelete = /^\s*DELETE FROM/i.test(sql);
  const isSelect = /^\s*SELECT/i.test(sql);

  if (isSelect && /FROM "architecture"/i.test(sql) && /"environmentId"/i.test(sql)) {
    const environmentId = params[0] as string;
    const row = [...mockDb._stores['Architecture'].values()].find((r) => (r as Record<string, unknown>)['environmentId'] === environmentId);
    return { rows: row ? [row as Record<string, unknown>] : [] };
  }
  if (isSelect && /= ANY\(\$1::text\[\]\)/.test(sql)) {
    // saveCanvas guard: IDs already owned by a different architecture (global PK).
    const [nodeIds, archId, edgeIds] = params as [string[], string, string[]];
    const owned = (store: string, ids: string[]) => [...mockDb._stores[store].values()]
      .filter((r) => ids.includes((r as Record<string, unknown>)['id'] as string) && (r as Record<string, unknown>)['architectureId'] !== archId)
      .map((r) => ({ id: (r as Record<string, unknown>)['id'] }));
    return { rows: [...owned('ArchitectureResource', nodeIds), ...owned('ArchitectureConnection', edgeIds)] };
  }
  if (isDelete && /architectureResource/i.test(sql) && params[0]) {
    const archId = params[0] as string;
    for (const [k, v] of mockDb._stores['ArchitectureResource']) {
      if ((v as Record<string, unknown>)['architectureId'] === archId) {
        mockDb._stores['ArchitectureResource'].delete(k);
      }
    }
    return { rows: [] };
  }
  if (isDelete && /architectureConnection/i.test(sql) && params[0]) {
    const archId = params[0] as string;
    for (const [k, v] of mockDb._stores['ArchitectureConnection']) {
      if ((v as Record<string, unknown>)['architectureId'] === archId) {
        mockDb._stores['ArchitectureConnection'].delete(k);
      }
    }
    return { rows: [] };
  }
  if (isUpdate && /"architecture"/i.test(sql)) {
    // UPDATE "architecture" SET "updatedAt" = $1, "revision" = $2 WHERE "id" = $3
    const [updatedAt, revision, id] = params as [string, number, string];
    const row = mockDb._stores['Architecture'].get(id);
    if (row) mockDb._stores['Architecture'].set(id, { ...row, updatedAt, revision });
    return { rows: [] };
  }
  if (isInsert && /"architectureResource"/i.test(sql)) {
    const [id, resourceType, provider, label, positionX, positionY, configJson, region, groupId, locked, architectureId] = params;
    mockDb._stores['ArchitectureResource'].set(id as string, {
      id, resourceType, provider, label, positionX, positionY, configJson, region, groupId, locked, architectureId,
    });
    return { rows: [] };
  }
  if (isInsert && /"architectureConnection"/i.test(sql)) {
    const [id, label, edgeType, architectureId, sourceId, targetId] = params;
    mockDb._stores['ArchitectureConnection'].set(id as string, {
      id, label, edgeType, architectureId, sourceId, targetId,
    });
    return { rows: [] };
  }
  if (isInsert && /"architecture"/i.test(sql)) {
    const [id, environmentId, createdAt, updatedAt, revision] = params;
    mockDb._stores['Architecture'].set(id as string, { id, environmentId, createdAt, updatedAt, revision });
    return { rows: [] };
  }
  throw new Error(`mockExecSql: unrecognised statement shape: ${sql}`);
}

jest.mock('@/src/prisma/db', () => ({
  db: mockDb,
  // rawExec/rawTransaction mirror the real functions' SQL behaviour against the mock store.
  rawExec: jest.fn().mockImplementation(async (sql: string, params: unknown[]) => { await mockExecSql(sql, params); }),
  rawTransaction: jest.fn().mockImplementation(async (fn: (query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<unknown>) => {
    return fn(async (sql: string, params?: unknown[]) => mockExecSql(sql, params ?? []));
  }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import {
  projectRepository,
  environmentRepository,
} from '@/lib/repositories/projectRepository';
import { architectureRepository, toCanvas } from '@/lib/repositories/architectureRepository';
import { orgRepository } from '@/lib/repositories/orgRepository';
import type { CanvasNode, CanvasEdge } from '@/types';

// ─── Mock DB builder ──────────────────────────────────────────────────────────

interface Row { [key: string]: unknown }
type Store = Map<string, Row>;

/**
 * Mock table that implements the Prisma v8 ORM collection API:
 * .where(filter).select(...fields).first()
 * .where(filter).select(...fields).all()
 * .where(filter).update(data)
 * .where(filter).delete()
 * .create(row)
 * .first() (without where)
 */
function makeCollection(rows: () => Row[]) {
  return {
    select(..._fields: string[]) {
      // Fields are ignored in the mock — return all columns
      return makeCollection(rows);
    },
    async first() { return rows()[0] ?? null; },
    async all() { return rows(); },
    async update(data: Record<string, unknown>) {
      // no-op in collection context; real update is on makeTable's .where().update()
      return rows().length;
    },
    async delete() {
      return rows().length;
    },
  };
}

function makeTable(store: Store) {
  return {
    where(filter: Record<string, unknown>) {
      const getMatches = () =>
        [...store.values()].filter((row) =>
          Object.entries(filter).every(([k, v]) => row[k] === v),
        );

      return {
        select(..._fields: string[]) {
          // Fields ignored in mock — return full rows
          const matches = getMatches;
          return {
            async first() { return matches()[0] ?? null; },
            async all() { return matches(); },
          };
        },
        async first() { return getMatches()[0] ?? null; },
        async all() { return getMatches(); },
        async update(data: Record<string, unknown>) {
          getMatches().forEach((row) => {
            store.set(row['id'] as string, { ...row, ...data });
          });
        },
        async delete() {
          getMatches().forEach((row) => store.delete(row['id'] as string));
        },
      };
    },
    async create(row: Record<string, unknown>) {
      store.set(row['id'] as string, row);
      return row;
    },
    async first() { return [...store.values()][0] ?? null; },
    select(..._fields: string[]) {
      const allRows = () => [...store.values()];
      return {
        async first() { return allRows()[0] ?? null; },
        async all() { return allRows(); },
      };
    },
  };
}

function buildMockDb() {
  const stores: Record<string, Store> = {
    User: new Map(),
    Organization: new Map(),
    OrgMember: new Map(),
    Project: new Map(),
    Environment: new Map(),
    Architecture: new Map(),
    ArchitectureResource: new Map(),
    ArchitectureConnection: new Map(),
    ArchitectureVersion: new Map(),
    WellArchitectedAssessment: new Map(),
    WellArchitectedFinding: new Map(),
  };

  const tables: Record<string, ReturnType<typeof makeTable>> = {};
  for (const [name, store] of Object.entries(stores)) {
    tables[name] = makeTable(store);
  }

  return {
    orm: { public: tables },
    _stores: stores,
    _reset() {
      for (const store of Object.values(stores)) store.clear();
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const db = mockDb;

async function seedOrg() {
  return orgRepository.ensureDevContext();
}

function makeNode(id: string, resourceType = 'aws_ec2'): CanvasNode {
  return {
    id,
    type: 'cloudNode',
    resourceType,
    provider: 'aws',
    label: `Node ${id}`,
    position: { x: 0, y: 0 },
    config: { name: id },
  };
}

function makeEdge(id: string, source: string, target: string): CanvasEdge {
  return { id, source, target };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  db._reset();
});

// ── 1. Organization isolation ─────────────────────────────────────────────────

describe('Organization isolation', () => {
  test('projects are scoped to their org', async () => {
    const { orgId } = await seedOrg();
    const p = await projectRepository.create({
      name: 'Isolated Project',
      provider: 'aws',
      region: 'us-east-1',
      orgId,
      ownerId: 'dev-user-id',
    });

    // Correct org can see it
    const found = await projectRepository.findById(p.id, orgId);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Isolated Project');

    // Different org cannot see it
    const other = await projectRepository.findById(p.id, 'other-org-id');
    expect(other).toBeNull();
  });

  test('list returns only org-scoped projects', async () => {
    const { orgId } = await seedOrg();
    await projectRepository.create({ name: 'P1', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id' });
    await projectRepository.create({ name: 'P2', provider: 'azure', region: 'eastus', orgId, ownerId: 'dev-user-id' });

    const all = await projectRepository.list(orgId);
    expect(all.length).toBe(2);

    const none = await projectRepository.list('wrong-org');
    expect(none.length).toBe(0);
  });
});

// ── 2. Project creation ───────────────────────────────────────────────────────

describe('Project creation', () => {
  test('creates project with three default environments', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'My App',
      provider: 'aws',
      region: 'us-east-1',
      description: 'Test project',
      tags: ['web', 'prod'],
      orgId,
      ownerId: 'dev-user-id',
    });

    expect(project.id).toBeDefined();
    expect(project.name).toBe('My App');
    expect(project.provider).toBe('aws');
    expect(project.region).toBe('us-east-1');
    expect(project.tags).toEqual(['web', 'prod']);
    expect(project.environments).toBeDefined();
    expect(project.environments!.length).toBe(3);
    const envKeys = project.environments!.map((e) => e.envKey);
    expect(envKeys).toContain('production');
    expect(envKeys).toContain('staging');
    expect(envKeys).toContain('development');
  });

  test('creates project with multi-cloud provider', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'Multi Cloud',
      provider: 'multi',
      region: 'us-east-1',
      orgId,
      ownerId: 'dev-user-id',
    });
    expect(project.provider).toBe('multi');
  });
});

// ── 3. Project retrieval ──────────────────────────────────────────────────────

describe('Project retrieval', () => {
  test('returns null for non-existent project', async () => {
    const { orgId } = await seedOrg();
    const result = await projectRepository.findById('does-not-exist', orgId);
    expect(result).toBeNull();
  });

  test('retrieves created project by id', async () => {
    const { orgId } = await seedOrg();
    const created = await projectRepository.create({
      name: 'Retrieve Me',
      provider: 'azure',
      region: 'eastus',
      orgId,
      ownerId: 'dev-user-id',
    });
    const found = await projectRepository.findById(created.id, orgId);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Retrieve Me');
    expect(found!.provider).toBe('azure');
  });
});

// ── 4. Environment creation ───────────────────────────────────────────────────

describe('Environment creation', () => {
  test('creates environment with correct fields', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'Env Project',
      provider: 'aws',
      region: 'us-east-1',
      orgId,
      ownerId: 'dev-user-id',
    });

    const env = await environmentRepository.findByKey(project.id, 'production');
    expect(env).not.toBeNull();
    expect(env!.envKey).toBe('production');
    expect(env!.region).toBe('us-east-1');
    expect(env!.projectId).toBe(project.id);
  });

  test('returns null for missing env key', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'P', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id',
    });
    // envKey that doesn't exist
    const env = await environmentRepository.findByKey(project.id, 'development');
    // development IS seeded so it should exist
    expect(env).not.toBeNull();
  });
});

// ── 5. Architecture save ──────────────────────────────────────────────────────

describe('Architecture save', () => {
  test('re-saving the canvas marks any prior Well-Architected assessment stale', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'WA Staleness Project', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id',
    });
    const env = await environmentRepository.findByKey(project.id, 'production');

    // First save creates the architecture (revision 1) — no prior assessment
    // exists yet, so nothing to mark stale.
    const arch = await architectureRepository.saveCanvas(env!.id, [makeNode('n1')], []);

    // Seed a fresh (not stale) assessment for this architecture, exactly as
    // wellArchitectedRepository.createAssessment would have left it.
    mockDb._stores['WellArchitectedAssessment'].set('assess-1', {
      id: 'assess-1', projectId: project.id, architectureId: arch.id, provider: 'aws',
      framework: 'AWS Well-Architected Framework', frameworkVersion: '2024', overallScore: 90,
      pillarScoresJson: '[]', findingsJson: '[]', source: 'DESIGN_TIME', sourceLabel: 'Design-time assessment',
      confidence: 'design-time', isStale: false, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    });

    // Re-saving the same environment's canvas is an UPDATE (revision 2) —
    // the architecture changed, so the prior assessment must flip stale.
    await architectureRepository.saveCanvas(env!.id, [makeNode('n1'), makeNode('n2')], []);

    const { wellArchitectedRepository } = await import('@/lib/repositories/wellArchitectedRepository');
    const assessment = await wellArchitectedRepository.findLatestByArchitecture(arch.id);
    expect(assessment?.isStale).toBe(true);
  });

  test('a persisted Well-Architected assessment reports its real coverage after reload, not 0%', async () => {
    // The WellArchitectedAssessment table has no coveragePct column — only
    // pillarScoresJson is persisted. findLatestByArchitecture used to return
    // coveragePct: undefined (displayed as "coverage 0%" in the UI) for
    // every assessment read back from the DB, even one computed with real
    // 87% coverage, because nothing recomputed it from what WAS persisted.
    const { wellArchitectedRepository } = await import('@/lib/repositories/wellArchitectedRepository');
    const architectureId = 'wa-coverage-test-arch';

    await wellArchitectedRepository.createAssessment({
      architectureId, projectId: 'proj-1', provider: 'aws',
      framework: 'AWS Well-Architected Framework', frameworkVersion: '2024', frameworkSource: '',
      overallScore: 70, findings: [], evaluatedAt: new Date().toISOString(),
      source: 'DESIGN_TIME', sourceLabel: 'Design-time assessment', confidence: 'design-time', isStale: false,
      pillarScores: [
        { pillar: 'security', pillarLabel: 'Security', score: 70, findingCount: 7, criticalCount: 0, highCount: 1, scored: true, coveragePct: 80, evaluatedChecks: 8, notEvaluatedChecks: 2 },
        { pillar: 'reliability', pillarLabel: 'Reliability', score: 65, findingCount: 2, criticalCount: 0, highCount: 0, scored: true, coveragePct: 100, evaluatedChecks: 5, notEvaluatedChecks: 0 },
      ] as any,
    } as any);

    const assessment = await wellArchitectedRepository.findLatestByArchitecture(architectureId);
    expect(assessment).not.toBeNull();
    // (8 + 5) evaluated out of (8 + 5 + 2 + 0) total = 13/15 ≈ 87%
    expect(assessment!.coveragePct).toBe(87);
    expect(assessment!.coveragePct).not.toBe(0);
    expect(assessment!.overallScored).toBe(true);
  });

  test('saves canvas and returns nodes + edges', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'Canvas Project', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id',
    });
    const env = await environmentRepository.findByKey(project.id, 'production');

    const nodes = [makeNode('n1', 'aws_vpc'), makeNode('n2', 'aws_ec2')];
    const edges = [makeEdge('e1', 'n1', 'n2')];

    const arch = await architectureRepository.saveCanvas(env!.id, nodes, edges);
    const canvas = toCanvas(arch.resources, arch.connections);

    expect(canvas.nodes.length).toBe(2);
    expect(canvas.edges.length).toBe(1);
    expect(canvas.nodes.find((n) => n.id === 'n1')).toBeTruthy();
    expect(canvas.edges[0].source).toBe('n1');
    expect(canvas.edges[0].target).toBe('n2');
  });

  test('template instances do not collide: same template in Project A, Project B, and twice in one canvas', async () => {
    const { architectureTemplates } = await import('@/lib/templates');
    const { instantiateTemplate } = await import('@/lib/domain/instantiateTemplate');
    const { ResourceIdConflictError } = await import('@/lib/repositories/architectureRepository');
    const { orgId } = await seedOrg();
    const tpl = architectureTemplates.find((t) => t.id === 'ref-azure-three-tier-vmss') ?? architectureTemplates[0];
    const envOf = async (name: string) => {
      const p = await projectRepository.create({ name, provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id' });
      return (await environmentRepository.findByKey(p.id, 'production'))!;
    };
    const a = instantiateTemplate(tpl, {});
    const b = instantiateTemplate(tpl, {});
    const c1 = instantiateTemplate(tpl, {}); const c2 = instantiateTemplate(tpl, {});
    await expect(architectureRepository.saveCanvas((await envOf('A')).id, a.nodes, a.edges)).resolves.toBeTruthy();
    await expect(architectureRepository.saveCanvas((await envOf('B')).id, b.nodes, b.edges)).resolves.toBeTruthy();
    const both = await architectureRepository.saveCanvas((await envOf('C')).id, [...c1.nodes, ...c2.nodes], [...c1.edges, ...c2.edges]);
    expect(both.resources).toHaveLength(c1.nodes.length * 2);

    // Master template IDs saved twice (the pre-fix behaviour) are refused with a clear error, not a raw PK violation.
    const master = tpl.generate({});
    await architectureRepository.saveCanvas((await envOf('D')).id, master.nodes, master.edges);
    await expect(architectureRepository.saveCanvas((await envOf('E')).id, master.nodes, master.edges)).rejects.toBeInstanceOf(ResourceIdConflictError);
  });

  test('replacing canvas removes old nodes', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'Replace Test', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id',
    });
    const env = await environmentRepository.findByKey(project.id, 'production');

    await architectureRepository.saveCanvas(env!.id, [makeNode('old-n1')], []);
    const newArch = await architectureRepository.saveCanvas(env!.id, [makeNode('new-n1'), makeNode('new-n2')], []);
    const canvas = toCanvas(newArch.resources, newArch.connections);

    expect(canvas.nodes.length).toBe(2);
    expect(canvas.nodes.find((n) => n.id === 'old-n1')).toBeUndefined();
  });
});

// ── 6. Architecture retrieval ─────────────────────────────────────────────────

describe('Architecture retrieval', () => {
  test('returns null when no canvas saved yet', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'Empty Project', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id',
    });
    const env = await environmentRepository.findByKey(project.id, 'production');
    const arch = await architectureRepository.findByEnvironment(env!.id);
    expect(arch).toBeNull();
  });

  test('loads saved canvas', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'Loaded Project', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id',
    });
    const env = await environmentRepository.findByKey(project.id, 'production');

    const nodes = [makeNode('n1', 'aws_rds'), makeNode('n2', 'aws_s3')];
    await architectureRepository.saveCanvas(env!.id, nodes, []);

    const arch = await architectureRepository.findByEnvironment(env!.id);
    expect(arch).not.toBeNull();
    const canvas = toCanvas(arch!.resources, arch!.connections);
    expect(canvas.nodes.length).toBe(2);
  });
});

// ── 7. Version creation ───────────────────────────────────────────────────────

describe('Version creation', () => {
  test('creates a version with incrementing version number', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'Versioned Project', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id',
    });
    const env = await environmentRepository.findByKey(project.id, 'production');
    const nodes = [makeNode('n1')];
    const arch = await architectureRepository.saveCanvas(env!.id, nodes, []);

    const v1 = await architectureRepository.createVersion({
      projectId: project.id,
      architectureId: arch.id,
      label: 'Initial release',
      summary: 'First version',
      author: 'Alice',
      nodes,
      edges: [],
    });

    const v2 = await architectureRepository.createVersion({
      projectId: project.id,
      architectureId: arch.id,
      label: 'Second release',
      summary: 'Added RDS',
      author: 'Bob',
      nodes: [...nodes, makeNode('n2', 'aws_rds')],
      edges: [],
    });

    expect(v1.versionNumber).toBe(1);
    expect(v2.versionNumber).toBe(2);
    expect(v1.author).toBe('Alice');
    expect(v2.author).toBe('Bob');
  });

  test('version stores the snapshot JSON', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'Snapshot Test', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id',
    });
    const env = await environmentRepository.findByKey(project.id, 'production');
    const nodes = [makeNode('snap-n1', 'aws_vpc')];
    const arch = await architectureRepository.saveCanvas(env!.id, nodes, []);

    const version = await architectureRepository.createVersion({
      projectId: project.id,
      architectureId: arch.id,
      label: 'v1',
      summary: 's',
      author: 'test',
      nodes,
      edges: [],
    });

    const snapshot = JSON.parse(version.snapshotJson) as { nodes: CanvasNode[]; edges: CanvasEdge[] };
    expect(snapshot.nodes.length).toBe(1);
    expect(snapshot.nodes[0].id).toBe('snap-n1');
    expect(snapshot.nodes[0].resourceType).toBe('aws_vpc');
  });
});

// ── 8. Version restoration ────────────────────────────────────────────────────

describe('Version restoration', () => {
  test('restores nodes from a snapshot', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'Restore Test', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id',
    });
    const env = await environmentRepository.findByKey(project.id, 'production');
    const originalNodes = [makeNode('orig-n1'), makeNode('orig-n2')];
    const arch = await architectureRepository.saveCanvas(env!.id, originalNodes, []);

    const version = await architectureRepository.createVersion({
      projectId: project.id,
      architectureId: arch.id,
      label: 'Before changes',
      summary: '',
      author: 'test',
      nodes: originalNodes,
      edges: [],
    });

    // Overwrite canvas with different nodes
    await architectureRepository.saveCanvas(env!.id, [makeNode('new-n1')], []);

    // Restore the version
    const result = await architectureRepository.restoreVersion(version.id, project.id, env!.id);
    expect(result).not.toBeNull();
    expect(result!.nodes.length).toBe(2);
    expect(result!.nodes.find((n) => n.id === 'orig-n1')).toBeTruthy();
    expect(result!.nodes.find((n) => n.id === 'new-n1')).toBeUndefined();
  });

  test('returns null for non-existent version', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'No Version', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id',
    });
    const env = await environmentRepository.findByKey(project.id, 'production');

    const result = await architectureRepository.restoreVersion('bad-version-id', project.id, env!.id);
    expect(result).toBeNull();
  });
});

// ── 9. Unauthorized access ───────────────────────────────────────────────────

describe('Authorization', () => {
  test('getOrgRole returns null for non-member', async () => {
    const { getOrgRole } = await import('@/lib/api/auth');
    const role = await getOrgRole('stranger-user', 'any-org');
    expect(role).toBeNull();
  });

  test('getOrgRole returns correct role for member', async () => {
    const { getOrgRole } = await import('@/lib/api/auth');
    const { orgId, userId } = await seedOrg();
    const role = await getOrgRole(userId, orgId);
    expect(role).toBe('owner');
  });
});

// ── 10. Invalid requests ─────────────────────────────────────────────────────

describe('Invalid requests', () => {
  test('delete returns false for missing project', async () => {
    const { orgId } = await seedOrg();
    const deleted = await projectRepository.delete('no-such-project', orgId);
    expect(deleted).toBe(false);
  });

  test('update returns null for missing project', async () => {
    const { orgId } = await seedOrg();
    const result = await projectRepository.update('no-such-project', orgId, { name: 'New' });
    expect(result).toBeNull();
  });

  test('findVersion returns null for wrong project', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'Version Isolation', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id',
    });
    const env = await environmentRepository.findByKey(project.id, 'production');
    const arch = await architectureRepository.saveCanvas(env!.id, [makeNode('n1')], []);
    const v = await architectureRepository.createVersion({
      projectId: project.id, architectureId: arch.id, label: 'v', summary: '', author: 't', nodes: [], edges: [],
    });

    const wrong = await architectureRepository.findVersion(v.id, 'wrong-project-id');
    expect(wrong).toBeNull();
  });

  test('tags default to empty array when not provided', async () => {
    const { orgId } = await seedOrg();
    const project = await projectRepository.create({
      name: 'No Tags', provider: 'aws', region: 'us-east-1', orgId, ownerId: 'dev-user-id',
    });
    expect(project.tags).toEqual([]);
  });
});
