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
import { encrypt, decrypt, inspectCiphertext } from '@/lib/crypto/credentials';
import { CredentialsExpiredError, applyLifetimeChange, lifetimeMirror, remainingMs, type LifetimeChange, type WipeReason } from '@/lib/cloud/credentialLifetime';

/**
 * What a stored credential is bound to. Part of the encrypted data's authentication, so a value copied into another account or
 * another organisation can never be decrypted there.
 */
const EXPIRY_SWEEP_EVERY_MS = process.env.NODE_ENV === 'test' ? 0 : 60_000;
const lastExpirySweep = new Map<string, number>();

export const credentialContext = (orgId: string, accountId: string): string => `cloud-account:${orgId}:${accountId}`;

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
    // Decrypt the stored ciphertext — throws on tamper, wrong key, or data that belongs to a different account.
    const plain = decrypt(row.credentialsJson, credentialContext(orgId, id));

    // A credential with a time limit is enforced here, where every use of it passes: past its deadline (or already erased) it is
    // never returned, and the secret is erased from the database.
    const parsed = parseJson(plain);
    if (parsed['expired'] === true) throw new CredentialsExpiredError((parsed['reason'] as WipeReason) ?? 'expired', parsed['at'] as string | undefined);
    const left = remainingMs(parsed['expiresAt'] as string | undefined);
    if (left !== null && left <= 0) {
      await this.wipeCredentials(id, orgId, 'expired', parsed['expiresAt'] as string);
      throw new CredentialsExpiredError('expired', parsed['expiresAt'] as string);
    }

    // Data written by an older version (no key id, not bound to this account) is upgraded the first time it is read.
    if (!inspectCiphertext(row.credentialsJson).current) {
      try {
        await db.orm.public.CloudAccount.where({ id, orgId }).update({ credentialsJson: encrypt(plain, credentialContext(orgId, id)) });
      } catch { /* best effort: the next read tries again */ }
    }
    return plain;
  },

  /**
   * Erases the secret. The account stays listed (marked expired) so the person can see what happened and reconnect; what is
   * stored afterwards is only a note that the credentials are gone.
   */
  async wipeCredentials(id: string, orgId: string, reason: WipeReason, at: string = now()): Promise<void> {
    const existing = await db.orm.public.CloudAccount.where({ id, orgId }).first();
    if (!existing) return;
    const identity = parseJson(existing.identityJson);
    await db.orm.public.CloudAccount.where({ id, orgId }).update({
      credentialsJson: encrypt(JSON.stringify({ expired: true, reason, at }), credentialContext(orgId, id)),
      identityJson: JSON.stringify({ ...identity, expired: true, expiredReason: reason, expiredAt: at }),
      status: 'expired',
      updatedAt: now(),
    });
  },

  /**
   * Erases the credentials of every account in the organisation whose time is up (decided from the plain mirror, without decrypting).
   * Runs at most once a minute per organisation: it costs a database round trip and every use of a credential checks its deadline anyway.
   */
  async expireDue(orgId: string, force = false): Promise<number> {
    const last = lastExpirySweep.get(orgId) ?? 0;
    if (!force && Date.now() - last < EXPIRY_SWEEP_EVERY_MS) return 0;
    lastExpirySweep.set(orgId, Date.now());
    const rows = await db.orm.public.CloudAccount.where({ orgId }).select('id', 'identityJson').all();
    let wiped = 0;
    for (const r of rows) {
      const identity = parseJson(r.identityJson);
      const expiresAt = (identity['lifetime'] as { expiresAt?: string } | undefined)?.expiresAt;
      const left = remainingMs(expiresAt);
      if (identity['expired'] !== true && left !== null && left <= 0) { await this.wipeCredentials(r.id, orgId, 'expired', expiresAt); wiped++; }
    }
    return wiped;
  },

  /** For an account set to "forget after a successful deployment": erases the credentials now. True when it did. */
  async forgetAfterDeploy(id: string, orgId: string): Promise<boolean> {
    const row = await db.orm.public.CloudAccount.where({ id, orgId }).select('identityJson').first();
    if (!row) return false;
    const lifetime = parseJson(row.identityJson)['lifetime'] as { forgetAfterDeploy?: boolean } | undefined;
    if (lifetime?.forgetAfterDeploy !== true) return false;
    await this.wipeCredentials(id, orgId, 'forgotten');
    return true;
  },

  /**
   * Changes how long the stored credentials are kept (extend, remove the limit, or erase after the next successful deployment)
   * without asking for the key again. Re-encrypts the credentials and keeps the plain mirror in step. Throws
   * CredentialsExpiredError if they are already gone. Returns null when the account does not exist.
   */
  async changeLifetime(id: string, orgId: string, change: LifetimeChange): Promise<{ ok: true; account: DbCloudAccount } | { ok: false; message: string } | null> {
    const row = await db.orm.public.CloudAccount.where({ id, orgId }).first();
    if (!row) return null;
    const plain = await this.getCredentials(id, orgId);
    if (!plain) return null;
    const result = applyLifetimeChange(parseJson(plain), change);
    if (!result.ok) return result;
    const identity = parseJson(row.identityJson);
    delete identity['lifetime'];
    await db.orm.public.CloudAccount.where({ id, orgId }).update({
      credentialsJson: encrypt(JSON.stringify(result.credentials), credentialContext(orgId, id)),
      identityJson: JSON.stringify({ ...identity, ...lifetimeMirror(result.credentials) }),
      updatedAt: now(),
    });
    return { ok: true, account: (await this.findById(id, orgId))! };
  },

  /** Every stored credential value with the account it belongs to (never returned by an API: used by key rotation). */
  async listForRotation(orgId?: string): Promise<{ id: string; orgId: string; credentialsJson: string }[]> {
    const rows = await (orgId ? db.orm.public.CloudAccount.where({ orgId }) : db.orm.public.CloudAccount).select('id', 'orgId', 'credentialsJson').all();
    return rows.map((r) => ({ id: r.id, orgId: r.orgId, credentialsJson: r.credentialsJson }));
  },

  /** Replaces one stored value with an already re-encrypted one (used by key rotation). */
  async replaceEncrypted(id: string, orgId: string, credentialsJson: string): Promise<void> {
    await db.orm.public.CloudAccount.where({ id, orgId }).update({ credentialsJson });
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
    // Encrypt credentials before storage — AES-256-GCM with a random IV per record, bound to this account and organisation.
    const credentialsEnc = encrypt(input.credentialsJson, credentialContext(input.orgId, id));
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
      ...(input.credentialsJson !== undefined ? { credentialsJson: encrypt(input.credentialsJson, credentialContext(orgId, id)), status: 'pending', lastValidatedAt: null } : {}),
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
