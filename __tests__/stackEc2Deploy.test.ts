/**
 * Deploying a whole project (Frontend, Backend, API, Database) to one EC2 server that runs the compose file.
 */
import { spawnSync } from 'child_process';
import { parse } from 'yaml';
import { generateProjectFiles, defaultProject, LAYERS, type Layer, type StackProject } from '@/lib/engines/containers/stackProject';
import { COMPOSE_SHA256, COMPOSE_VERSION } from '@/lib/engines/containers/stackEc2Deploy';

const project = (on: Layer[], tweak?: (p: StackProject) => void): StackProject => {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.deploy.target = 'ec2';
  tweak?.(p);
  return p;
};
const gen = (on: Layer[], tweak?: (p: StackProject) => void) => {
  const r = generateProjectFiles(project(on, tweak));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r;
};
const file = (r: ReturnType<typeof gen>, path: string) => r.files.find((f) => f.path === path)?.content ?? '';
const compose = (r: ReturnType<typeof gen>) => parse(file(r, 'ec2/compose.deploy.yml')) as { services: Record<string, { image: string; build?: unknown; ports?: string[]; depends_on?: Record<string, unknown> }>; volumes?: Record<string, unknown> };
const ALL: Layer[] = ['frontend', 'backend', 'api', 'database'];
const combos = (): Layer[][] => { const o: Layer[][] = []; for (let m = 1; m < 16; m++) { const c = LAYERS.filter((_, i) => m & (1 << i)); if (c.length > 1) o.push(c); } return o; };

describe('the files', () => {
  test('a deployment adds deploy.sh, destroy.sh and an ec2 folder, and keeps the local compose file', () => {
    const r = gen(ALL);
    const paths = r.files.map((f) => f.path);
    for (const p of ['deploy.sh', 'destroy.sh', 'ec2/main.tf', 'ec2/variables.tf', 'ec2/outputs.tf', 'ec2/user_data.sh', 'ec2/compose.deploy.yml', 'ec2/README.md', 'ec2/.gitignore']) expect(paths).toContain(p);
    expect(file(r, 'deploy.sh') && r.files.find((f) => f.path === 'deploy.sh')!.executable).toBe(true);
    const without = (() => { const x = generateProjectFiles(project(ALL, (p) => { p.deploy.target = 'none'; })); return x.ok ? x.files : []; })();
    // The files for running locally are the same with or without a deployment.
    for (const f of without.filter((f) => f.path !== 'README.md')) expect(file(r, f.path)).toBe(f.content);
    expect(file(r, 'docker-compose.yml')).toContain('build: ./backend');
  });

  test.each(combos().map((c) => [c.join('+'), c] as const))('%s: every script is valid shell and the compose file is valid YAML', (_n, on) => {
    const r = gen(on);
    for (const f of ['deploy.sh', 'destroy.sh', 'ec2/user_data.sh']) {
      const sh = spawnSync('bash', ['-n'], { input: file(r, f), encoding: 'utf8' });
      expect({ f, status: sh.status, err: sh.stderr }).toEqual({ f, status: 0, err: '' });
    }
    expect(Object.keys(compose(r).services).sort()).toEqual([...on].sort());
  });

  test('without a deployment nothing about EC2 is generated', () => {
    const r = generateProjectFiles(project(ALL, (p) => { p.deploy.target = 'none'; }));
    expect(r.ok && r.files.some((f) => f.path.startsWith('ec2/') || f.path === 'deploy.sh')).toBe(false);
    expect(r.ok && r.cost).toBeFalsy();
  });

  test('one service ticked keeps its own deployment (the project setting is for several)', () => {
    const p = project(['backend']);
    const r = generateProjectFiles(p);
    expect(r.ok && r.files.some((f) => f.path === 'ec2/compose.deploy.yml')).toBe(false);
  });
});

describe('the compose file the server runs', () => {
  test('images come from the registry with the tag filled in on the server, and nothing is built there', () => {
    const c = compose(gen(ALL));
    for (const l of ['frontend', 'backend', 'api']) {
      expect(c.services[l]!.image).toBe(`\${REGISTRY:?set REGISTRY}/shop-${l}:\${TAG:?set TAG}`);
      expect(c.services[l]!.build).toBeUndefined();
    }
    expect(c.services.database!.image).toBe('postgres:17-alpine');
    expect(Object.keys(c.volumes ?? {})).toEqual(['database-data']);
  });

  test.each([
    [['frontend', 'backend', 'api', 'database'], 'frontend'], [['backend', 'api'], 'api'], [['backend', 'database'], 'backend'], [['api', 'database'], 'api'], [['frontend', 'database'], 'frontend'],
  ] as const)('%j: only the %s is open to the network', (on, entry) => {
    const c = compose(gen([...on]));
    const open = Object.entries(c.services).filter(([, s]) => (s.ports ?? []).some((p) => !p.startsWith('127.0.0.1:'))).map(([k]) => k);
    expect(open).toEqual([entry]);
  });

  test('the security group opens exactly the public service\'s port', () => {
    const r = gen(ALL);
    const main = file(r, 'ec2/main.tf');
    expect(main.match(/ingress \{/g)).toHaveLength(1);
    expect(file(r, 'ec2/variables.tf')).toMatch(/variable "entry_port"[\s\S]*default\s+= 8080/);
    expect(compose(r).services.frontend!.ports).toEqual(['8080:8080']);
  });

  test('a service that uses a ready-made image keeps it and gets no repository', () => {
    const r = gen(['frontend', 'api'], (p) => { p.layers.frontend.config = { ...p.layers.frontend.config, image: 'nginx:1.27' }; });
    expect(compose(r).services.frontend!.image).toBe('nginx:1.27');
    expect(file(r, 'ec2/main.tf')).toContain('built = ["api"]');
    expect(file(r, 'deploy.sh')).toContain("BUILT=('api')");
  });

  test('all ready-made images: no repositories, no Docker needed to deploy', () => {
    const r = gen(['frontend', 'api'], (p) => { for (const l of ['frontend', 'api'] as const) p.layers[l].config = { ...p.layers[l].config, image: 'nginx:1.27' }; });
    expect(file(r, 'ec2/main.tf')).not.toContain('aws_ecr_repository');
    expect(file(r, 'ec2/main.tf')).not.toContain('EcrLogin');
    expect(file(r, 'deploy.sh')).not.toContain('need docker');
    expect(file(r, 'ec2/outputs.tf')).not.toContain('ecr_repositories');
    expect(file(r, 'ec2/user_data.sh')).not.toContain('ecr get-login-password');
  });
});

describe('the Terraform', () => {
  const main = () => file(gen(ALL), 'ec2/main.tf');
  test('safe defaults: IMDSv2, encrypted disk, no SSH, scanned images, a private release bucket', () => {
    const m = main();
    expect(m).toContain('http_tokens   = "required"');
    expect(m).toMatch(/encrypted\s+= true/);
    expect(m).not.toMatch(/from_port\s+= 22\b/);
    expect(m).toContain('scan_on_push = true');
    expect(m).toMatch(/block_public_acls\s+= true[\s\S]*restrict_public_buckets = true/);
    expect(m).toContain('AmazonSSMManagedInstanceCore');
  });
  test('one repository per built service and a role limited to them, the two release files and this project\'s secrets', () => {
    const m = main();
    expect(m).toContain('built = ["frontend", "backend", "api"]');
    expect(m).toContain('for_each             = toset(local.built)');
    expect(m).toContain('resources = [for r in aws_ecr_repository.svc : r.arn]');
    expect(m).toContain('/compose.yml", "${aws_s3_bucket.release.arn}/release.env"');
    expect(m).toContain('parameter/${var.app_name}/*');
  });
  test('with a database the machine is never replaced by a changed setting or a newer image', () => {
    expect(main()).toMatch(/ignore_changes = \[user_data, ami\]/);
    expect(file(gen(['backend', 'api']), 'ec2/main.tf')).toContain('user_data_replace_on_change = true');
  });
  test('the release files are what the server reads: a new compose file is a new release, not a new server', () => {
    const m = main();
    expect(m).toMatch(/resource "aws_s3_object" "compose"[\s\S]*content\s+= file\(/);
    expect(m).toContain('content                = "TAG=${var.image_tag}\\n"');
  });
  test('the bucket name matches the one the server works out', () => {
    const r = gen(ALL);
    expect(file(r, 'ec2/main.tf')).toContain('release_bucket = "${substr(var.app_name, 0, 30)}-${data.aws_caller_identity.current.account_id}"');
    expect(file(r, 'ec2/user_data.sh')).toContain('BUCKET="${APP:0:30}-$ACCOUNT"');
  });
  test('an Elastic IP is optional', () => {
    expect(main()).not.toContain('aws_eip');
    expect(file(gen(ALL, (p) => { p.deploy.ec2.elasticIp = true; }), 'ec2/main.tf')).toContain('aws_eip');
  });
  test('the settings from the form end up in variables.tf', () => {
    const v = file(gen(ALL, (p) => { Object.assign(p.deploy.ec2, { region: 'eu-west-1', instanceType: 'm5.large', allowedCidr: '203.0.113.0/24', volumeGb: 50, imageTag: 'v7' }); }), 'ec2/variables.tf');
    for (const x of ['"eu-west-1"', '"m5.large"', '"203.0.113.0/24"', '= 50', '"v7"', '"shop"']) expect(v).toContain(x);
  });
});

describe('the server start-up', () => {
  const u = () => file(gen(ALL, (p) => { p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }]; }), 'ec2/user_data.sh');
  test('Compose is a pinned release and a file that does not match its checksum is refused', () => {
    expect(u()).toContain(`releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64`);
    expect(u()).toContain(`echo "${COMPOSE_SHA256}  $PLUGIN_DIR/docker-compose" | sha256sum -c -`);
    expect(COMPOSE_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });
  test('every secret is read from SSM when the service starts, never written into the script', () => {
    const s = u();
    expect(s).toContain('--name /shop/POSTGRES_PASSWORD');
    expect(s).toContain('--name /shop/JWT_SECRET');
    expect(s).toContain('set -euo pipefail');
    expect(s).toContain('umask 077');
  });
  test('the service pulls, then runs compose in the foreground so systemd supervises it', () => {
    const s = u();
    expect(s).toMatch(/compose -p "\$APP" -f compose\.yml pull[\s\S]*exec docker compose -p "\$APP" -f compose\.yml up --remove-orphans/);
    expect(s).toContain('Restart=always');
  });
});

describe('deploy.sh and destroy.sh', () => {
  const r = gen(ALL, (p) => { p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }]; });
  test('it builds each built service for the server and pushes it to its own repository', () => {
    const d = file(r, 'deploy.sh');
    expect(d).toContain("BUILT=('frontend' 'backend' 'api')");
    expect(d).toContain('docker build --platform linux/amd64 -t "$REGISTRY/$APP-$LAYER:$TAG" "./$LAYER"');
    expect(d).toContain('docker push "$REGISTRY/$APP-$LAYER:$TAG"');
  });
  test('secrets are asked hidden, stored in SSM, checked for characters that would break a URL, and the database password can be generated', () => {
    const d = file(r, 'deploy.sh');
    expect(d).toContain("SECRETS=('JWT_SECRET' 'POSTGRES_PASSWORD')");
    expect(d).toContain("GENERATED=('POSTGRES_PASSWORD')");
    expect(d).toContain('read -r -s -p');
    expect(d).toContain('--type SecureString');
    expect(d).toContain('openssl rand -hex 24');
    expect(d).toContain('^[A-Za-z0-9._~-]+$');
    expect(d).not.toMatch(/--value "\$VALUE"/);          // the value goes through a private file, not the command line
  });
  test('destroy asks for the project name first and says the data goes with the server', () => {
    const d = file(r, 'destroy.sh');
    expect(d).toContain('Type the project name ($APP)');
    expect(d).toContain('including the PostgreSQL data');
  });
});

describe('what is checked and said', () => {
  test('bad deployment settings stop the files, with the reason', () => {
    for (const [patch, why] of [[{ allowedCidr: 'everyone' }, /who can connect/], [{ instanceType: 'big' }, /instance type/], [{ volumeGb: 2 }, /disk size/], [{ region: 'mars' }, /region/], [{ imageTag: 'a b' }, /image tag/]] as const) {
      const p = project(ALL, (x) => { Object.assign(x.deploy.ec2, patch); });
      const r = generateProjectFiles(p);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.errors.join(' ')).toMatch(why);
    }
  });
  test('a database on the same server, an open range and the latest tag are warned about; a cost is given', () => {
    const r = gen(ALL);
    const w = r.warnings.join(' | ');
    expect(w).toContain('whole internet');
    expect(w).toContain('same server as the application');
    expect(w).toContain('"latest" tag');
    expect(r.cost?.monthlyUsd).toBeGreaterThan(0);
    expect(r.cost?.lines.map((l) => l.label).join(' ')).toContain('t3.medium');
  });
  test('a narrow range and a version tag leave only the standing notes', () => {
    const r = gen(['backend', 'api'], (p) => { Object.assign(p.deploy.ec2, { allowedCidr: '203.0.113.0/24', imageTag: 'v1' }); });
    expect(r.warnings.join(' | ')).not.toContain('whole internet');
    expect(r.warnings.join(' | ')).not.toContain('"latest" tag');
  });
});
