/** Architecture templates in the database (the `architectureTemplate` table). Every read says whose templates it may see: the built-in ones and the organization's own. */
import { randomUUID } from 'crypto';
import { sharedDb, type Queryable } from '@/lib/api/sharedStore';
import { fromRow, graphOf, type StoredTemplate, type StoredTemplateWithGraph, type TemplateRowInput } from './stored';

const SUMMARY = '"id", "orgId", "source", "name", "description", "provider", "category", "complexity", "tagsJson", "featuresJson", "estimatedCost", "resourceCount", "metaJson", "createdBy", "createdAt", "updatedAt"';

export class PgTemplateStore {
  constructor(private readonly db: () => Queryable = sharedDb) {}

  /** The built-in templates and this organization's own, without their graphs (a built-in's graph is large; ask for it by id). */
  async list(orgId: string): Promise<StoredTemplate[]> {
    const { rows } = await this.db().query(`SELECT ${SUMMARY} FROM "architectureTemplate" WHERE "orgId" IS NULL OR "orgId" = $1 ORDER BY "source", "name"`, [orgId]);
    return rows.map(fromRow);
  }

  /** The organization's own templates with their graphs. */
  async listOwn(orgId: string): Promise<StoredTemplateWithGraph[]> {
    const { rows } = await this.db().query(`SELECT ${SUMMARY}, "graphJson" FROM "architectureTemplate" WHERE "orgId" = $1 ORDER BY "updatedAt" DESC`, [orgId]);
    return rows.flatMap((r) => { const graph = graphOf(r); return graph ? [{ ...fromRow(r), graph }] : []; });
  }

  async get(orgId: string, id: string): Promise<StoredTemplateWithGraph | null> {
    const { rows } = await this.db().query(`SELECT ${SUMMARY}, "graphJson" FROM "architectureTemplate" WHERE "id" = $1 AND ("orgId" IS NULL OR "orgId" = $2)`, [id, orgId]);
    const r = rows[0]; const graph = r ? graphOf(r) : null;
    return r && graph ? { ...fromRow(r), graph } : null;
  }

  async countOwn(orgId: string): Promise<number> {
    const { rows } = await this.db().query('SELECT count(*)::int AS n FROM "architectureTemplate" WHERE "orgId" = $1', [orgId]);
    return Number(rows[0]?.['n'] ?? 0);
  }

  async createOwn(orgId: string, createdBy: string, t: { name: string; description: string; provider: string; category: string; tags: string[]; nodes: unknown[]; edges: unknown[] }): Promise<StoredTemplate> {
    const now = new Date().toISOString();
    const id = `org-${randomUUID()}`;
    const { rows } = await this.db().query(
      `INSERT INTO "architectureTemplate" ("id", "orgId", "source", "name", "description", "provider", "category", "complexity", "tagsJson", "featuresJson", "estimatedCost", "resourceCount", "metaJson", "graphJson", "contentHash", "createdBy", "createdAt", "updatedAt")
       VALUES ($1, $2, 'org', $3, $4, $5, $6, $7, $8, '[]', 0, $9, '{}', $10, '', $11, $12, $12) RETURNING ${SUMMARY}`,
      [id, orgId, t.name, t.description, t.provider, t.category, t.nodes.length > 30 ? 'complex' : t.nodes.length > 12 ? 'moderate' : 'simple', JSON.stringify(t.tags), t.nodes.length, JSON.stringify({ nodes: t.nodes, edges: t.edges }), createdBy, now],
    );
    return fromRow(rows[0]!);
  }

  /** Deletes one of the organization's own templates (never a built-in one, and never another organization's). */
  async deleteOwn(orgId: string, id: string): Promise<boolean> {
    const { rows } = await this.db().query('DELETE FROM "architectureTemplate" WHERE "id" = $1 AND "orgId" = $2 RETURNING "id"', [id, orgId]);
    return rows.length > 0;
  }

  async ownerOf(orgId: string, id: string): Promise<string | null | undefined> {
    const { rows } = await this.db().query('SELECT "createdBy" FROM "architectureTemplate" WHERE "id" = $1 AND "orgId" = $2', [id, orgId]);
    return rows.length === 0 ? undefined : (rows[0]!['createdBy'] as string | null);
  }

  // ─── the built-in templates, written from the code ─────────────────────────

  async builtInHashes(): Promise<Map<string, string>> {
    const { rows } = await this.db().query(`SELECT "id", "contentHash" FROM "architectureTemplate" WHERE "source" = 'builtin'`);
    return new Map(rows.map((r) => [String(r['id']), String(r['contentHash'])]));
  }

  async upsertBuiltIn(r: TemplateRowInput): Promise<void> {
    const now = new Date().toISOString();
    await this.db().query(
      `INSERT INTO "architectureTemplate" ("id", "orgId", "source", "name", "description", "provider", "category", "complexity", "tagsJson", "featuresJson", "estimatedCost", "resourceCount", "metaJson", "graphJson", "contentHash", "createdAt", "updatedAt")
       VALUES ($1, NULL, 'builtin', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
       ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "description" = EXCLUDED."description", "provider" = EXCLUDED."provider", "category" = EXCLUDED."category", "complexity" = EXCLUDED."complexity",
         "tagsJson" = EXCLUDED."tagsJson", "featuresJson" = EXCLUDED."featuresJson", "estimatedCost" = EXCLUDED."estimatedCost", "resourceCount" = EXCLUDED."resourceCount", "metaJson" = EXCLUDED."metaJson",
         "graphJson" = EXCLUDED."graphJson", "contentHash" = EXCLUDED."contentHash", "updatedAt" = EXCLUDED."updatedAt"
       WHERE "architectureTemplate"."source" = 'builtin'`,
      [r.id, r.name, r.description, r.provider, r.category, r.complexity, r.tagsJson, r.featuresJson, r.estimatedCost, r.resourceCount, r.metaJson, r.graphJson, r.contentHash, now],
    );
  }

  async deleteBuiltInExcept(keep: string[]): Promise<number> {
    const { rows } = await this.db().query(`DELETE FROM "architectureTemplate" WHERE "source" = 'builtin' AND NOT ("id" = ANY($1::text[])) RETURNING "id"`, [keep]);
    return rows.length;
  }
}
