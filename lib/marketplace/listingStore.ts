/** Marketplace listing details per template and organization (the `templateListing` table). Every read and write is scoped to one organization. */
import { sharedDb, type Queryable } from '@/lib/api/sharedStore';
import { ListingSchema } from './listingSchema';
import type { TemplateListing } from './neozaar';

const parse = (json: unknown): TemplateListing | null => {
  try { const r = ListingSchema.safeParse(JSON.parse(String(json))); return r.success ? r.data : null; } catch { return null; }
};

export class PgListingStore {
  constructor(private readonly db: () => Queryable = sharedDb) {}

  /** The organization's listings by template id. A damaged row is skipped rather than breaking the export. */
  async forOrg(orgId: string): Promise<Map<string, TemplateListing>> {
    const { rows } = await this.db().query('SELECT "templateId", "listingJson" FROM "templateListing" WHERE "orgId" = $1', [orgId]);
    const out = new Map<string, TemplateListing>();
    for (const r of rows) { const l = parse(r['listingJson']); if (l) out.set(String(r['templateId']), l); }
    return out;
  }

  async get(orgId: string, templateId: string): Promise<{ listing: TemplateListing; updatedAt: string; updatedBy: string } | null> {
    const { rows } = await this.db().query('SELECT "listingJson", "updatedAt", "updatedBy" FROM "templateListing" WHERE "id" = $1 AND "orgId" = $2', [`${orgId}:${templateId}`, orgId]);
    const r = rows[0]; const l = r ? parse(r['listingJson']) : null;
    return r && l ? { listing: l, updatedAt: String(r['updatedAt']), updatedBy: String(r['updatedBy']) } : null;
  }

  async put(orgId: string, templateId: string, listing: TemplateListing, updatedBy: string): Promise<void> {
    await this.db().query(
      `INSERT INTO "templateListing" ("id", "orgId", "templateId", "listingJson", "updatedBy", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ("id") DO UPDATE SET "listingJson" = EXCLUDED."listingJson", "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = EXCLUDED."updatedAt"`,
      [`${orgId}:${templateId}`, orgId, templateId, JSON.stringify(listing), updatedBy, new Date().toISOString()],
    );
  }

  async delete(orgId: string, templateId: string): Promise<boolean> {
    const { rows } = await this.db().query('DELETE FROM "templateListing" WHERE "id" = $1 AND "orgId" = $2 RETURNING "id"', [`${orgId}:${templateId}`, orgId]);
    return rows.length > 0;
  }
}
