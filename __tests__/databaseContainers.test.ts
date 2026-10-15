/**
 * Databases as containers: PostgreSQL, MySQL, MongoDB, Redis and RabbitMQ from their official images, with a data volume, passwords that
 * stay out of the files, and never open to the internet. Runs on a VM or with Docker Compose; managed container services refuse them.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';
import { defaultConfig, generateContainerFiles, validate, withDeployTarget, type ContainerConfig, type DeployTarget } from '@/lib/engines/containers/dockerTemplates';
import { applyDatabase, DB_ENGINES, DB_ENGINE_IDS, databaseOf, dbImage, isInternetWide, type DbEngineId } from '@/lib/engines/containers/databases';
import { currentOption, optionsFor, pickStackOption, STACK_CATEGORIES, STACK_OPTIONS } from '@/lib/engines/containers/stackOptions';

const db = (id: DbEngineId, target: DeployTarget = 'none', version?: string): ContainerConfig => withDeployTarget(applyDatabase({ ...defaultConfig('node'), appName: 'orders-db' }, id, version), target);
const gen = (c: ContainerConfig) => {
  const r = generateContainerFiles(c);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { r, get: (p: string) => r.files.find((f) => f.path === p)?.content ?? '', paths: r.files.map((f) => f.path) };
};
const bashOk = (script: string) => {
  const f = join(mkdtempSync(join(tmpdir(), 'db-')), 's.sh');
  writeFileSync(f, script);
  return spawnSync('bash', ['-n', f]).status === 0;
};

describe('the engines', () => {
  test.each(DB_ENGINE_IDS)('%s has a version list, a port, a data folder, a health check and at least one secret', (id) => {
    const e = DB_ENGINES[id];
    expect(e.versions.length).toBeGreaterThan(0);
    expect(e.port).toBeGreaterThan(0);
    expect(e.dataPath.startsWith('/')).toBe(true);
    expect(e.health.length).toBeGreaterThan(0);
    expect(e.env.some((v) => v.secret)).toBe(true);
    expect(e.env.filter((v) => v.secret).every((v) => v.value === '')).toBe(true);
  });

  test('the image is the official one, named by the version', () => {
    expect(dbImage(DB_ENGINES.postgres, '17')).toBe('postgres:17-alpine');
    expect(dbImage(DB_ENGINES.mysql, '8.4')).toBe('mysql:8.4');
    expect(dbImage(DB_ENGINES.mongodb, '7.0')).toBe('mongo:7.0');
    expect(dbImage(DB_ENGINES.redis, '7.4')).toBe('redis:7.4-alpine');
    expect(dbImage(DB_ENGINES.rabbitmq, '3.13')).toBe('rabbitmq:3.13-alpine');
  });

  test('MongoDB offers 7.0 first and warns about 8.0 on very new kernels; RabbitMQ waits for the broker, not just the node', () => {
    expect(DB_ENGINES.mongodb.versions).toEqual(['7.0', '8.0']);
    expect(applyDatabase(defaultConfig('node'), 'mongodb').version).toBe('7.0');
    expect(gen(db('mongodb', 'ec2', '8.0')).r.warnings.join(' ')).toContain('kernels 6.19 and newer');
    expect(gen(db('mongodb', 'ec2', '7.0')).r.warnings.join(' ')).not.toContain('kernels 6.19');
    expect(DB_ENGINES.rabbitmq.health).toContain('check_running');
  });

  test('RabbitMQ keeps a fixed node name, so its data is found again after the container is replaced', () => {
    expect(DB_ENGINES.rabbitmq.env.find((v) => v.key === 'RABBITMQ_NODENAME')?.value).toBe('rabbit@localhost');
  });
});

describe('applyDatabase', () => {
  test('sets the image, port, variables and limits, and clears what only an application uses', () => {
    const c = applyDatabase({ ...defaultConfig('node'), postgres: true, proxy: true, includeSample: true }, 'postgres');
    expect(c.database).toBe('postgres');
    expect(c.image).toBe('postgres:17-alpine');
    expect(c.port).toBe(5432);
    expect(c.postgres || c.proxy || c.includeSample).toBe(false);
    expect(c.env.map((v) => v.key)).toEqual(['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD']);
    expect(c.env.find((v) => v.key === 'POSTGRES_PASSWORD')).toMatchObject({ secret: true, value: '' });
  });

  test('a range that was open to everyone becomes a private one, and a range the person chose is kept', () => {
    expect(applyDatabase(defaultConfig('node'), 'redis').ec2.allowedCidr).toBe('10.0.0.0/16');
    const own = defaultConfig('node'); own.ec2.allowedCidr = '203.0.113.0/24';
    expect(applyDatabase(own, 'redis').ec2.allowedCidr).toBe('203.0.113.0/24');
  });

  test('changing only the version keeps the person\'s edits; a different engine starts from its own variables', () => {
    const first = applyDatabase(defaultConfig('node'), 'postgres');
    first.env = first.env.map((v) => (v.key === 'POSTGRES_DB' ? { ...v, value: 'shop' } : v));
    expect(applyDatabase(first, 'postgres', '16').env.find((v) => v.key === 'POSTGRES_DB')?.value).toBe('shop');
    expect(applyDatabase(first, 'mysql').env.map((v) => v.key)).toEqual(['MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD']);
  });

  test('an unknown version falls back to the newest', () => {
    expect(applyDatabase(defaultConfig('node'), 'mysql', '1.0').version).toBe('8.4');
  });

  test('every engine and version produces a configuration that passes validation', () => {
    for (const id of DB_ENGINE_IDS) for (const v of DB_ENGINES[id].versions) expect(validate(db(id, 'none', v))).toEqual([]);
  });
});

describe('validation', () => {
  test('only a virtual machine or no deployment is accepted; each managed service says why not', () => {
    for (const t of ['ec2', 'azure-vm', 'none'] as const) expect(validate(db('postgres', t))).toEqual([]);
    for (const [t, name] of [['ecs', 'ECS Fargate'], ['container-apps', 'Azure Container Apps'], ['kubernetes', 'Kubernetes'], ['aks', 'Azure AKS']] as const) {
      const errors = validate(db('postgres', t)).join(' ');
      expect(errors).toContain(name);
      expect(errors).toContain('virtual machine');
    }
  });

  test('a database is never open to the internet, on either VM', () => {
    const ec2 = db('postgres', 'ec2'); ec2.ec2.allowedCidr = '0.0.0.0/0';
    expect(validate(ec2).join(' ')).toContain('must not be open to the internet');
    const az = db('mysql', 'azure-vm'); az.azvm.allowedCidr = '0.0.0.0/0';
    expect(validate(az).join(' ')).toContain('must not be open to the internet');
    ec2.ec2.allowedCidr = '10.0.0.0/16';
    expect(validate(ec2)).toEqual([]);
  });

  test('what counts as the internet', () => {
    expect(isInternetWide('0.0.0.0/0')).toBe(true);
    expect(isInternetWide('0.0.0.0/4')).toBe(true);
    expect(isInternetWide('10.0.0.0/8')).toBe(false);
    expect(isInternetWide('203.0.113.7/32')).toBe(false);
  });

  test('the password must be there and must be a secret', () => {
    const c = db('postgres'); c.env = c.env.filter((v) => v.key !== 'POSTGRES_PASSWORD');
    expect(validate(c).join(' ')).toContain('add the variable POSTGRES_PASSWORD');
    const d = db('postgres'); d.env = d.env.map((v) => (v.key === 'POSTGRES_PASSWORD' ? { ...v, secret: false, value: 'hunter2' } : v));
    expect(validate(d).join(' ')).toContain('must be a secret');
  });

  test('a made-up engine, a wrong version, port or image are refused', () => {
    expect(validate({ ...db('postgres'), database: 'oracle' as never }).join(' ')).toContain('not one of PostgreSQL');
    expect(validate({ ...db('postgres'), version: '9' }).join(' ')).toContain('version 9 is not offered');
    expect(validate({ ...db('postgres'), port: 5433 }).join(' ')).toContain('the port is 5432');
    expect(validate({ ...db('postgres'), image: 'evil/postgres:17-alpine' }).join(' ')).toContain('the image is set by the version');
  });
});

describe('docker-compose.yml', () => {
  test.each(DB_ENGINE_IDS)('%s: valid YAML with a data volume, a health check, a localhost-only port and no password value', (id) => {
    const text = gen(db(id)).get('docker-compose.yml');
    const doc = parse(text) as { services: Record<string, Record<string, unknown>>; volumes: Record<string, unknown> };
    const svc = doc.services['orders-db']!;
    expect(svc['image']).toBe(db(id).image);
    expect(svc['ports']).toEqual([`127.0.0.1:${DB_ENGINES[id].port}:${DB_ENGINES[id].port}`]);
    expect(svc['volumes']).toEqual([`orders-db-data:${DB_ENGINES[id].dataPath}`]);
    expect(Object.keys(doc.volumes)).toEqual(['orders-db-data']);
    expect((svc['healthcheck'] as { test: string[] }).test[0]).toBe('CMD-SHELL');
    for (const secret of DB_ENGINES[id].env.filter((v) => v.secret)) expect((svc['environment'] as Record<string, string>)[secret.key]).toBe(`\${${secret.key}:?set ${secret.key}}`);
  });

  test('Redis is started with its password and persistence', () => {
    const svc = (parse(gen(db('redis')).get('docker-compose.yml')) as { services: Record<string, { command: string[] }> }).services['orders-db']!;
    expect(svc.command[0]).toBe('sh');
    expect(svc.command[2]).toContain('--requirepass "$REDIS_PASSWORD"');
    expect(svc.command[2]).toContain('--appendonly yes');
  });

  test('the files are only the database\'s own: no Dockerfile, no sample app, no HTTP health path', () => {
    const { paths, get } = gen(db('postgres'));
    expect(paths).toEqual(['docker-compose.yml', '.env.example', 'README.md']);
    expect(get('.env.example')).toContain('POSTGRES_PASSWORD=\n');
  });

  test('the README says how to connect, where the data is, how to back it up, and never contains a password', () => {
    const readme = gen(db('postgres')).get('README.md');
    expect(readme).toContain('postgresql://app:<POSTGRES_PASSWORD>@localhost:5432/app');
    expect(readme).toContain('orders-db-data');
    expect(readme).toContain('pg_dump');
    expect(readme).toContain('docker compose down -v');
  });
});

describe('on a virtual machine', () => {
  test('EC2 mounts a data folder, never replaces the machine over a changed setting, and ends without waiting on HTTP', () => {
    const { get, r } = gen(db('postgres', 'ec2'));
    const sh = get('ec2/user_data.sh');
    expect(sh).toContain('-v orders-db-data:/var/lib/postgresql/data');
    expect(sh).not.toContain('mkdir -p /var/lib/orders-db');
    expect(get('ec2/main.tf')).toContain('user_data_replace_on_change = false');
    expect(get('ec2/main.tf')).toMatch(/lifecycle\s*\{\s*ignore_changes\s*=\s*\[user_data\]/);
    expect(get('ec2/outputs.tf')).toMatch(/app_url[\s\S]*value\s*=\s*"\$\{aws_instance\.app\.public_ip\}:\$\{var\.app_port\}"/);
    expect(get('deploy.sh')).not.toContain('curl -fsS -m 5');
    expect(get('deploy.sh')).toContain('PostgreSQL is starting');
    expect(r.warnings.join(' ')).toContain('Take backups');
  });

  test('an ordinary application on EC2 is unchanged', () => {
    const c = withDeployTarget({ ...defaultConfig('node'), image: 'nginx:1.27' }, 'ec2');
    const { get } = gen(c);
    expect(get('ec2/main.tf')).toContain('user_data_replace_on_change = true');
    expect(get('ec2/user_data.sh')).not.toContain('-data:');
    expect(get('deploy.sh')).toContain('curl -fsS -m 5');
  });

  test('Azure VM keeps its custom data out of the changes that replace the machine', () => {
    const { get } = gen(db('mysql', 'azure-vm'));
    expect(get('azvm/main.tf')).toMatch(/ignore_changes\s*=\s*\[[^\]]*custom_data/);
    expect(get('azvm/cloud-init.sh')).toContain('-v orders-db-data:/var/lib/mysql');
    expect(get('deploy.sh')).not.toContain('curl -fsS -m 5');
  });

  test('Redis is started through sh -c so its password comes from the environment, and the line is valid shell', () => {
    const sh = gen(db('redis', 'ec2')).get('ec2/user_data.sh');
    expect(sh).toContain(`sh -c 'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes'`);
    expect(bashOk(sh)).toBe(true);
    expect(bashOk(gen(db('redis', 'azure-vm')).get('azvm/cloud-init.sh'))).toBe(true);
  });

  test.each(DB_ENGINE_IDS)('%s: every generated script is valid shell, and no secret value is in any file', (id) => {
    for (const t of ['ec2', 'azure-vm'] as const) {
      const c = db(id, t);
      const { r } = gen(c);
      for (const f of r.files.filter((x) => x.path.endsWith('.sh'))) expect({ f: f.path, ok: bashOk(f.content) }).toEqual({ f: f.path, ok: true });
      for (const f of r.files) for (const s of DB_ENGINES[id].env.filter((v) => v.secret)) expect(f.content).not.toMatch(new RegExp(`${s.key}\\s*[=:]\\s*["']?[A-Za-z0-9]{6,}`));
    }
  });

  test('the port is open only to the chosen range', () => {
    const c = db('postgres', 'ec2'); c.ec2.allowedCidr = '203.0.113.0/24';
    expect(gen(c).get('ec2/variables.tf')).toContain('203.0.113.0/24');
    expect(gen(c).get('README.md')).toContain('203.0.113.0/24');
  });
});

describe('the Stack groups', () => {
  test('four groups, each with options, and every option can be applied and passes validation', () => {
    expect(STACK_CATEGORIES.map((c) => c.id)).toEqual(['frontend', 'backend', 'api', 'database']);
    for (const cat of STACK_CATEGORIES) expect(optionsFor(cat.id).length).toBeGreaterThan(0);
    for (const o of STACK_OPTIONS) expect({ id: o.id, errors: validate(o.apply(defaultConfig('node'))) }).toEqual({ id: o.id, errors: [] });
  });

  test('the database group offers the five engines', () => {
    expect(optionsFor('database').map((o) => o.label)).toEqual(['PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'RabbitMQ']);
  });

  test('ids are unique, and every option recognises its own result', () => {
    expect(new Set(STACK_OPTIONS.map((o) => o.id)).size).toBe(STACK_OPTIONS.length);
    for (const o of STACK_OPTIONS) expect(o.matches(o.apply(defaultConfig('node')))).toBe(true);
  });

  test('picking sets the stack and keeps the name, the variables and the deployment', () => {
    const c = withDeployTarget({ ...defaultConfig('node'), appName: 'shop', env: [{ key: 'A', value: '1' }] }, 'ec2');
    const next = pickStackOption(c, 'go');
    expect(next.stack).toBe('go');
    expect(next.appName).toBe('shop');
    expect(next.env).toEqual([{ key: 'A', value: '1' }]);
    expect(next.ec2.enabled).toBe(true);
  });

  test('API options set their health path; Frontend options pick the static or Next.js settings', () => {
    expect(pickStackOption(defaultConfig('node'), 'fastapi')).toMatchObject({ stack: 'python', pythonFramework: 'fastapi', healthPath: '/health' });
    expect(pickStackOption(defaultConfig('node'), 'spring-api')).toMatchObject({ stack: 'java', healthPath: '/actuator/health' });
    expect(pickStackOption(defaultConfig('node'), 'spa')).toMatchObject({ stack: 'static', staticSpaFallback: true });
    expect(pickStackOption(defaultConfig('node'), 'static-site')).toMatchObject({ stack: 'static', staticSpaFallback: false });
    expect(pickStackOption(defaultConfig('node'), 'nextjs')).toMatchObject({ stack: 'node', nextStandalone: true });
  });

  test('going to a database and back leaves no trace of it', () => {
    const toDb = pickStackOption({ ...defaultConfig('node'), env: [{ key: 'A', value: '1' }] }, 'db-postgres');
    expect(toDb.database).toBe('postgres');
    expect(toDb.env.some((v) => v.key === 'A')).toBe(false);
    const back = pickStackOption(toDb, 'node');
    expect(back).toMatchObject({ database: '', image: '', stack: 'node', port: 3000 });
    expect(back.env).toEqual([]);
  });

  test('from one database to another starts from the new one\'s variables', () => {
    const next = pickStackOption(pickStackOption(defaultConfig('node'), 'db-postgres'), 'db-redis');
    expect(next.database).toBe('redis');
    expect(next.env.map((v) => v.key)).toEqual(['REDIS_PASSWORD']);
    expect(databaseOf(next)?.id).toBe('redis');
  });

  test('which option a configuration is: a database, a frontend, a backend; FastAPI is an API only when that group is the one in use', () => {
    expect(currentOption(db('mysql'))?.id).toBe('db-mysql');
    expect(currentOption(pickStackOption(defaultConfig('node'), 'spa'))?.category).toBe('frontend');
    expect(currentOption(pickStackOption(defaultConfig('node'), 'nextjs'))?.id).toBe('nextjs');
    expect(currentOption(defaultConfig('node'))?.id).toBe('node');
    const fastapi = pickStackOption(defaultConfig('node'), 'fastapi');
    expect(currentOption(fastapi, 'api')?.id).toBe('fastapi');
    expect(currentOption(fastapi)?.category).toBe('backend');
  });
});

describe('the Terraform of every VM deployment is written with valid interpolations', () => {
  const cases: Array<[string, ContainerConfig, string]> = [
    ['EC2, an application', withDeployTarget({ ...defaultConfig('node'), image: 'nginx:1.27' }, 'ec2'), 'ec2'],
    ['EC2, built from source', withDeployTarget({ ...defaultConfig('node') }, 'ec2'), 'ec2'],
    ['Azure VM, an application', withDeployTarget({ ...defaultConfig('node'), image: 'nginx:1.27' }, 'azure-vm'), 'azvm'],
    ['Azure VM, built from source', withDeployTarget({ ...defaultConfig('node') }, 'azure-vm'), 'azvm'],
    ['EC2, a database', db('postgres', 'ec2'), 'ec2'],
    ['Azure VM, a database', db('mysql', 'azure-vm'), 'azvm'],
  ];
  test.each(cases)('%s: no escaped "${" in any .tf file, and the app_url output is a clean interpolation', (_n, c, dir) => {
    const { r, get } = gen(c);
    for (const f of r.files.filter((x) => x.path.endsWith('.tf'))) {
      // Terraform rejects "\${" and "$\{" ("Invalid escape sequence"); a literal dollar-brace is written "$${".
      expect({ file: f.path, bad: /\\\$\{|\$\\\{/.test(f.content) }).toEqual({ file: f.path, bad: false });
    }
    const url = /output "app_url" \{\s*value\s*=\s*"([^"]*)"/.exec(get(`${dir}/outputs.tf`))![1]!;
    expect(url).toMatch(/\$\{(aws_instance\.app\.public_ip|aws_eip\.app\.public_ip|azurerm_public_ip\.app\.ip_address)\}:\$\{var\.app_port\}/);
    expect(url.startsWith('http://')).toBe(!databaseOf(c));
  });
});
