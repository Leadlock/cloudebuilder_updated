/**
 * "Install on the server": the catalog, the first-boot script, and what it adds to the generated Terraform for an EC2 instance and an Azure VM.
 */
import { SOFTWARE, awsFamily, azureFamily, cleanPageText, combineStartupScripts, planSoftware, softwareScript } from '@/lib/engines/servers/software';
import { amiParameter } from '@/lib/engines/terraform/serverSoftware';
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

const row = (id: string, resourceType: string, label: string, cfg: Record<string, unknown>, provider = 'aws'): DbArchitectureResource => ({
  id, resourceType, provider, label, positionX: 0, positionY: 0, configJson: JSON.stringify(cfg), region: null, groupId: null, locked: false, architectureId: 'arch-1',
});
const generate = (resources: DbArchitectureResource[]) => terraformGenerator.generate({ architectureId: 'arch-1', projectId: 'p-1', resources, connections: [], projectName: 'demo' });
const main = (r: ReturnType<typeof generate>) => r.files.find((f) => f.filename === 'main.tf')!.content;
const item = (id: string) => SOFTWARE.find((s) => s.id === id)!;

describe('software catalog', () => {
  test('every item has packages for both families, and a verify command', () => {
    for (const s of SOFTWARE) {
      expect(s.packages.dnf.length).toBeGreaterThan(0);
      expect(s.packages.apt.length).toBeGreaterThan(0);
      expect(s.verify.dnf).toBeTruthy();
      expect(s.verify.apt).toBeTruthy();
    }
  });

  test('unknown ids are dropped with a reason, duplicates collapse, and the order is the catalog order', () => {
    const p = planSoftware(['redis', 'bogus', 'nginx', 'nginx']);
    expect(p.items.map((i) => i.id)).toEqual(['nginx', 'redis']);
    expect(p.warnings.join(' ')).toContain('bogus');
  });

  test('nginx and Apache cannot both be chosen: the first wins and the other is explained', () => {
    const p = planSoftware(['nginx', 'apache']);
    expect(p.items.map((i) => i.id)).toEqual(['nginx']);
    expect(p.warnings.join(' ')).toMatch(/Apache.*nginx/);
  });

  test('operating systems: Amazon Linux 2023 is dnf, Ubuntu and Debian are apt, anything else is unsupported', () => {
    expect(awsFamily('Amazon Linux 2023')).toBe('dnf');
    expect(awsFamily('Ubuntu 22.04')).toBe('apt');
    expect(awsFamily('Debian 12')).toBe('apt');
    expect(awsFamily('Windows Server 2022')).toBeNull();
    expect(azureFamily({ osType: 'Windows' })).toBeNull();
    expect(azureFamily({ imagePublisher: 'Canonical' })).toBe('apt');
    expect(azureFamily({ imagePublisher: 'SomeoneElse' })).toBeNull();
  });
});

describe('first-boot script', () => {
  test('is empty with nothing selected, and logs, retries and marks completion otherwise', () => {
    expect(softwareScript([], { family: 'apt', loginUser: 'ubuntu' })).toBe('');
    const s = softwareScript([item('nginx')], { family: 'apt', loginUser: 'ubuntu' });
    expect(s).toContain('#!/bin/bash');
    expect(s).toContain('/var/log/cloudcraft-setup.log');
    expect(s).toContain('/var/lib/cloudcraft-setup.done');
    expect(s).toContain('nginx');
  });

  test('uses the right package manager for the family', () => {
    expect(softwareScript([item('nginx')], { family: 'dnf', loginUser: 'ec2-user' })).toContain('dnf');
    expect(softwareScript([item('nginx')], { family: 'apt', loginUser: 'ubuntu' })).toContain('apt-get');
  });

  test('page text is one clean line: control characters removed, length capped, HTML escaped in the script', () => {
    expect(cleanPageText('a\nb\u0000c')).toBe('a b c');
    expect(cleanPageText('x'.repeat(500))).toHaveLength(200);
    const s = softwareScript([item('nginx')], { family: 'apt', loginUser: 'ubuntu', pageText: '<script>alert(1)</script>' });
    expect(s).not.toContain('<script>alert(1)</script>');
    expect(s).toContain('&lt;script&gt;');
  });

  test('the person\'s own startup script still runs, after the software, with a single shebang', () => {
    const c = combineStartupScripts('#!/bin/bash\necho one', '#!/bin/bash\necho two');
    expect(c.match(/#!\/bin\/bash/g)).toHaveLength(1);
    expect(c.indexOf('echo one')).toBeLessThan(c.indexOf('echo two'));
    expect(combineStartupScripts('', 'echo two')).toBe('echo two');
  });
});

describe('AWS image lookup', () => {
  test('finds the current image by name, for x86 and for Graviton', () => {
    expect(amiParameter('Amazon Linux 2023', false)).toContain('al2023');
    expect(amiParameter('Amazon Linux 2023', false)).toContain('x86_64');
    expect(amiParameter('Amazon Linux 2023', true)).toContain('arm64');
    expect(amiParameter('Ubuntu 24.04', true)).toContain('arm64');
    expect(amiParameter('Windows Server 2022', false)).toBeNull();
  });
});

describe('EC2 Terraform', () => {
  const ec2 = (cfg: Record<string, unknown>) => generate([row('e1', 'aws_ec2', 'Web', { os: 'Amazon Linux 2023', instanceType: 't3.micro', ami: '', ...cfg })]);

  test('without software nothing about it appears', () => {
    const out = main(ec2({}));
    expect(out).not.toContain('cloudcraft-setup');
    expect(out).not.toContain('_web"');
  });

  test('installs the software through user_data, looks the image up by name, and opens the ports only to the chosen range', () => {
    const out = main(ec2({ serverSoftware: ['nginx'], webAccessCidr: '203.0.113.0/24' }));
    expect(out).toContain('cloudcraft-setup');
    expect(out).toContain('aws_ssm_parameter');
    expect(out).toContain('203.0.113.0/24');
    expect(out).toMatch(/from_port\s*=\s*80/);
    expect(out).not.toMatch(/ingress[\s\S]*?cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\][\s\S]*?egress/);
  });

  test('an image found by name never replaces a running server when AWS publishes a newer one', () => {
    const tf = main(ec2({ serverSoftware: ['git'] }));
    expect(tf).toContain('data.aws_ssm_parameter.web_ami.value');
    expect(tf).toMatch(/lifecycle\s*\{\s*ignore_changes\s*=\s*\[ami\]\s*\}/);
  });

  test('a server with a fixed image id has no such block (nothing changes for it)', () => {
    const tf = main(generate([row('e1', 'aws_ec2', 'Web', { os: 'Amazon Linux 2023', instanceType: 't3.micro', ami: 'ami-0123456789abcdef0' })]));
    expect(tf).toContain('"ami-0123456789abcdef0"');
    expect(tf).not.toContain('ignore_changes');
  });

  test('Graviton instance types get the arm64 image', () => {
    expect(main(ec2({ serverSoftware: ['git'], instanceType: 't4g.micro' }))).toContain('arm64');
  });

  test('a web server without a range installs but opens nothing, and says so', () => {
    const r = ec2({ serverSoftware: ['apache'] });
    expect(main(r)).not.toMatch(/from_port\s*=\s*80/);
    expect(r.warnings.join(' ')).toContain('no port is open');
  });

  test('0.0.0.0/0 is allowed but warned about; a malformed range opens nothing', () => {
    expect(ec2({ serverSoftware: ['nginx'], webAccessCidr: '0.0.0.0/0' }).warnings.join(' ')).toContain('whole internet');
    const bad = ec2({ serverSoftware: ['nginx'], webAccessCidr: 'everyone"; drop' });
    expect(main(bad)).not.toContain('everyone');
    expect(bad.warnings.join(' ')).toContain('must be an IPv4 range');
  });

  test('page text cannot break out of the script or start a Terraform interpolation', () => {
    const out = main(ec2({ serverSoftware: ['nginx'], serverPageText: '${aws_s3_bucket.x.id} EOF "quote"' }));
    expect(out).not.toMatch(/[^$]\$\{aws_s3_bucket/);
  });

  test('an unsupported operating system installs nothing but keeps the person\'s own script', () => {
    const r = ec2({ os: 'Windows Server 2022', serverSoftware: ['nginx'], userData: 'echo mine' });
    expect(main(r)).toContain('echo mine');
    expect(main(r)).not.toContain('cloudcraft-setup');
    expect(r.warnings.join(' ')).toContain('not one of them');
  });

  test('their own script runs after the software', () => {
    const out = main(ec2({ serverSoftware: ['git'], userData: '#!/bin/bash\necho mine' }));
    expect(out.indexOf('cloudcraft-setup')).toBeLessThan(out.indexOf('echo mine'));
  });
});

describe('Azure VM Terraform', () => {
  const vm = (cfg: Record<string, unknown>) => generate([row('v1', 'azure_vm', 'Web VM', { osType: 'Linux', imagePublisher: 'Canonical', adminUsername: 'azureuser', ...cfg }, 'azure')]);

  test('installs through custom_data and opens the web ports to the chosen range only', () => {
    const out = main(vm({ serverSoftware: ['nginx', 'redis'], webAccessCidr: '203.0.113.0/24' }));
    expect(out).toContain('custom_data');
    expect(out).toContain('cloudcraft-setup');
    expect(out).toContain('203.0.113.0/24');
    expect(out).toContain('azurerm_network_security_group');
    expect(out).toContain('azurerm_network_interface_security_group_association');
  });

  test('a multi-line custom data script is a heredoc, not a broken one-line string', () => {
    const out = main(vm({ customData: '#!/bin/bash\necho a\necho b' }));
    expect(out).toMatch(/base64encode\(<<-EOF\n/);
  });

  test('Windows VMs install nothing and say so', () => {
    const r = vm({ osType: 'Windows', serverSoftware: ['nginx'] });
    expect(main(r)).not.toContain('cloudcraft-setup');
    expect(r.warnings.join(' ')).toContain('Linux VMs only');
  });
});
