/**
 * OrganizationRepository — DB access for users and organizations.
 */
import { db } from '@/src/prisma/db';
import { randomUUID as uuidv4, randomBytes } from 'crypto';

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

export interface DbOrgMember {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

export interface DbOrgInvite {
  id: string;
  orgId: string;
  email: string;
  role: string;
  token: string;
  invitedByUserId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function now() { return new Date().toISOString(); }

/** URL-safe slug from an org name, deduped with a short random suffix. */
function slugify(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'org';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

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

  /** For re-checking a password before a dangerous action. The hash never leaves the server-side callers. */
  async getPasswordHashById(id: string): Promise<string | null> {
    const row = await db.orm.public.User.where({ id }).select('passwordHash').first();
    return row?.passwordHash ?? null;
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
    const { forgetMembership } = await import('@/lib/api/auth');
    forgetMembership(userId);       // a cached "not a member" must not outlive the invitation being accepted
  },

  async ensureDevContext(): Promise<{ userId: string; orgId: string }> {
    const userId = 'dev-user-id';
    const orgSlug = 'dev-org';

    let user = await this.findUser(userId);
    if (!user) {
      user = await this.upsertUser({ id: userId, email: 'dev@cloudbuilder.local', name: 'Dev User' });
    }

    let org = await this.findOrgBySlug(orgSlug);
    if (!org) {
      org = await this.createOrg({ name: 'Dev Organization', slug: orgSlug });
    }

    await this.addMember(org.id, userId, 'owner');
    return { userId, orgId: org.id };
  },

  // ── Auth: password-based accounts ────────────────────────────────────────

  /**
   * Auth-only lookup — the only place `passwordHash` leaves the DB layer.
   * Never expose this row shape outside authentication code.
   */
  async findUserByEmailForAuth(email: string): Promise<(DbUser & { passwordHash: string | null }) | null> {
    const row = await db.orm.public.User
      .where({ email: email.trim().toLowerCase() })
      .select('id', 'email', 'name', 'avatarUrl', 'passwordHash', 'createdAt', 'updatedAt')
      .first();
    return row ?? null;
  },

  async createUserWithPassword(input: { email: string; name: string; passwordHash: string }): Promise<DbUser> {
    const ts = now();
    const id = uuidv4();
    const email = input.email.trim().toLowerCase();
    await db.orm.public.User.create({
      id, email, name: input.name, avatarUrl: null,
      passwordHash: input.passwordHash, createdAt: ts, updatedAt: ts,
    });
    return { id, email, name: input.name, avatarUrl: null, createdAt: ts, updatedAt: ts };
  },

  async findUserByEmail(email: string): Promise<DbUser | null> {
    const row = await db.orm.public.User
      .where({ email: email.trim().toLowerCase() })
      .select('id', 'email', 'name', 'avatarUrl', 'createdAt', 'updatedAt')
      .first();
    if (!row) return null;
    return { ...row, name: row.name ?? null, avatarUrl: row.avatarUrl ?? null };
  },

  async updatePassword(email: string, passwordHash: string): Promise<boolean> {
    const ts = now();
    const existing = await this.findUserByEmail(email);
    if (!existing) return false;
    await db.orm.public.User
      .where({ id: existing.id })
      .update({ passwordHash, updatedAt: ts });
    return true;
  },

  async syncCognitoUser(input: { id?: string; email: string; name?: string; orgName?: string }): Promise<DbUser> {
    const email = input.email.trim().toLowerCase();
    let user = await this.findUserByEmail(email);
    if (!user && input.id) {
      user = await this.findUser(input.id);
    }

    if (!user) {
      const ts = now();
      const id = input.id || uuidv4();
      await db.orm.public.User.create({
        id,
        email,
        name: input.name ?? null,
        avatarUrl: null,
        passwordHash: null,
        createdAt: ts,
        updatedAt: ts,
      });
      user = { id, email, name: input.name ?? null, avatarUrl: null, createdAt: ts, updatedAt: ts };

      const orgName = input.orgName || (input.name ? `${input.name}'s Workspace` : 'My Organization');
      const org = await this.createOrgForSignup(orgName);
      await this.addMember(org.id, user.id, 'owner');
    } else {
      const members = await db.orm.public.OrgMember.where({ userId: user.id }).first();
      if (!members) {
        const orgName = input.orgName || (input.name ? `${input.name}'s Workspace` : 'My Organization');
        const org = await this.createOrgForSignup(orgName);
        await this.addMember(org.id, user.id, 'owner');
      }
    }
    return user;
  },

  /** Creates a fresh org with a generated unique slug — the signup path (vs. `createOrg`, used when the caller already has a slug). */
  async createOrgForSignup(name: string): Promise<DbOrganization> {
    return this.createOrg({ name, slug: slugify(name) });
  },

  async listOrgMembers(orgId: string): Promise<DbOrgMember[]> {
    const members = await db.orm.public.OrgMember.where({ orgId }).select('userId', 'role').all();
    const users = await Promise.all(members.map((m) => this.findUser(m.userId)));
    return members.map((m, i) => ({
      userId: m.userId,
      role: m.role,
      email: users[i]?.email ?? 'unknown',
      name: users[i]?.name ?? null,
    }));
  },

  // ── Auth: org invites ────────────────────────────────────────────────────

  async createInvite(input: { orgId: string; email: string; role: string; invitedByUserId: string }): Promise<DbOrgInvite> {
    const ts = now();
    const id = uuidv4();
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    const email = input.email.trim().toLowerCase();
    await db.orm.public.OrgInvite.create({
      id, orgId: input.orgId, email, role: input.role, token,
      invitedByUserId: input.invitedByUserId, createdAt: ts, expiresAt, acceptedAt: null,
    });
    return { id, orgId: input.orgId, email, role: input.role, token, invitedByUserId: input.invitedByUserId, createdAt: ts, expiresAt, acceptedAt: null };
  },

  async findInviteByToken(token: string): Promise<DbOrgInvite | null> {
    const row = await db.orm.public.OrgInvite.where({ token }).first();
    return row ?? null;
  },

  async markInviteAccepted(token: string): Promise<void> {
    await db.orm.public.OrgInvite.where({ token }).update({ acceptedAt: now() });
  },

  async listPendingOrgInvites(orgId: string): Promise<DbOrgInvite[]> {
    const rows = await db.orm.public.OrgInvite.where({ orgId, acceptedAt: null }).all();
    return rows.filter((r) => new Date(r.expiresAt).getTime() > Date.now());
  },
};
