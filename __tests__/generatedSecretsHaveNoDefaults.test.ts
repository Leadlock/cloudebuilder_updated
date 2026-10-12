/**
 * The Terraform CloudCraft generates must never contain a built-in password or SSH key. Anyone can download the files, so a default would
 * deploy databases and servers that everyone who has read this repository can open. Secrets have no default: Terraform asks for them, and
 * CloudCraft's own runs supply random ones (see lib/terraform/execution/deploymentSecrets.ts).
 */
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';
import { explainTerraformError } from '@/lib/terraform/execution/errorHints';

const res = (id: string, resourceType: string, config: Record<string, unknown> = {}): DbArchitectureResource => ({
  id, resourceType, provider: resourceType.startsWith('azure_') ? 'azure' : 'aws', label: id, positionX: 0, positionY: 0,
  configJson: JSON.stringify({ name: id, ...config }), region: null, groupId: null, locked: false, architectureId: 'a',
} as DbArchitectureResource);
const files = (resources: DbArchitectureResource[]) => new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections: [] }).files;
const variablesOf = (resources: DbArchitectureResource[]) => files(resources).find((f) => f.filename === 'variables.tf')!.content;

const EVERYTHING = [
  res('db', 'aws_rds'), res('sql', 'azure_sql'), res('pg', 'azure_postgres'), res('my', 'azure_mysql'),
  res('lin', 'azure_vm', { osType: 'Linux' }), res('win', 'azure_vm', { osType: 'Windows' }),
];

describe('generated variables have no built-in secrets', () => {
  const block = (v: string, name: string) => new RegExp(`variable "${name}" \\{[^}]*\\}`).exec(v)?.[0] ?? '';

  test.each(['db_password', 'sql_admin_password', 'windows_admin_password', 'admin_ssh_public_key'])('%s is declared with no default', (name) => {
    const b = block(variablesOf(EVERYTHING), name);
    expect(b).not.toBe('');                       // it is declared (the design needs it)
    expect(b).not.toMatch(/\bdefault\b/);
  });

  test('the password variables stay sensitive', () => {
    const v = variablesOf(EVERYTHING);
    for (const n of ['db_password', 'sql_admin_password', 'windows_admin_password']) expect(block(v, n)).toMatch(/sensitive\s*=\s*true/);
  });

  test('no generated file contains a known password or key', () => {
    for (const f of files(EVERYTHING)) {
      expect(f.content).not.toMatch(/Pass123/);
      expect(f.content).not.toMatch(/ssh-rsa AAAA/);
      expect(f.content).not.toContain('cloudcraft@admin');
    }
  });

  test('the sample tfvars says secrets are asked for and never written to the file', () => {
    const tfvars = files(EVERYTHING).find((f) => f.filename.endsWith('.tfvars'))!.content;
    expect(tfvars).toMatch(/no default on purpose/i);
    expect(tfvars).not.toMatch(/^\s*(db_password|sql_admin_password|admin_ssh_public_key|windows_admin_password)\s*=/m);
  });

  test('a user and a non-secret setting keep their defaults (only secrets lose them)', () => {
    const v = variablesOf(EVERYTHING);
    expect(block(v, 'db_username')).toMatch(/default\s*=\s*"dbadmin"/);
    expect(block(v, 'sql_admin_login')).toMatch(/default\s*=\s*"sqladmin"/);
  });
});

describe('the missing-secret error is explained', () => {
  test('a missing SSH key says to create a key pair and set the variable', () => {
    const e = explainTerraformError('Error: No value for required variable\n\n  on variables.tf line 40:\n  40: variable "admin_ssh_public_key" {\n\nThe root module input variable "admin_ssh_public_key" is not set')!;
    expect(e.title).toMatch(/SSH public key/);
    expect(e.steps.join(' ')).toMatch(/ssh-keygen/);
    expect(e.steps.join(' ')).toMatch(/TF_VAR_admin_ssh_public_key/);
  });
  test('any other missing variable names it', () => {
    const e = explainTerraformError('No value for required variable on variables.tf line 3: variable "db_password" {')!;
    expect(e.title).toContain('db_password');
    expect(e.steps.join(' ')).toContain('TF_VAR_db_password');
  });
});
