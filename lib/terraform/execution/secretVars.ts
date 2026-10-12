/**
 * Secret inputs for the generated Terraform (database / admin passwords and the admin SSH public key), passed as
 * TF_VAR_* environment variables so they never appear in the .tf files.
 *
 * There is NO fixed value anywhere, in the generated files or here: a built-in password (or a built-in SSH key) would deploy real
 * databases and servers that anyone who has read this repository can open. In production the operator must supply them. In
 * development a password that is not supplied is generated at random, once per server process, so a local run works and still
 * never uses a value that is written down; the SSH public key cannot be generated (the private half would have to be handed over),
 * so it is left unset in development and Terraform asks for it only for a design that has a Linux VM.
 */
import { randomBytes, randomInt } from 'crypto';

const SECRET_NAMES = ['TF_VAR_db_password', 'TF_VAR_sql_admin_password', 'TF_VAR_admin_ssh_public_key', 'TF_VAR_windows_admin_password'] as const;

/** The passwords CloudCraft can generate for a deployment itself (see deploymentSecrets.ts); the SSH public key cannot be generated. */
export const GENERATABLE_SECRETS = ['TF_VAR_db_password', 'TF_VAR_sql_admin_password', 'TF_VAR_windows_admin_password'] as const;

/** One random password per name for the life of this server process (development only; production never gets here). */
const processPasswords = new Map<string, string>();
function processPassword(name: string): string {
  let v = processPasswords.get(name);
  if (!v) {
    // 24 random bytes as letters and digits, plus one of each kind so SQL Server, RDS and Windows accept it.
    const body = randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');
    v = `Aa1-${body}${randomInt(10)}`;
    processPasswords.set(name, v);
  }
  return v;
}

export function terraformSecretVars(except: readonly string[] = []): Record<string, string> {
  const production = process.env['NODE_ENV'] === 'production';
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of SECRET_NAMES) {
    if (except.includes(name)) continue;
    const value = process.env[name];
    if (value) out[name] = value;
    else if (production) missing.push(name);
    else if ((GENERATABLE_SECRETS as readonly string[]).includes(name)) out[name] = processPassword(name);
    // The SSH public key is simply not provided in development: see the file comment.
  }
  if (missing.length > 0) {
    throw new Error(`Refusing to run Terraform in production without ${missing.join(', ')}. Set them in the server environment; CloudCraft never falls back to a built-in password or key.`);
  }
  return out;
}
