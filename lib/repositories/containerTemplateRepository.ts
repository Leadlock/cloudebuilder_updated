/**
 * ContainerTemplateRepository: the container configurations an organization saved. Callers authorise first; every query is scoped to the
 * organization it is given, so one organization can never read or change another's.
 */
import { db } from '@/src/prisma/db';
import { randomUUID } from 'crypto';
import { parseStoredConfig, stripSecrets } from '@/lib/engines/containers/stored';
import type { ContainerConfig } from '@/lib/engines/containers/dockerTemplates';

export interface SavedContainerTemplate { id: string; name: string; config: ContainerConfig; createdBy: string; createdAt: string; updatedAt: string }

const now = () => new Date().toISOString();

type Row = { id: string; orgId: string; name: string; configJson: string; createdBy: string; createdAt: string; updatedAt: string };
function toTemplate(row: Row): SavedContainerTemplate | null {
  const config = parseStoredConfig(row.configJson);
  return config ? { id: row.id, name: row.name, config, createdBy: row.createdBy, createdAt: row.createdAt, updatedAt: row.updatedAt } : null;
}

export const containerTemplateRepository = {
  /** Newest first. A row whose stored configuration no longer validates is skipped rather than breaking the list. */
  async list(orgId: string): Promise<SavedContainerTemplate[]> {
    const rows = (await db.orm.public.ContainerTemplate.where({ orgId }).all()) as Row[];
    return rows.map(toTemplate).filter((t): t is SavedContainerTemplate => t !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  async get(orgId: string, id: string): Promise<SavedContainerTemplate | null> {
    const row = (await db.orm.public.ContainerTemplate.where({ id, orgId }).first()) as Row | null;
    return row ? toTemplate(row) : null;
  },
  /** Who saved it, even when its stored configuration no longer validates (so a damaged row can still be deleted); null when there is no such row. */
  async createdBy(orgId: string, id: string): Promise<string | null> {
    const row = (await db.orm.public.ContainerTemplate.where({ id, orgId }).first()) as Row | null;
    return row ? row.createdBy : null;
  },
  async count(orgId: string): Promise<number> {
    return ((await db.orm.public.ContainerTemplate.where({ orgId }).all()) as Row[]).length;
  },
  async create(orgId: string, name: string, config: ContainerConfig, userId: string): Promise<SavedContainerTemplate> {
    const t = now();
    const row: Row = { id: randomUUID(), orgId, name: name.trim(), configJson: JSON.stringify(stripSecrets(config)), createdBy: userId, createdAt: t, updatedAt: t };
    await db.orm.public.ContainerTemplate.create(row);
    return toTemplate(row)!;
  },
  async update(orgId: string, id: string, name: string, config: ContainerConfig): Promise<SavedContainerTemplate | null> {
    const existing = await db.orm.public.ContainerTemplate.where({ id, orgId }).first();
    if (!existing) return null;
    const updatedAt = now();
    await db.orm.public.ContainerTemplate.where({ id, orgId }).update({ name: name.trim(), configJson: JSON.stringify(stripSecrets(config)), updatedAt });
    return this.get(orgId, id);
  },
  async delete(orgId: string, id: string): Promise<boolean> {
    const existing = await db.orm.public.ContainerTemplate.where({ id, orgId }).first();
    if (!existing) return false;
    await db.orm.public.ContainerTemplate.where({ id, orgId }).delete();
    return true;
  },
};
