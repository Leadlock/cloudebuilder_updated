/**
 * "Install on the server" in Container Templates: software installed on the EC2 instance or Azure VM itself, beside the container.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defaultConfig, generateContainerFiles, validate, type ContainerConfig } from '@/lib/engines/containers/dockerTemplates';
import { parseStoredConfig } from '@/lib/engines/containers/stored';

const config = (target: 'ec2' | 'azvm', software: string[], extra: Partial<ContainerConfig> = {}): ContainerConfig => {
  const c = defaultConfig('node');
  c[target] = { ...c[target], enabled: true, software, pageText: 'Hello <b>there</b>', allowedCidr: '203.0.113.0/24' };
  return { ...c, ...extra };
};
const files = (c: ContainerConfig) => {
  const r = generateContainerFiles(c);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { r, get: (path: string) => r.files.find((f) => f.path === path)!.content };
};

describe('EC2 template', () => {
  test('no software: the start-up script and firewall are unchanged', () => {
    const { get } = files(config('ec2', []));
    expect(get('ec2/user_data.sh')).not.toContain('cloudcraft-software');
    expect(get('ec2/main.tf')).not.toContain('Web server');
  });

  test('installs the chosen software before the app starts, never Docker twice, and opens 80/443 only to the chosen range', () => {
    const { get, r } = files(config('ec2', ['nginx', 'redis', 'docker']));
    const sh = get('ec2/user_data.sh');
    expect(sh).toContain('cloudcraft-software');
    expect(sh).toContain('dnf');
    expect(sh.indexOf('cloudcraft-software')).toBeLessThan(sh.indexOf('-run <<'));
    expect(sh).not.toContain('# Docker\n');
    expect(get('ec2/main.tf')).toMatch(/from_port\s*=\s*80/);
    expect(get('ec2/main.tf')).toMatch(/from_port\s*=\s*443/);
    expect(r.warnings.join(' ')).toContain('Docker is always installed');
  });

  test('the generated start-up script is valid shell, including the embedded one, and the page text is escaped', () => {
    const sh = files(config('ec2', ['apache', 'git'])).get('ec2/user_data.sh');
    expect(sh).toContain('&lt;b&gt;');
    const f = join(mkdtempSync(join(tmpdir(), 'hs-')), 'u.sh');
    writeFileSync(f, sh);
    expect(spawnSync('bash', ['-n', f]).status).toBe(0);
  });

  test('a web server cannot share the app port 80 or 443', () => {
    expect(validate(config('ec2', ['nginx'], { port: 80 })).join(' ')).toContain('port 80 and 443');
    expect(validate(config('ec2', ['redis'], { port: 80 }))).toEqual([]);
  });

  test('a web server open to everyone is warned about', () => {
    const c = config('ec2', ['nginx']);
    c.ec2.allowedCidr = '0.0.0.0/0';
    expect(files(c).r.warnings.join(' ')).toContain('ports 80 and 443 will be open to the whole internet');
  });
});

describe('Azure VM template', () => {
  test('installs with apt before the app starts and adds one rule per web port', () => {
    const { get } = files(config('azvm', ['apache', 'postgresql']));
    const sh = get('azvm/cloud-init.sh');
    expect(sh).toContain('apt-get');
    expect(sh.indexOf('cloudcraft-software')).toBeLessThan(sh.indexOf('-run <<'));
    expect(get('azvm/main.tf')).toContain('"web-80"');
    expect(get('azvm/main.tf')).toContain('"web-443"');
  });

  test('without a web server no extra rule appears', () => {
    expect(files(config('azvm', ['redis'])).get('azvm/main.tf')).not.toContain('web-80');
  });

  test('the generated script is valid shell', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'hs-')), 'c.sh');
    writeFileSync(f, files(config('azvm', ['nginx', 'nodejs'])).get('azvm/cloud-init.sh'));
    expect(spawnSync('bash', ['-n', f]).status).toBe(0);
  });
});

describe('saved templates', () => {
  test('a template saved before this option existed still loads, with nothing selected', () => {
    const old = defaultConfig('node');
    const raw = JSON.parse(JSON.stringify(old));
    delete raw.azvm.software; delete raw.azvm.pageText; delete raw.ec2.software;
    const parsed = parseStoredConfig(JSON.stringify(raw))!;
    expect(parsed.azvm.software).toEqual([]);
    expect(parsed.ec2.software).toEqual([]);
  });

  test('the selection survives saving and loading', () => {
    const parsed = parseStoredConfig(JSON.stringify(config('azvm', ['nginx'])))!;
    expect(parsed.azvm.software).toEqual(['nginx']);
  });
});
