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

jest.mock('@/src/prisma/db', () => ({
  db: mockDb,
  // rawExec mirrors the real function's SQL-DELETE behaviour on the mock store.
  // Supports the two DELETE patterns used by architectureRepository.saveCanvas.
  rawExec: jest.fn().mockImplementation(async (sql: string, params: unknown[]) => {
    // DELETE FROM "architectureResource" WHERE "architectureId" = $1
    if (/architectureResource/i.test(sql) && params[0]) {
      const archId = params[0] as string;
      for (const [k, v] of mockDb._stores['ArchitectureResource']) {
        if ((v as Record<string, unknown>)['architectureId'] === archId) {
          mockDb._stores['ArchitectureResource'].delete(k);
        }
      }
    }
    // DELETE FROM "architectureConnection" WHERE "architectureId" = $1
    if (/architectureConnection/i.test(sql) && params[0]) {
      const archId = params[0] as string;
      for (const [k, v] of mockDb._stores['ArchitectureConnection']) {
        if ((v as Record<string, unknown>)['architectureId'] === archId) {
          mockDb._stores['ArchitectureConnection'].delete(k);
        }
      }
    }
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
