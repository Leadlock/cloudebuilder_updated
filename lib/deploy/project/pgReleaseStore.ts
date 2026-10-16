/**
 * Releases in the database (the `projectRelease` table). The record is kept as JSON next to the few columns that are searched.
 * It holds names, tags, the compose file and the ids of what was created: never a credential or a secret value.
 */
import { sharedDb, type Queryable } from '@/lib/api/sharedStore';
import type { ReleaseStore } from './releaseStore';
import type { Release } from './types';

const COLUMNS = '"dataJson"';

function parse(row: Record<string, unknown> | undefined): Release | null {
  if (!row) return null;
  try { return JSON.parse(String(row['dataJson'])) as Release; } catch { return null; }
}

export class PgReleaseStore implements ReleaseStore {
  constructor(private readonly db: () => Queryable = sharedDb) {}

  async get(id: string): Promise<Release | null> {
    const { rows } = await this.db().query(`SELECT ${COLUMNS} FROM "projectRelease" WHERE "id" = $1`, [id]);
    return parse(rows[0]);
  }

  /**
   * Creates or replaces a release. A release that was cancelled stays cancelled: a worker that is still running a step cannot write over the
   * person's cancel (the database decides, not the order the two writes arrive in).
   */
  async save(r: Release): Promise<void> {
    await this.db().query(
      `INSERT INTO "projectRelease" ("id", "orgId", "projectId", "environment", "project", "target", "bundleHash", "planId", "planHash", "imageTag", "status", "createdBy", "createdAtMs", "updatedAtMs", "dataJson")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT ("id") DO UPDATE SET
         "planId" = EXCLUDED."planId", "planHash" = EXCLUDED."planHash", "status" = EXCLUDED."status", "updatedAtMs" = EXCLUDED."updatedAtMs", "dataJson" = EXCLUDED."dataJson"
       WHERE "projectRelease"."status" <> 'cancelled' OR EXCLUDED."status" = 'cancelled'`,
      [r.id, r.orgId, r.projectId, r.environment, r.project, r.target, r.bundleHash, r.planId, r.planHash, r.imageTag, r.status, r.createdBy, r.createdAt, r.updatedAt, JSON.stringify(r)],
    );
  }

  async latestSucceeded(projectId: string, environment: string): Promise<Release | null> {
    const { rows } = await this.db().query(
      `SELECT ${COLUMNS} FROM "projectRelease" WHERE "projectId" = $1 AND "environment" = $2 AND "status" = 'succeeded' ORDER BY "updatedAtMs" DESC LIMIT 1`,
      [projectId, environment],
    );
    return parse(rows[0]);
  }

  /** The releases of a project's environment, newest first. */
  async list(projectId: string, environment: string, limit = 20): Promise<Release[]> {
    const { rows } = await this.db().query(
      `SELECT ${COLUMNS} FROM "projectRelease" WHERE "projectId" = $1 AND "environment" = $2 ORDER BY "updatedAtMs" DESC LIMIT $3`,
      [projectId, environment, Math.min(Math.max(1, limit), 100)],
    );
    return rows.map(parse).filter((x): x is Release => x !== null);
  }
}
