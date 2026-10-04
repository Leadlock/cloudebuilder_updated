/**
 * CloudAccountRepository — all database access for cloud accounts.
 *
 * Security rules:
 * - credentialsJson is encrypted with AES-256-GCM before storage and decrypted only here.
 * - credentialsJson / credentialsEnc is NEVER returned by any public method.
 * - All public-facing methods return DbCloudAccount which omits the credential field.
 * - Callers MUST supply orgId for all operations to enforce org isolation.
 */
import { db } from '@/src/prisma/db';
import { randomUUID as uuidv4 } from 'crypto';
import { encrypt, decrypt } from '@/lib/crypto/credentials';

// ─── Domain types ─────────────────────────────────────────────────────────────

/**
 * Safe cloud account representation — credentialsJson is intentionally absent.
 * This is the only shape that flows outside this repository.
 */
export interface DbCloudAccount {
  id: string;
  orgId: string;
  provider: string;
  name: string;
  // identityJson parsed to object
  identity: Record<string, unknown>;
  status: string;
  lastValidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Internal shape used only within this file for credential reads. */
interface DbCloudAccountWithCredentials extends DbCloudAccount {
  credentialsJson: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Map a raw DB row to the safe DbCloudAccount shape.
 * credentialsJson is explicitly excluded.
 */
function mapAccount(row: {
  id: string;
  orgId: string;
  provider: string;
  name: string;
  identityJson: string;
  status: string;
  lastValidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}): DbCloudAccount {
  return {
    id: row.id,
    orgId: row.orgId,
    provider: row.provider,
    name: row.name,
    identity: parseJson(row.identityJson),
    status: row.status,
    lastValidatedAt: row.lastValidatedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Repository ───────────────────────────────────────────────────────────────

export const cloudAccountRepository = {

  async list(orgId: string): Promise<DbCloudAccount[]> {
    const rows = await db.orm.public.CloudAccount
      .where({ orgId })
      .select('id', 'orgId', 'provider', 'name', 'identityJson', 'status', 'lastValidatedAt', 'createdAt', 'updatedAt')
      .all();
    return rows.map(mapAccount);
  },

  async findById(id: string, orgId: string): Promise<DbCloudAccount | null> {
    const row = await db.orm.public.CloudAccount
      .where({ id, orgId })
      .select('id', 'orgId', 'provider', 'name', 'identityJson', 'status', 'lastValidatedAt', 'createdAt', 'updatedAt')
      .first();
    return row ? mapAccount(row) : null;
  },

  /**
   * Retrieve credentials for a cloud account.
   * This method is intentionally separated from findById so that credential access
   * is explicit and auditable. Only the adapter layer should call this.
   * The returned string must never be forwarded to any API response.
   */
  async getCredentials(id: string, orgId: string): Promise<string | null> {
    const row = await db.orm.public.CloudAccount
      .where({ id, orgId })
      .select('credentialsJson')
      .first();
    if (!row?.credentialsJson) return null;
    // Decrypt the stored ciphertext — throws on tamper/key mismatch.
    return decrypt(row.credentialsJson);
  },

  async create(input: {
    orgId: string;
    provider: string;
    name: string;
    credentialsJson: string;
    /** Plain, non-secret facts about the account (for example how it signs in). Defaults to {}. */
    identityJson?: string;
  }): Promise<DbCloudAccount> {
    const ts = now();
    const id = uuidv4();
    // Encrypt credentials before storage — AES-256-GCM with a random IV per record.
    const credentialsEnc = encrypt(input.credentialsJson);
    await db.orm.public.CloudAccount.create({
      id,
      orgId: input.orgId,
      provider: input.provider,
      name: input.name,
      credentialsJson: credentialsEnc,
      identityJson: input.identityJson ?? '{}',
      status: 'pending',
      lastValidatedAt: null,
      createdAt: ts,
      updatedAt: ts,
    });
    return (await this.findById(id, input.orgId))!;
  },

  async updateStatus(
    id: string,
    orgId: string,
    status: string,
    identityJson?: string,
  ): Promise<DbCloudAccount | null> {
    const existing = await db.orm.public.CloudAccount.where({ id, orgId }).first();
    if (!existing) return null;
    const ts = now();
    await db.orm.public.CloudAccount.where({ id, orgId }).update({
      status,
      lastValidatedAt: ts,
      updatedAt: ts,
      ...(identityJson !== undefined ? { identityJson } : {}),
    });
    return this.findById(id, orgId);
  },

  /**
   * Edit an account: its name and/or its credentials (re-encrypted). New credentials reset the account to "pending" — they have not
   * been checked yet — and the caller checks them straight away.
   */
  async update(id: string, orgId: string, input: { name?: string; credentialsJson?: string; identityJson?: string }): Promise<DbCloudAccount | null> {
    const existing = await db.orm.public.CloudAccount.where({ id, orgId }).first();
    if (!existing) return null;
    const ts = now();
    await db.orm.public.CloudAccount.where({ id, orgId }).update({
      updatedAt: ts,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.credentialsJson !== undefined ? { credentialsJson: encrypt(input.credentialsJson), status: 'pending', lastValidatedAt: null } : {}),
      ...(input.identityJson !== undefined ? { identityJson: input.identityJson } : {}),
    });
    return this.findById(id, orgId);
  },

  async delete(id: string, orgId: string): Promise<boolean> {
    const existing = await db.orm.public.CloudAccount.where({ id, orgId }).first();
    if (!existing) return false;
    await db.orm.public.CloudAccount.where({ id, orgId }).delete();
    return true;
  },

  /** Verify the account belongs to the org — used for authorization checks. */
  async belongsToOrg(id: string, orgId: string): Promise<boolean> {
    const row = await db.orm.public.CloudAccount
      .where({ id, orgId })
      .select('id')
      .first();
    return row !== null;
  },
};
