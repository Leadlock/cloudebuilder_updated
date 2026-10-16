/**
 * Uploaded source code (a zip per service), kept until the release that builds it is done. The bytes are what the person uploaded; they are read again
 * with the same safety checks when they are used, and their SHA-256 is part of what the release was approved for.
 */
import { createHash } from 'crypto';
import { sharedDb, type Queryable } from '@/lib/api/sharedStore';

export interface StoredSource { id: string; orgId: string; projectId: string; layer: string; sha256: string; sizeBytes: number; zip: Buffer; expiresAtMs: number }

export interface SourceStore {
  put(s: Omit<StoredSource, 'sha256' | 'sizeBytes'>): Promise<StoredSource>;
  /** The source, or null when it does not exist or has expired. */
  get(id: string, now?: number): Promise<StoredSource | null>;
  /** Removes what has expired. */
  prune(now?: number): Promise<void>;
}

export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** Sources are kept this long after they are uploaded: long enough to plan, approve, wait for secrets and build. */
export const SOURCE_TTL_MS = 3 * 24 * 3600 * 1000;

export class InMemorySourceStore implements SourceStore {
  private readonly rows = new Map<string, StoredSource>();
  async put(s: Omit<StoredSource, 'sha256' | 'sizeBytes'>) { const row = { ...s, zip: Buffer.from(s.zip), sha256: sha256Hex(s.zip), sizeBytes: s.zip.length }; this.rows.set(s.id, row); return { ...row }; }
  async get(id: string, now = Date.now()) { const r = this.rows.get(id); return r && r.expiresAtMs > now ? { ...r, zip: Buffer.from(r.zip) } : null; }
  async prune(now = Date.now()) { for (const [id, r] of this.rows) if (r.expiresAtMs <= now) this.rows.delete(id); }
}

export class PgSourceStore implements SourceStore {
  constructor(private readonly db: () => Queryable = sharedDb) {}
  async put(s: Omit<StoredSource, 'sha256' | 'sizeBytes'>): Promise<StoredSource> {
    const sha256 = sha256Hex(s.zip);
    await this.db().query(
      `INSERT INTO "projectSource" ("id", "orgId", "projectId", "layer", "sha256", "sizeBytes", "dataB64", "createdAtMs", "expiresAtMs") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [s.id, s.orgId, s.projectId, s.layer, sha256, s.zip.length, s.zip.toString('base64'), Date.now(), s.expiresAtMs],
    );
    return { ...s, sha256, sizeBytes: s.zip.length };
  }
  async get(id: string, now = Date.now()): Promise<StoredSource | null> {
    const { rows } = await this.db().query(`SELECT "id", "orgId", "projectId", "layer", "sha256", "sizeBytes", "dataB64", "expiresAtMs" FROM "projectSource" WHERE "id" = $1 AND "expiresAtMs" > $2`, [id, now]);
    const r = rows[0];
    if (!r) return null;
    return { id: String(r['id']), orgId: String(r['orgId']), projectId: String(r['projectId']), layer: String(r['layer']), sha256: String(r['sha256']), sizeBytes: Number(r['sizeBytes']), zip: Buffer.from(String(r['dataB64']), 'base64'), expiresAtMs: Number(r['expiresAtMs']) };
  }
  async prune(now = Date.now()): Promise<void> { await this.db().query(`DELETE FROM "projectSource" WHERE "expiresAtMs" <= $1`, [now]); }
}
