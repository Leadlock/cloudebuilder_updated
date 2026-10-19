/**
 * Passwords for what CloudBuilder deploys (database and admin passwords), generated per cloud account instead of one shared value.
 *
 * Before: every deployment used TF_VAR_db_password from the server environment, or in development a fixed value written in this
 * repository. Now, unless the operator set the variable themselves (which always wins), CloudBuilder generates a random password the
 * first time an account is deployed to, stores it encrypted (bound to the account, like the credentials), and reuses it for every
 * later plan, apply and teardown so the database password does not change under a running system. An owner or admin can read it
 * back to connect to the database (see the deployment-secrets route).
 */
import { randomInt } from 'crypto';
import { encrypt, decrypt } from '@/lib/crypto/credentials';
import { GENERATABLE_SECRETS, terraformSecretVars } from './secretVars';

/** Where generated passwords are kept. */
export interface DeploymentSecretStore {
  get(orgId: string, cloudAccountId: string, name: string): Promise<string | null>;
  put(orgId: string, cloudAccountId: string, name: string, value: string): Promise<void>;
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';
// Symbols every engine accepts: RDS refuses / " @ and spaces; shells and URLs are happier without more than these.
const SYMBOL = '-_.~!#%^*+=';

/** 32 random characters with at least one of each kind, so it satisfies the complexity rules of RDS, SQL Server and Windows. */
export function generatePassword(length = 32): string {
  const all = UPPER + LOWER + DIGIT + SYMBOL;
  const pick = (set: string) => set[randomInt(set.length)]!;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {   // Fisher-Yates, so the guaranteed kinds are not always first
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export const secretContext = (orgId: string, cloudAccountId: string, name: string): string => `deployment-secret:${orgId}:${cloudAccountId}:${name}`;

/** The environment variables Terraform needs for this account: the operator's values where set, generated and remembered ones otherwise. */
export async function terraformSecretVarsFor(orgId: string, cloudAccountId: string, store: DeploymentSecretStore = databaseStore): Promise<Record<string, string>> {
  const production = process.env['NODE_ENV'] === 'production';
  const out: Record<string, string> = {};
  for (const name of GENERATABLE_SECRETS) {
    const supplied = process.env[name];
    if (supplied) { out[name] = supplied; continue; }
    try {
      out[name] = (await store.get(orgId, cloudAccountId, name)) ?? await createOnce(store, orgId, cloudAccountId, name);
    } catch (err) {
      // Production never falls back to a value that is written down somewhere; development keeps working without the table.
      if (production) throw new Error(`CloudBuilder could not read or save the generated ${name.replace('TF_VAR_', '')}: ${err instanceof Error ? err.message : String(err)}. Run the database update (npm run db:update), or set ${name} in the server environment.`);
      return terraformSecretVars();
    }
  }
  // The SSH public key cannot be generated (the private half would have to be handed to the person): it comes from the environment.
  return { ...terraformSecretVars(GENERATABLE_SECRETS), ...out };
}

/** Saves a new password; if another run saved one at the same moment, uses that one so every run agrees. */
async function createOnce(store: DeploymentSecretStore, orgId: string, cloudAccountId: string, name: string): Promise<string> {
  const fresh = generatePassword();
  try {
    await store.put(orgId, cloudAccountId, name, fresh);
    return fresh;
  } catch (err) {
    const other = await store.get(orgId, cloudAccountId, name);
    if (other) return other;
    throw err;
  }
}

/** The passwords CloudBuilder generated for an account, for an owner or admin to read back. Never includes operator-supplied values. */
export async function generatedSecretsFor(orgId: string, cloudAccountId: string, store: DeploymentSecretStore = databaseStore): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of GENERATABLE_SECRETS) {
    const v = await store.get(orgId, cloudAccountId, name);
    if (v) out[name.replace('TF_VAR_', '')] = v;
  }
  return out;
}

const databaseStore: DeploymentSecretStore = {
  async get(orgId, cloudAccountId, name) {
    const { db } = await import('@/src/prisma/db');
    const row = await db.orm.public.DeploymentSecret.where({ id: `${cloudAccountId}:${name}`, orgId }).first();
    return row ? decrypt(row.valueEnc, secretContext(orgId, cloudAccountId, name)) : null;
  },
  async put(orgId, cloudAccountId, name, value) {
    const { db } = await import('@/src/prisma/db');
    await db.orm.public.DeploymentSecret.create({
      id: `${cloudAccountId}:${name}`, orgId, cloudAccountId, name,
      valueEnc: encrypt(value, secretContext(orgId, cloudAccountId, name)),
      createdAt: new Date().toISOString(),
    });
  },
};
