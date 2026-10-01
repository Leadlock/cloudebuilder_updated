import { terraformSecretVars } from '@/lib/terraform/execution/secretVars';

const NAMES = ['TF_VAR_db_password', 'TF_VAR_sql_admin_password', 'TF_VAR_admin_ssh_public_key', 'TF_VAR_windows_admin_password'];
const saved: Record<string, string | undefined> = {};
const env = process.env as Record<string, string | undefined>;
beforeEach(() => { for (const k of [...NAMES, 'NODE_ENV']) saved[k] = env[k]; NAMES.forEach((k) => delete env[k]); });
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete env[k]; else env[k] = v; } });

describe('terraformSecretVars', () => {
  it('uses development placeholders outside production', () => {
    env.NODE_ENV = 'development';
    const v = terraformSecretVars();
    expect(Object.keys(v).sort()).toEqual([...NAMES].sort());
  });

  it('refuses to fall back to the built-in passwords in production', () => {
    env.NODE_ENV = 'production';
    expect(() => terraformSecretVars()).toThrow(/Refusing to run Terraform in production/);
  });

  it('passes operator-supplied values through untouched in production', () => {
    env.NODE_ENV = 'production';
    NAMES.forEach((k, i) => { env[k] = `operator-value-${i}`; });
    const v = terraformSecretVars();
    expect(v['TF_VAR_db_password']).toBe('operator-value-0');
    expect(Object.values(v).every((x) => x.startsWith('operator-value-'))).toBe(true);
  });
});
