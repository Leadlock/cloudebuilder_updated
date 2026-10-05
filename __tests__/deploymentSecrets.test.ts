import { generatePassword, generatedSecretsFor, terraformSecretVarsFor, type DeploymentSecretStore } from '@/lib/terraform/execution/deploymentSecrets';
import { applyLifetimeChange } from '@/lib/cloud/credentialLifetime';

const NAMES = ['TF_VAR_db_password', 'TF_VAR_sql_admin_password', 'TF_VAR_admin_ssh_public_key', 'TF_VAR_windows_admin_password'];
const env = process.env as Record<string, string | undefined>;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of [...NAMES, 'NODE_ENV']) saved[k] = env[k]; NAMES.forEach((k) => delete env[k]); env.NODE_ENV = 'development'; });
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete env[k]; else env[k] = v; } });

function memoryStore(): DeploymentSecretStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const key = (o: string, a: string, n: string) => `${o}|${a}|${n}`;
  return { rows, get: async (o, a, n) => rows.get(key(o, a, n)) ?? null, put: async (o, a, n, v) => { rows.set(key(o, a, n), v); } };
}

describe('generatePassword', () => {
  it('is 32 characters with every kind, and avoids what RDS refuses', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(32);
      expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[a-z]/); expect(p).toMatch(/\d/); expect(p).toMatch(/[-_.~!#%^*+=]/);
      expect(p).not.toMatch(/[/"@\s]/);
    }
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe('terraformSecretVarsFor', () => {
  it('generates once per account, then reuses the same passwords', async () => {
    const store = memoryStore();
    const first = await terraformSecretVarsFor('org', 'acc1', store);
    const again = await terraformSecretVarsFor('org', 'acc1', store);
    expect(again).toEqual(first);
    expect(first['TF_VAR_db_password']).toHaveLength(32);
    expect(first['TF_VAR_db_password']).not.toBe('CloudCraft_SecureDbPass123!');
    expect(first['TF_VAR_admin_ssh_public_key']).toBeTruthy();
  });

  it('gives each account its own passwords', async () => {
    const store = memoryStore();
    const a = await terraformSecretVarsFor('org', 'acc1', store);
    const b = await terraformSecretVarsFor('org', 'acc2', store);
    expect(a['TF_VAR_db_password']).not.toBe(b['TF_VAR_db_password']);
  });

  it('lets the operator\'s environment win and does not store it', async () => {
    env.TF_VAR_db_password = 'operator-supplied';
    const store = memoryStore();
    const v = await terraformSecretVarsFor('org', 'acc1', store);
    expect(v['TF_VAR_db_password']).toBe('operator-supplied');
    expect(await generatedSecretsFor('org', 'acc1', store)).not.toHaveProperty('db_password');
  });

  it('in production needs the SSH key from the environment, but still generates the passwords', async () => {
    env.NODE_ENV = 'production';
    await expect(terraformSecretVarsFor('org', 'acc1', memoryStore())).rejects.toThrow(/admin_ssh_public_key/);
    env.TF_VAR_admin_ssh_public_key = 'ssh-ed25519 AAAA test';
    const v = await terraformSecretVarsFor('org', 'acc1', memoryStore());
    expect(v['TF_VAR_db_password']).toHaveLength(32);
  });

  it('in production refuses to fall back to a written-down value when storage fails; development keeps working', async () => {
    const broken: DeploymentSecretStore = { get: async () => { throw new Error('no table'); }, put: async () => { throw new Error('no table'); } };
    env.NODE_ENV = 'production';
    env.TF_VAR_admin_ssh_public_key = 'ssh-ed25519 AAAA test';
    await expect(terraformSecretVarsFor('org', 'acc1', broken)).rejects.toThrow(/db:update/);
    env.NODE_ENV = 'development';
    expect((await terraformSecretVarsFor('org', 'acc1', broken))['TF_VAR_db_password']).toBeTruthy();
  });

  it('two runs at the same moment end up with the same password', async () => {
    const rows = new Map<string, string>();
    let first = true;
    const racing: DeploymentSecretStore = {
      get: async (_o, _a, n) => rows.get(n) ?? null,
      put: async (_o, _a, n, v) => { if (first) { first = false; rows.set(n, 'winner'); throw new Error('duplicate key'); } rows.set(n, v); },
    };
    const v = await terraformSecretVarsFor('org', 'acc1', racing);
    expect(v['TF_VAR_db_password']).toBe('winner');
  });
});

describe('applyLifetimeChange', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const base = { accessKeyId: 'AKIA', secretAccessKey: 's', expiresAt: '2026-01-01T01:00:00.000Z' };

  it('extends from now, or removes the limit', () => {
    expect(applyLifetimeChange(base, { action: 'extend', hours: 24 }, now)).toMatchObject({ ok: true, credentials: { expiresAt: '2026-01-02T00:00:00.000Z' } });
    const open = applyLifetimeChange(base, { action: 'extend', hours: null }, now);
    expect(open.ok && 'expiresAt' in open.credentials).toBe(false);
  });

  it('cannot extend temporary credentials', () => {
    const r = applyLifetimeChange({ ...base, sessionToken: 't' }, { action: 'extend', hours: 24 }, now);
    expect(r).toMatchObject({ ok: false });
  });

  it('toggles forget-after-deploy', () => {
    expect(applyLifetimeChange(base, { action: 'forgetAfterDeploy', value: true })).toMatchObject({ ok: true, credentials: { forgetAfterDeploy: true } });
    const off = applyLifetimeChange({ ...base, forgetAfterDeploy: true }, { action: 'forgetAfterDeploy', value: false });
    expect(off.ok && 'forgetAfterDeploy' in off.credentials).toBe(false);
  });
});
