import { terraformSecretVars } from '@/lib/terraform/execution/secretVars';

const NAMES = ['TF_VAR_db_password', 'TF_VAR_sql_admin_password', 'TF_VAR_admin_ssh_public_key', 'TF_VAR_windows_admin_password'];
const saved: Record<string, string | undefined> = {};
const env = process.env as Record<string, string | undefined>;
beforeEach(() => { for (const k of [...NAMES, 'NODE_ENV']) saved[k] = env[k]; NAMES.forEach((k) => delete env[k]); });
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete env[k]; else env[k] = v; } });

describe('terraformSecretVars', () => {
  it('in development generates the passwords (never a fixed value) and leaves the SSH key unset', () => {
    env.NODE_ENV = 'development';
    const v = terraformSecretVars();
    expect(Object.keys(v).sort()).toEqual(['TF_VAR_db_password', 'TF_VAR_sql_admin_password', 'TF_VAR_windows_admin_password']);
    for (const p of Object.values(v)) {
      expect(p.length).toBeGreaterThanOrEqual(30);
      expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[a-z]/); expect(p).toMatch(/\d/); expect(p).toMatch(/-/);
      expect(p).not.toMatch(/Pass123/);
    }
    expect(new Set(Object.values(v)).size).toBe(3);                 // each name gets its own
    expect(terraformSecretVars()).toEqual(v);                       // stable for the life of the process, so plan and apply agree
  });

  it('an operator value always wins in development too', () => {
    env.NODE_ENV = 'development';
    env.TF_VAR_admin_ssh_public_key = 'ssh-ed25519 AAAA mine';
    expect(terraformSecretVars()['TF_VAR_admin_ssh_public_key']).toBe('ssh-ed25519 AAAA mine');
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

  it('no built-in password or key exists anywhere in the source tree', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawnSync } = require('child_process') as typeof import('child_process');
    // grep exits 1 when it finds nothing, which is the passing case.
    const r = spawnSync('grep', ['-rIlE', 'Pass123!|cloudbuilder@admin', 'lib', 'app', 'components', 'workers', 'scripts'], { encoding: 'utf8' });
    let hits: string[] = [];
    if (r.status === 0 || r.status === 1) {
      expect(r.status === 0 || r.status === 1).toBe(true);
      hits = (r.stdout ?? '').split(/\r?\n/).filter(Boolean);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('path') as typeof import('path');
      const regex = /Pass123!|cloudbuilder@admin/;
      const scan = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) scan(full);
          else if (e.isFile()) {
            const content = fs.readFileSync(full, 'utf8');
            if (regex.test(content)) hits.push(full.replace(/\\/g, '/'));
          }
        }
      };
      ['lib', 'app', 'components', 'workers', 'scripts'].forEach(scan);
    }
    expect(hits).toEqual([]);
  });
});
