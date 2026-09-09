/**
 * OrganizationRepository — DB access for users and organizations.
 */
import { db } from '@/src/prisma/db';
import { randomUUID as uuidv4 } from 'crypto';

export interface DbUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DbOrganization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

function now() { return new Date().toISOString(); }

export const orgRepository = {

  async findOrg(id: string): Promise<DbOrganization | null> {
    const row = await db.orm.public.Organization
      .where({ id })
      .select('id', 'name', 'slug', 'createdAt', 'updatedAt')
      .first();
    return row ?? null;
  },

  async findOrgBySlug(slug: string): Promise<DbOrganization | null> {
    const row = await db.orm.public.Organization
      .where({ slug })
      .select('id', 'name', 'slug', 'createdAt', 'updatedAt')
      .first();
    return row ?? null;
  },

  async createOrg(input: { name: string; slug: string }): Promise<DbOrganization> {
    const ts = now();
    const id = uuidv4();
    await db.orm.public.Organization.create({ id, name: input.name, slug: input.slug, createdAt: ts, updatedAt: ts });
    return { id, ...input, createdAt: ts, updatedAt: ts };
  },

  async findUser(id: string): Promise<DbUser | null> {
    const row = await db.orm.public.User
      .where({ id })
      .select('id', 'email', 'name', 'avatarUrl', 'createdAt', 'updatedAt')
      .first();
    if (!row) return null;
    return { ...row, name: row.name ?? null, avatarUrl: row.avatarUrl ?? null };
  },

  async upsertUser(input: { id: string; email: string; name?: string }): Promise<DbUser> {
    const existing = await this.findUser(input.id);
    if (existing) return existing;
    const ts = now();
    await db.orm.public.User.create({
      id: input.id, email: input.email, name: input.name ?? null,
      avatarUrl: null, createdAt: ts, updatedAt: ts,
    });
    return { id: input.id, email: input.email, name: input.name ?? null, avatarUrl: null, createdAt: ts, updatedAt: ts };
  },

  async addMember(orgId: string, userId: string, role = 'member'): Promise<void> {
    const existing = await db.orm.public.OrgMember
      .where({ orgId, userId })
      .first();
    if (existing) return;
    await db.orm.public.OrgMember.create({ id: uuidv4(), orgId, userId, role });
  },

  async ensureDevContext(): Promise<{ userId: string; orgId: string }> {
    const userId = 'dev-user-id';
    const orgSlug = 'dev-org';

    let user = await this.findUser(userId);
    if (!user) {
      user = await this.upsertUser({ id: userId, email: 'dev@cloudcraft.local', name: 'Dev User' });
    }

    let org = await this.findOrgBySlug(orgSlug);
    if (!org) {
      org = await this.createOrg({ name: 'Dev Organization', slug: orgSlug });
    }

    await this.addMember(org.id, userId, 'owner');
    return { userId, orgId: org.id };
  },
};
