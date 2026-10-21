/** API keys in the database (the `apiKey` table). Only hashes are stored; every read of a list is scoped to one organization. */
import { randomUUID } from 'crypto';
import { sharedDb, type Queryable } from '@/lib/api/sharedStore';
import type { ApiKeyRecord } from './keys';

const COLUMNS = '"id", "orgId", "name", "keyPrefix", "scope", "includeBuiltin", "includeOwn", "createdBy", "createdAt", "expiresAt", "lastUsedAt", "revokedAt"';

function toRecord(r: Record<string, unknown>): ApiKeyRecord {
  const s = (v: unknown) => (v == null ? null : String(v));
  return {
    id: String(r['id']), orgId: String(r['orgId']), name: String(r['name']), keyPrefix: String(r['keyPrefix']), scope: String(r['scope']),
    includeBuiltin: r['includeBuiltin'] === true, includeOwn: r['includeOwn'] === true, createdBy: String(r['createdBy']), createdAt: String(r['createdAt']),
    expiresAt: s(r['expiresAt']), lastUsedAt: s(r['lastUsedAt']), revokedAt: s(r['revokedAt']),
  };
}

export class PgApiKeyStore {
  constructor(private readonly db: () => Queryable = sharedDb) {}

  async create(k: { orgId: string; name: string; prefix: string; hash: string; scope: string; includeBuiltin: boolean; includeOwn: boolean; createdBy: string; expiresAt: string | null }): Promise<ApiKeyRecord> {
    const { rows } = await this.db().query(
      `INSERT INTO "apiKey" ("id", "orgId", "name", "keyPrefix", "keyHash", "scope", "includeBuiltin", "includeOwn", "createdBy", "createdAt", "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLUMNS}`,
      [randomUUID(), k.orgId, k.name, k.prefix, k.hash, k.scope, k.includeBuiltin, k.includeOwn, k.createdBy, new Date().toISOString(), k.expiresAt],
    );
    return toRecord(rows[0]!);
  }

  /** The organization's keys, newest first, revoked ones included (so the list shows what happened). */
  async list(orgId: string): Promise<ApiKeyRecord[]> {
    const { rows } = await this.db().query(`SELECT ${COLUMNS} FROM "apiKey" WHERE "orgId" = $1 ORDER BY "createdAt" DESC`, [orgId]);
    return rows.map(toRecord);
  }

  async countActive(orgId: string): Promise<number> {
    const { rows } = await this.db().query(`SELECT count(*)::int AS n FROM "apiKey" WHERE "orgId" = $1 AND "revokedAt" IS NULL`, [orgId]);
    return Number(rows[0]?.['n'] ?? 0);
  }

  /** Revokes a key of this organization. False when there is no such key, or it was already revoked. */
  async revoke(orgId: string, id: string): Promise<boolean> {
    const { rows } = await this.db().query(`UPDATE "apiKey" SET "revokedAt" = $3 WHERE "id" = $1 AND "orgId" = $2 AND "revokedAt" IS NULL RETURNING "id"`, [id, orgId, new Date().toISOString()]);
    return rows.length > 0;
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const { rows } = await this.db().query(`SELECT ${COLUMNS} FROM "apiKey" WHERE "keyHash" = $1`, [hash]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Notes that a key was used (at most once a minute, so a busy client does not write on every request). */
  async touch(id: string): Promise<void> {
    const now = new Date();
    await this.db().query(`UPDATE "apiKey" SET "lastUsedAt" = $2 WHERE "id" = $1 AND ("lastUsedAt" IS NULL OR "lastUsedAt" < $3)`, [id, now.toISOString(), new Date(now.getTime() - 60_000).toISOString()]);
  }
}
