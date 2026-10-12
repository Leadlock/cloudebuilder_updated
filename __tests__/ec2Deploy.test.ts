/**
 * Deploy to EC2 for container templates: the generated Terraform, start-up script and workflow are safe by default
 * (no SSH, IMDSv2, encrypted disk, secrets never in Terraform or user_data) and bad input is rejected.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defaultConfig, generateContainerFiles, validate, type ContainerConfig } from '@/lib/engines/containers/dockerTemplates';

const on = (over: Partial<ContainerConfig['ec2']> = {}, rest: Partial<ContainerConfig> = {}): ContainerConfig => {
  const d = defaultConfig('node');
  return { ...d, ...rest, ec2: { ...d.ec2, enabled: true, ...over } };
};
const gen = (c: ContainerConfig) => {
  const r = generateContainerFiles(c);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { files: Object.fromEntries(r.files.map((f) => [f.path, f.content])), warnings: r.warnings };
};

describe('file set', () => {
  test('off by default: nothing extra is generated', () => {
    const { files } = gen(defaultConfig('node'));
    expect(Object.keys(files).filter((p) => p.startsWith('ec2/') || p.startsWith('.github'))).toEqual([]);
  });
  test('on: Terraform project, start-up script, README and workflow', () => {
    const { files } = gen(on());
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['ec2/main.tf', 'ec2/variables.tf', 'ec2/outputs.tf', 'ec2/user_data.sh', 'ec2/README.md', '.github/workflows/deploy.yml']));
  });
  test('the workflow can be left out, and the build context ignores the deploy folders', () => {
    const { files } = gen(on({ githubActions: false }));
    expect('.github/workflows/deploy.yml' in files).toBe(false);
    expect(files['.dockerignore']).toMatch(/^ec2$/m);
    expect(files['.dockerignore']).toMatch(/^\.github$/m);
  });
});

describe('Terraform safety defaults', () => {
  const tf = () => gen(on()).files['ec2/main.tf']!;
  test('no SSH and no key pair; only the app port is open', () => {
    expect(tf()).not.toMatch(/key_name|from_port\s*=\s*22\b/);
    expect(tf()).toContain('from_port   = var.app_port');
    expect(tf()).toContain('AmazonSSMManagedInstanceCore');
  });
  test('IMDSv2 required and disk encrypted; user_data is a plain file, not a template', () => {
    expect(tf()).toContain('http_tokens   = "required"');
    expect(tf()).toContain('encrypted   = true');
    expect(tf()).toContain('file("${path.module}/user_data.sh")');
    expect(tf()).not.toContain('templatefile');
  });
  test('image pulls and secret reads are limited to this app', () => {
    expect(tf()).toContain('resources = [aws_ecr_repository.app.arn]');
    expect(tf()).toContain('parameter/${var.app_name}/*');
  });
  test('braces and brackets balance in every .tf file', () => {
    const { files } = gen(on({ elasticIp: true }));
    for (const [p, c] of Object.entries(files).filter(([p]) => p.endsWith('.tf'))) {
      for (const [o, cl] of [['{', '}'], ['[', ']'], ['(', ')']]) expect([p, c.split(o).length]).toEqual([p, c.split(cl).length]);
    }
  });
  test('elastic IP changes the outputs', () => {
    expect(gen(on({ elasticIp: true })).files['ec2/main.tf']).toContain('resource "aws_eip" "app"');
    expect(gen(on({ elasticIp: true })).files['ec2/outputs.tf']).toContain('aws_eip.app.public_ip');
    expect(gen(on()).files['ec2/main.tf']).not.toContain('aws_eip');
  });
  test('form values reach the variable defaults', () => {
    const v = gen(on({ region: 'eu-west-1', instanceType: 't3.medium', allowedCidr: '203.0.113.0/24', volumeGb: 40 }, { appName: 'shop', port: 9000 })).files['ec2/variables.tf']!;
    for (const x of ['"eu-west-1"', '"t3.medium"', '"203.0.113.0/24"', '= 40', '"shop"', '= 9000']) expect(v).toContain(x);
  });
});

describe('start-up script', () => {
  const secretCfg = () => on({}, { env: [{ key: 'API_TOKEN', value: 'super-secret-value', secret: true }, { key: 'LOG_LEVEL', value: 'info' }] });
  test('secrets are read from SSM at run time and their value is never written anywhere', () => {
    const { files } = gen(secretCfg());
    for (const c of Object.values(files)) expect(c).not.toContain('super-secret-value');
    expect(files['ec2/user_data.sh']).toContain('VALUE=$(aws ssm get-parameter --name /my-app/API_TOKEN --with-decryption');
    // a failed read must stop the script: command substitution inside echo/printf would hide the failure
    expect(files['ec2/user_data.sh']).not.toMatch(/(?:echo|printf)[^\n]*\$\(aws/);
    expect(files['ec2/user_data.sh']).toContain('LOG_LEVEL=info');
    expect(files['ec2/main.tf']).not.toContain('API_TOKEN');
  });
  test('the script is valid bash (syntax check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ec2-'));
    const f = join(dir, 'user_data.sh');
    writeFileSync(f, gen(secretCfg()).files['ec2/user_data.sh']!);
    expect(() => execFileSync('bash', ['-n', f])).not.toThrow();
  });
  test('retries when the image or a secret is missing, and honours the limits and tag', () => {
    const s = gen(on({ imageTag: 'v1.2.3' }, { memoryLimit: '1g', cpuLimit: '2' })).files['ec2/user_data.sh']!;
    expect(s).toContain('Restart=always');
    expect(s).toContain('RestartSec=30');
    expect(s).toContain('--memory 1g --cpus 2');
    expect(s).toContain('/my-app:v1.2.3');
  });
});

describe('workflow', () => {
  test('uses OIDC role from a secret, pushes to the app repository, restart step is optional', () => {
    const w = gen(on({ region: 'eu-west-1' })).files['.github/workflows/deploy.yml']!;
    expect(w).toContain('role-to-assume: ${{ secrets.AWS_ROLE_TO_ARN }}');
    expect(w).toContain('id-token: write');
    expect(w).toContain('AWS_REGION: eu-west-1');
    expect(w).toContain("vars.EC2_INSTANCE_ID != ''");
    expect(w).not.toMatch(/AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID/);
  });
});

describe('warnings and validation', () => {
  test('warns about a public port, the latest tag, companions and secrets', () => {
    const w = gen(on({}, { postgres: true, env: [{ key: 'K', value: '', secret: true }] })).warnings.join('\n');
    expect(w).toMatch(/whole internet/);
    expect(w).toMatch(/latest/);
    expect(w).toMatch(/RDS/);
    expect(w).toMatch(/SecureString/);
    expect(gen(on({ allowedCidr: '203.0.113.0/24', imageTag: 'v1' })).warnings).toEqual([]);
  });
  test('nothing is validated or warned when EC2 is off', () => {
    expect(validate({ ...defaultConfig('node'), ec2: { ...defaultConfig('node').ec2, region: 'bad region' } })).toEqual([]);
  });
  test.each([
    ['region', { region: 'us east 1' }],
    ['instance type', { instanceType: 't3.small; rm -rf /' }],
    ['cidr', { allowedCidr: '999.1.1.1/8' }],
    ['cidr prefix', { allowedCidr: '10.0.0.0/33' }],
    ['cidr text', { allowedCidr: 'anywhere' }],
    ['disk too small', { volumeGb: 2 }],
    ['disk too big', { volumeGb: 5000 }],
    ['tag with a space', { imageTag: 'v 1' }],
    ['tag with a quote', { imageTag: 'v1"' }],
  ] as Array<[string, Partial<ContainerConfig['ec2']>]>)('rejects a bad %s', (_n, over) => {
    expect(validate(on(over)).length).toBeGreaterThan(0);
    expect(generateContainerFiles(on(over)).ok).toBe(false);
  });
});
