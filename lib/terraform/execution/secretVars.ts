/**
 * Secret inputs for the generated Terraform (database / admin passwords and the admin SSH public key), passed as
 * TF_VAR_* environment variables so they never appear in the .tf files.
 *
 * In production they MUST be supplied by the operator: falling back to a fixed, publicly known value would deploy real
 * databases and servers with a password anyone reading this repository knows. The fixed values below exist only for
 * local development and are refused when NODE_ENV=production.
 */
const DEV_DEFAULTS: Record<string, string> = {
  TF_VAR_db_password: 'CloudCraft_SecureDbPass123!',
  TF_VAR_sql_admin_password: 'CloudCraft_SqlPass123!',
  TF_VAR_admin_ssh_public_key: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC/0ui7B45zZkM18ZUX8JLFf0MxHaIjnG/UL3bWtrXRo778I5+DkLGgucleDg75VxkqWBdGv2DZuRzdzRHFTPwOc9e1gRs2mCPXcGLIgRhZ4gquPPiU5j6glr4UrSebWfYINXXfrR/KRSJAAwqK+gNJOdUghUPScSK7CS2EEMWdwPnLEbgvynFeKmEfJilRSSRzpivg59WpBh5p1lU7cGu+7m85SCBcrGRCE65ggzTUP8eZuQeLCmNsV8QtuPj9dyO1Aixau15JRaHq2OWL8vgUqHok3bocw2difFfLbT42A2dXFbYgz50+6fltIvdflqeuJlM4AvFrIRFhb1rBqXAB cloudcraft@admin',
  TF_VAR_windows_admin_password: 'CloudCraft_WinPass123!',
};

/** The passwords CloudCraft can generate for a deployment itself (see deploymentSecrets.ts); the SSH public key cannot be generated. */
export const GENERATABLE_SECRETS = ['TF_VAR_db_password', 'TF_VAR_sql_admin_password', 'TF_VAR_windows_admin_password'] as const;

export function terraformSecretVars(except: readonly string[] = []): Record<string, string> {
  const production = process.env['NODE_ENV'] === 'production';
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, devDefault] of Object.entries(DEV_DEFAULTS)) {
    if (except.includes(name)) continue;
    const value = process.env[name];
    if (value) out[name] = value;
    else if (production) missing.push(name);
    else out[name] = devDefault;
  }
  if (missing.length > 0) {
    throw new Error(`Refusing to run Terraform in production without ${missing.join(', ')}. Set them in the server environment; CloudCraft will not fall back to built-in default passwords.`);
  }
  return out;
}
