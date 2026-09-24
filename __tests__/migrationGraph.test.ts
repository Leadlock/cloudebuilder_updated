/**
 * Migration graph consistency. The MARKER_MISMATCH found in 2026-09 happened because the
 * contract was edited (architecture.revision, discoveryRun.relationshipsJson) without a
 * migration and databases were then synced with `db update`, stamping a marker that no
 * migration reached. These checks fail CI before that can recur.
 */
import fs from 'fs';
import path from 'path';

const APP = path.join(__dirname, '..', 'migrations', 'app');
const migrations = fs.readdirSync(APP)
  .filter((d) => /^\d{8}T\d{4}_/.test(d))
  .map((d) => ({ dir: d, ...(JSON.parse(fs.readFileSync(path.join(APP, d, 'migration.json'), 'utf8')) as { from?: string | null; to: string }) }));
const contractHash = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'prisma', 'contract.json'), 'utf8')) as { storage: { storageHash: string } }).storage.storageHash;

describe('migration graph', () => {
  test('the current contract is a node of the migration graph (no un-migrated contract drift)', () => {
    expect(migrations.map((m) => m.to)).toContain(contractHash);
  });

  test('the db ref points at the current contract', () => {
    const ref = JSON.parse(fs.readFileSync(path.join(APP, 'refs', 'db.json'), 'utf8')) as { hash: string };
    expect(ref.hash).toBe(contractHash);
  });

  test('the graph is a single chain from the empty database to the current contract', () => {
    const byFrom = new Map<string | null, typeof migrations>();
    for (const m of migrations) {
      const k = m.from ?? null;
      byFrom.set(k, [...(byFrom.get(k) ?? []), m]);
    }
    for (const [from, list] of byFrom) expect([from, list.length]).toEqual([from, 1]); // no forks
    let at: string | null = null; const seen: string[] = [];
    while (byFrom.has(at)) { const m: (typeof migrations)[number] = byFrom.get(at)![0]; seen.push(m.dir); at = m.to; }
    expect(at).toBe(contractHash);
    expect(seen).toHaveLength(migrations.length);
  });

  test('every node has its contract snapshot (needed to plan from it)', () => {
    for (const m of migrations) expect(fs.existsSync(path.join(__dirname, '..', 'migrations', 'snapshots', m.to, 'contract.json'))).toBe(true);
  });

  test('databases synced with `db update` before this fix (marker a9f4…) have a migration path', () => {
    expect(migrations.some((m) => m.from === 'a9f4a309c0b3e053bf48a5172aa8e2285b8d3113b2fc0b93bb01616856d0462c')).toBe(true);
  });
});
