/**
 * PostgreSQL integration test — uses real DATABASE_URL, no mocks.
 *
 * Runs via:  npx jest --config jest.integration.mjs
 *
 * Isolated from the unit tests (which mock the DB). This file is
 * NOT in __tests__/ so the unit Jest config does not pick it up.
 *
 * Security contract verified here:
 *  - credentialsJson is stored encrypted in the DB (not plaintext)
 *  - getCredentials decrypts correctly
 *  - wrong-org access returns null at every layer
 *  - no credential fields appear in API response shapes
 */

// ─── Load real .env before any imports ───────────────────────────────────────
import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '.env') });

import { Client } from 'pg';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { architectureRepository } from '@/lib/repositories/architectureRepository';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { discoveryRepository } from '@/lib/repositories/discoveryRepository';
import { discoveryImportService } from '@/lib/services/DiscoveryImportService';
import { encrypt, decrypt } from '@/lib/crypto/credentials';

// ─── Guards ───────────────────────────────────────────────────────────────────

const DB_URL = process.env.DATABASE_URL ?? '';
const ENC_KEY = process.env.ENCRYPTION_KEY ?? '';

if (!DB_URL) throw new Error('DATABASE_URL not set — copy .env.example to .env');
if (!ENC_KEY || ENC_KEY.length < 32) throw new Error('ENCRYPTION_KEY not set or too short');

// Unique prefix per test run to avoid collisions
const RUN = Date.now().toString(36);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Direct pg query — used only for low-level column inspection */
async function rawQuery(sql: string, params: unknown[]) {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  const result = await client.query(sql, params as string[]);
  await client.end();
  return result.rows;
}

// ─── Setup: ensure dev context exists ────────────────────────────────────────

let devCtx: { userId: string; orgId: string };
let projectId: string;
let cloudAccountId: string;

beforeAll(async () => {
  devCtx = await orgRepository.ensureDevContext();
}, 15_000);

afterAll(async () => {
  // Clean up test data (cascade deletes handle children)
  if (cloudAccountId) {
    await cloudAccountRepository.delete(cloudAccountId, devCtx.orgId).catch(() => null);
  }
  if (projectId) {
    await projectRepository.delete(projectId, devCtx.orgId).catch(() => null);
  }
}, 15_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PostgreSQL connection', () => {
  it('ensureDevContext returns a valid userId and orgId', () => {
    expect(typeof devCtx.userId).toBe('string');
    expect(devCtx.userId.length).toBeGreaterThan(0);
    expect(typeof devCtx.orgId).toBe('string');
    expect(devCtx.orgId.length).toBeGreaterThan(0);
  });

  it('can query the organization table directly', async () => {
    const rows = await rawQuery('SELECT id FROM "organization" WHERE id = $1', [devCtx.orgId]);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(devCtx.orgId);
  });
});

describe('Project creation and retrieval', () => {
  it('creates a project with three default environments', async () => {
    const project = await projectRepository.create({
      name: `IntegTest-${RUN}`,
      provider: 'aws',
      region: 'us-east-1',
      description: 'Integration test',
      tags: ['test'],
      orgId: devCtx.orgId,
      ownerId: devCtx.userId,
    });
    projectId = project.id;

    expect(project.id.length).toBeGreaterThan(0);
    expect(project.name).toBe(`IntegTest-${RUN}`);
    expect(project.provider).toBe('aws');
    expect(project.environments).toHaveLength(3);
    const keys = project.environments!.map(e => e.envKey).sort();
    expect(keys).toEqual(['development', 'production', 'staging']);
  }, 10_000);

  it('retrieves a project by id within the correct org', async () => {
    const found = await projectRepository.findById(projectId, devCtx.orgId);
    expect(found).not.toBeNull();
    expect(found!.name).toBe(`IntegTest-${RUN}`);
  });

  it('returns null when queried with the wrong orgId (cross-org isolation)', async () => {
    const found = await projectRepository.findById(projectId, 'attacker-org-id');
    expect(found).toBeNull();
  });

  it('lists only projects for the correct org', async () => {
    const projects = await projectRepository.list(devCtx.orgId);
    expect(projects.every(p => p.orgId === devCtx.orgId)).toBe(true);
  });
});

describe('Architecture save and retrieval', () => {
  let environmentId: string;

  beforeAll(async () => {
    const project = await projectRepository.findById(projectId, devCtx.orgId);
    const prodEnv = project!.environments!.find(e => e.envKey === 'production')!;
    environmentId = prodEnv.id;
  });

  it('saves a canvas and retrieves it intact', async () => {
    const nodes = [
      {
        id: `vpc-${RUN}`,
        type: 'cloudNode' as const,
        resourceType: 'aws_vpc',
        provider: 'aws' as const,
        label: 'Integration VPC',
        position: { x: 100, y: 100 },
        config: { cidrBlock: '10.0.0.0/16' },
        region: 'us-east-1' as const,
        locked: false,
      },
      {
        id: `ec2-${RUN}`,
        type: 'cloudNode' as const,
        resourceType: 'aws_ec2',
        provider: 'aws' as const,
        label: 'Integration EC2',
        position: { x: 320, y: 100 },
        config: { instanceType: 't3.medium' },
        region: 'us-east-1' as const,
        locked: false,
      },
    ];
    const edges = [
      { id: `edge-${RUN}`, source: `vpc-${RUN}`, target: `ec2-${RUN}`, edgeType: 'data' as const },
    ];

    const arch = await architectureRepository.saveCanvas(environmentId, nodes, edges);
    expect(arch.resources).toHaveLength(2);
    expect(arch.connections).toHaveLength(1);

    const loaded = await architectureRepository.findByEnvironment(environmentId);
    expect(loaded).not.toBeNull();
    expect(loaded!.resources).toHaveLength(2);
    expect(loaded!.connections).toHaveLength(1);

    const vpc = loaded!.resources.find(r => r.label === 'Integration VPC');
    expect(vpc).toBeDefined();
    expect(JSON.parse(vpc!.configJson).cidrBlock).toBe('10.0.0.0/16');
  }, 15_000);

  it('overwrites canvas on second save (no duplicate resources)', async () => {
    const singleNode = [
      {
        id: `lone-${RUN}`,
        type: 'cloudNode' as const,
        resourceType: 'aws_s3',
        provider: 'aws' as const,
        label: 'Lone S3',
        position: { x: 0, y: 0 },
        config: {},
        locked: false,
      },
    ];
    await architectureRepository.saveCanvas(environmentId, singleNode, []);
    const loaded = await architectureRepository.findByEnvironment(environmentId);
    expect(loaded!.resources).toHaveLength(1);
    expect(loaded!.connections).toHaveLength(0);
  }, 10_000);
});

describe('Environment clone and promote — real PostgreSQL collision prevention', () => {
  let devEnvId: string;
  let stagingEnvId: string;
  let prodEnvId: string;
  const srcNodeIds: string[] = [];
  let srcEdgeId: string;

  beforeAll(async () => {
    const project = await projectRepository.findById(projectId, devCtx.orgId);
    devEnvId = project!.environments!.find(e => e.envKey === 'development')!.id;
    stagingEnvId = project!.environments!.find(e => e.envKey === 'staging')!.id;
    prodEnvId = project!.environments!.find(e => e.envKey === 'production')!.id;

    const vpcId = `dev-vpc-${RUN}`;
    const subnetId = `dev-sub-${RUN}`;
    const ec2Id = `dev-ec2-${RUN}`;
    srcNodeIds.push(vpcId, subnetId, ec2Id);
    srcEdgeId = `dev-edge-${RUN}`;

    const nodes = [
      {
        id: vpcId,
        type: 'cloudNode' as const,
        resourceType: 'aws_vpc',
        provider: 'aws' as const,
        label: 'Dev VPC',
        position: { x: 100, y: 100 },
        config: { cidrBlock: '10.0.0.0/16' },
        region: 'us-east-1' as const,
        locked: false,
      },
      {
        id: subnetId,
        type: 'cloudNode' as const,
        resourceType: 'aws_subnet',
        provider: 'aws' as const,
        label: 'Dev Subnet',
        position: { x: 100, y: 200 },
        config: { cidrBlock: '10.0.1.0/24' },
        region: 'us-east-1' as const,
        groupId: vpcId,
        locked: false,
      },
      {
        id: ec2Id,
        type: 'cloudNode' as const,
        resourceType: 'aws_ec2',
        provider: 'aws' as const,
        label: 'Dev EC2',
        position: { x: 300, y: 200 },
        config: { instanceType: 't3.micro' },
        region: 'us-east-1' as const,
        groupId: subnetId,
        locked: false,
      },
    ];
    const edges = [
      { id: srcEdgeId, source: subnetId, target: ec2Id, edgeType: 'network' as const },
    ];

    await architectureRepository.saveCanvas(devEnvId, nodes, edges);
  });

  it('cloning an environment containing multiple ArchitectureResources succeeds with no PK collision', async () => {
    // Clone development -> staging
    const clonedArch = await architectureRepository.copyArchitecture(devEnvId, stagingEnvId);
    expect(clonedArch).toBeDefined();
    expect(clonedArch.resources).toHaveLength(3);
    expect(clonedArch.connections).toHaveLength(1);
  }, 15_000);

  it('cloned resources receive fresh globally unique IDs (no PK collision with source)', async () => {
    const stagingArch = await architectureRepository.findByEnvironment(stagingEnvId);
    expect(stagingArch).not.toBeNull();
    const clonedIds = stagingArch!.resources.map(r => r.id);

    // None of the cloned IDs should match any source IDs
    for (const srcId of srcNodeIds) {
      expect(clonedIds).not.toContain(srcId);
    }
    // All cloned IDs must be unique among themselves
    const uniqueClonedIds = new Set(clonedIds);
    expect(uniqueClonedIds.size).toBe(3);
  });

  it('cloned connections point to the cloned resource IDs and have fresh edge IDs', async () => {
    const stagingArch = await architectureRepository.findByEnvironment(stagingEnvId);
    const conn = stagingArch!.connections[0];
    expect(conn.id).not.toBe(srcEdgeId);

    const clonedSubnet = stagingArch!.resources.find(r => r.label === 'Dev Subnet')!;
    const clonedEc2 = stagingArch!.resources.find(r => r.label === 'Dev EC2')!;
    expect(conn.sourceId).toBe(clonedSubnet.id);
    expect(conn.targetId).toBe(clonedEc2.id);

    // Also check group hierarchy remapping
    const clonedVpc = stagingArch!.resources.find(r => r.label === 'Dev VPC')!;
    expect(clonedSubnet.groupId).toBe(clonedVpc.id);
    expect(clonedEc2.groupId).toBe(clonedSubnet.id);
  });

  it('source environment resources and connections remain completely unchanged', async () => {
    const devArch = await architectureRepository.findByEnvironment(devEnvId);
    expect(devArch).not.toBeNull();
    expect(devArch!.resources).toHaveLength(3);
    const devIds = devArch!.resources.map(r => r.id);
    for (const srcId of srcNodeIds) {
      expect(devIds).toContain(srcId);
    }
    expect(devArch!.connections).toHaveLength(1);
    expect(devArch!.connections[0].id).toBe(srcEdgeId);
  });

  it('promoting staging to production does not cause PK collision with staging or dev', async () => {
    // Promote staging -> production
    const prodArch = await architectureRepository.copyArchitecture(stagingEnvId, prodEnvId);
    expect(prodArch.resources).toHaveLength(3);
    expect(prodArch.connections).toHaveLength(1);

    const stagingArch = await architectureRepository.findByEnvironment(stagingEnvId);
    const prodIds = prodArch.resources.map(r => r.id);
    const stagingIds = stagingArch!.resources.map(r => r.id);

    // Production IDs must be distinct from both dev and staging
    for (const id of prodIds) {
      expect(srcNodeIds).not.toContain(id);
      expect(stagingIds).not.toContain(id);
    }
  }, 15_000);

  it('re-cloning/overwriting an environment works cleanly without collision', async () => {
    // Re-clone dev -> staging
    const reCloned = await architectureRepository.copyArchitecture(devEnvId, stagingEnvId);
    expect(reCloned.resources).toHaveLength(3);
    expect(reCloned.connections).toHaveLength(1);
  }, 15_000);
});

describe('CloudAccount credential encryption at rest', () => {
  const awsCreds = {
    roleArn: 'arn:aws:iam::123456789012:role/CloudCraftReadOnly',
    externalId: `ext-${RUN}`,
    region: 'us-east-1',
  };

  it('creates a cloud account and returns a safe shape (no credentials)', async () => {
    const account = await cloudAccountRepository.create({
      orgId: devCtx.orgId,
      provider: 'aws',
      name: `AWS-${RUN}`,
      credentialsJson: JSON.stringify(awsCreds),
    });
    cloudAccountId = account.id;

    expect(account.id.length).toBeGreaterThan(0);
    expect(account.provider).toBe('aws');
    // Safe shape must never contain credentials
    expect((account as unknown as Record<string, unknown>)['credentialsJson']).toBeUndefined();
    const serialised = JSON.stringify(account);
    expect(serialised).not.toContain('roleArn');
    expect(serialised).not.toContain(awsCreds.externalId);
  }, 10_000);

  it('stores credentials encrypted in the database (not plaintext)', async () => {
    const rows = await rawQuery('SELECT "credentialsJson" FROM "cloudAccount" WHERE id = $1', [cloudAccountId]);
    expect(rows).toHaveLength(1);
    const raw: string = rows[0].credentialsJson;
    // Must NOT be plaintext JSON
    expect(raw).not.toContain('roleArn');
    expect(raw).not.toContain('123456789012');
    expect(raw).not.toContain(awsCreds.externalId);
    // Must be a base64-encoded ciphertext (longer than any plaintext representation)
    expect(raw.length).toBeGreaterThan(60);
  });

  it('decrypts credentials correctly via getCredentials', async () => {
    const json = await cloudAccountRepository.getCredentials(cloudAccountId, devCtx.orgId);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!) as Record<string, unknown>;
    expect(parsed.roleArn).toBe(awsCreds.roleArn);
    expect(parsed.externalId).toBe(awsCreds.externalId);
    expect(parsed.region).toBe(awsCreds.region);
  });

  it('returns null from getCredentials for wrong org (cross-org isolation)', async () => {
    const result = await cloudAccountRepository.getCredentials(cloudAccountId, 'attacker-org');
    expect(result).toBeNull();
  });

  it('returns null from findById for wrong org', async () => {
    const result = await cloudAccountRepository.findById(cloudAccountId, 'attacker-org');
    expect(result).toBeNull();
  });

  it('list() excludes accounts from other orgs', async () => {
    const accounts = await cloudAccountRepository.list(devCtx.orgId);
    expect(accounts.every(a => a.orgId === devCtx.orgId)).toBe(true);
    expect(accounts.every(a => !('credentialsJson' in a))).toBe(true);
  });
});

describe('Discovery run lifecycle', () => {
  it('runs through pending → running → completed', async () => {
    const run = await discoveryRepository.create(cloudAccountId);
    expect(run.status).toBe('pending');
    expect(run.cloudAccountId).toBe(cloudAccountId);
    expect(run.resources).toEqual([]);

    await discoveryRepository.markRunning(run.id);
    const running = await discoveryRepository.findById(run.id);
    expect(running!.status).toBe('running');

    const resources = [
      {
        providerResourceId: 'vpc-1',
        resourceType: 'vpc' as const,
        provider: 'aws' as const,
        name: 'test-vpc',
        region: 'us-east-1',
        status: 'available',
        configuration: { cidrBlock: '10.0.0.0/16' },
        metadata: {},
      },
    ];
    await discoveryRepository.markCompleted(run.id, resources, { vpc: 1 });
    const completed = await discoveryRepository.findById(run.id);
    expect(completed!.status).toBe('completed');
    expect(completed!.resources).toHaveLength(1);
    expect(completed!.summary.vpc).toBe(1);

    // Resources must not contain credentials
    const resStr = JSON.stringify(completed!.resources);
    expect(resStr).not.toContain('roleArn');
    expect(resStr).not.toContain('credentialsJson');
  }, 15_000);
});

describe('encrypt/decrypt module', () => {
  it('round-trips plaintext correctly', () => {
    const plain = '{"roleArn":"arn:aws:iam::123456789012:role/Test","secret":"val"}';
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it('produces unique ciphertexts (fresh IV per call)', () => {
    const plain = 'same input';
    expect(encrypt(plain)).not.toBe(encrypt(plain));
  });

  it('throws on tampered ciphertext (GCM auth tag verification)', () => {
    const enc = encrypt('sensitive');
    const tampered = enc.slice(0, 10) + 'XXXX' + enc.slice(14);
    expect(() => decrypt(tampered)).toThrow();
  });
});

describe('Real Version History in PostgreSQL', () => {
  it('creates, lists, and restores architecture versions in PostgreSQL', async () => {
    const project = await projectRepository.findById(projectId, devCtx.orgId);
    const prodEnv = project!.environments!.find((e) => e.envKey === 'production')!;

    // 1. Save an initial architecture canvas
    const initialNodes = [
      { id: 'res-vpc-1', type: 'cloudNode', resourceType: 'aws_vpc', provider: 'aws' as const, label: 'Prod VPC', position: { x: 50, y: 50 }, config: { cidr: '10.0.0.0/16' }, locked: false },
      { id: 'res-sub-1', type: 'cloudNode', resourceType: 'aws_subnet', provider: 'aws' as const, label: 'Prod Subnet', position: { x: 100, y: 100 }, config: { cidr: '10.0.1.0/24' }, locked: false },
    ];
    const initialEdges = [
      { id: 'edge-1', source: 'res-vpc-1', target: 'res-sub-1', type: 'cloudEdge' },
    ];
    await architectureRepository.saveCanvas(prodEnv.id, initialNodes, initialEdges);

    const arch = await architectureRepository.findByEnvironment(prodEnv.id);
    expect(arch).not.toBeNull();

    // 2. Create version snapshot in PostgreSQL
    const createdVersion = await architectureRepository.createVersion({
      projectId,
      architectureId: arch!.id,
      label: 'v1.0.0 Baseline',
      summary: 'Initial baseline with VPC and Subnet',
      author: devCtx.userId,
      nodes: initialNodes,
      edges: initialEdges,
    });

    expect(createdVersion.id).toBeDefined();
    expect(createdVersion.versionNumber).toBeGreaterThanOrEqual(1);
    expect(createdVersion.label).toBe('v1.0.0 Baseline');

    // 3. List versions from PostgreSQL
    const versions = await architectureRepository.listVersions(projectId, arch!.id);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    const foundVer = versions.find((v) => v.id === createdVersion.id);
    expect(foundVer).toBeDefined();
    expect(foundVer!.summary).toBe('Initial baseline with VPC and Subnet');

    // 4. Overwrite canvas with new state
    const modifiedNodes = [
      { id: 'res-vpc-1', type: 'cloudNode', resourceType: 'aws_vpc', provider: 'aws' as const, label: 'Prod VPC', position: { x: 50, y: 50 }, config: { cidr: '10.0.0.0/16' }, locked: false },
    ];
    await architectureRepository.saveCanvas(prodEnv.id, modifiedNodes, []);
    const updatedArch = await architectureRepository.findByEnvironment(prodEnv.id);
    expect(updatedArch!.resources).toHaveLength(1);

    // 5. Restore original version snapshot from PostgreSQL
    const restored = await architectureRepository.restoreVersion(createdVersion.id, projectId, prodEnv.id);
    expect(restored).not.toBeNull();
    expect(restored!.nodes).toHaveLength(2);
    expect(restored!.edges).toHaveLength(1);

    // Verify DB canvas reflects the restored state
    const restoredArch = await architectureRepository.findByEnvironment(prodEnv.id);
    expect(restoredArch!.resources).toHaveLength(2);
    expect(restoredArch!.connections).toHaveLength(1);
  }, 15_000);
});

describe('Real Discovery Import into PostgreSQL', () => {
  it('imports discovered infrastructure into PostgreSQL architecture environment', async () => {
    const project = await projectRepository.findById(projectId, devCtx.orgId);
    const devEnv = project!.environments!.find((e) => e.envKey === 'development')!;

    // 1. Create completed discovery run with real resources
    const run = await discoveryRepository.create(cloudAccountId);
    const discoveredItems = [
      {
        providerResourceId: 'vpc-import-real-001',
        resourceType: 'vpc' as const,
        provider: 'aws' as const,
        name: 'discovered-vpc',
        region: 'us-east-1',
        status: 'available',
        configuration: { cidrBlock: '10.50.0.0/16' },
        metadata: {},
      },
      {
        providerResourceId: 'subnet-import-real-002',
        resourceType: 'subnet' as const,
        provider: 'aws' as const,
        name: 'discovered-subnet',
        region: 'us-east-1',
        status: 'available',
        configuration: { cidrBlock: '10.50.1.0/24', vpcId: 'vpc-import-real-001' },
        metadata: {},
      },
      {
        providerResourceId: 'i-import-real-003',
        resourceType: 'ec2-instance' as const,
        provider: 'aws' as const,
        name: 'discovered-ec2',
        region: 'us-east-1',
        status: 'running',
        configuration: { instanceType: 'm5.large', subnetId: 'subnet-import-real-002' },
        metadata: {},
      },
    ];

    await discoveryRepository.markCompleted(run.id, discoveredItems, { vpc: 1, subnet: 1, 'ec2-instance': 1 });

    // 2. Import run into dev environment via discoveryImportService
    const result = await discoveryImportService.importRun(run.id, devEnv.id, false);
    expect(result).not.toBeNull();
    expect(result!.resourceCount).toBe(3);
    expect(result!.nodes).toHaveLength(3);
    expect(result!.edges.length).toBeGreaterThanOrEqual(2);

    // 3. Verify real PostgreSQL DB rows were written
    const dbArch = await architectureRepository.findByEnvironment(devEnv.id);
    expect(dbArch).not.toBeNull();
    expect(dbArch!.resources).toHaveLength(3);
    expect(dbArch!.connections.length).toBeGreaterThanOrEqual(2);

    // Verify types and providers in DB
    const resTypes = dbArch!.resources.map((r) => r.resourceType).sort();
    expect(resTypes).toEqual(['aws_ec2', 'aws_subnet', 'aws_vpc']);
  }, 15_000);
});

