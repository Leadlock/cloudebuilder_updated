/**
 * One-command deploy for container templates: deploy.sh / destroy.sh really run (against stand-in aws, terraform, docker and curl
 * commands) in the right order; the optional GitHub role is created only for the named repository; the sample apps and starter
 * templates produce complete projects; scripts keep their executable bit in the zip.
 */
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defaultConfig, generateContainerFiles, STARTER_TEMPLATES, validate, type ContainerConfig } from '@/lib/engines/containers/dockerTemplates';
import { buildZip } from '@/lib/engines/containers/zip';

const on = (over: Partial<ContainerConfig['ec2']> = {}, rest: Partial<ContainerConfig> = {}): ContainerConfig => {
  const d = defaultConfig('node');
  return { ...d, ...rest, ec2: { ...d.ec2, enabled: true, ...over } };
};
const gen = (c: ContainerConfig) => {
  const r = generateContainerFiles(c);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { files: Object.fromEntries(r.files.map((f) => [f.path, f.content])), list: r.files, warnings: r.warnings };
};

/** A folder with the generated files and stand-in commands that record what they were asked to do. */
function sandbox(c: ContainerConfig, opts: { secretExists?: boolean; ssmFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  const { list } = gen(c);
  for (const f of list) {
    const target = join(dir, f.path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, f.content);
  }
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub('terraform', `echo "terraform $*" >> "${log}"
case "$*" in
  *"output -raw ecr_repository_url"*) echo "123456789012.dkr.ecr.us-east-1.amazonaws.com/${c.appName}";;
  *"output -raw instance_id"*) echo "i-0abc";;
  *"output -raw app_url"*) echo "http://203.0.113.9:${c.port}/";;
esac`);
  stub('docker', `echo "docker $*" >> "${log}"; case "$1" in login) cat > /dev/null;; esac`);
  stub('curl', 'exit 22');
  stub('sleep', 'exit 0');
  stub('aws', `echo "aws $*" >> "${log}"
case "$*" in
  *"ssm get-parameter"*) ${opts.secretExists ? 'exit 0' : 'exit 254'};;
  *"ssm send-command"*) ${opts.ssmFails ? 'exit 254' : 'exit 0'};;
  *"ecr get-login-password"*) echo "token";;
  *"put-parameter"*) f=$(echo "$*" | sed 's/.*file:\\/\\///'); cat "$f" > "${dir}/stored-secret"; echo "$*" | grep -q "\\-\\-value file://" || echo "VALUE-ON-COMMAND-LINE" >> "${log}";;
esac`);
  return { dir, bin, log, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}
const run = (sb: ReturnType<typeof sandbox>, script: string, args: string[] = [], input = '') =>
  spawnSync('bash', [join(sb.dir, script), ...args], { input, encoding: 'utf8', env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, DEPLOY_WAIT_SECONDS: '0' } });

describe('deploy.sh', () => {
  const withSecret = () => on({}, { env: [{ key: 'API_TOKEN', value: '', secret: true }] });

  test('is valid bash', () => {
    const sb = sandbox(withSecret());
    expect(() => execFileSync('bash', ['-n', join(sb.dir, 'deploy.sh')])).not.toThrow();
    expect(() => execFileSync('bash', ['-n', join(sb.dir, 'destroy.sh')])).not.toThrow();
  });

  test('runs the steps in order and builds for the server CPU type', () => {
    const sb = sandbox(withSecret());
    const r = run(sb, 'deploy.sh', ['--yes'], 'hunter2\n');
    expect(r.status).toBe(0);
    const calls = sb.calls().split('\n');
    const at = (needle: string) => calls.findIndex((l) => l.includes(needle));
    expect(at('terraform -chdir=ec2 apply -auto-approve')).toBeGreaterThan(-1);
    expect(at('ssm put-parameter')).toBeGreaterThan(at('terraform -chdir=ec2 apply'));
    expect(at('docker build --platform linux/amd64')).toBeGreaterThan(at('ssm put-parameter'));
    expect(at('docker push')).toBeGreaterThan(at('docker build'));
    expect(at('ssm send-command')).toBeGreaterThan(at('docker push'));
    expect(calls.join('\n')).toContain('123456789012.dkr.ecr.us-east-1.amazonaws.com/my-app:latest');
    expect(r.stdout).toContain('Not answering yet');           // curl stand-in always fails, so it reports honestly
  });

  test('without --yes Terraform is left to ask for confirmation', () => {
    const sb = sandbox(on());
    run(sb, 'deploy.sh');
    expect(sb.calls()).toMatch(/^terraform -chdir=ec2 apply$/m);
    expect(sb.calls()).not.toContain('-auto-approve');
  });

  test('a secret is asked for once, stored from a file (never on the command line), and skipped when it already exists', () => {
    const fresh = sandbox(withSecret());
    run(fresh, 'deploy.sh', ['--yes'], 'hunter2\n');
    expect(readFileSync(join(fresh.dir, 'stored-secret'), 'utf8')).toBe('hunter2');
    expect(fresh.calls()).not.toContain('hunter2');
    expect(fresh.calls()).not.toContain('VALUE-ON-COMMAND-LINE');
    expect(fresh.calls()).toContain('--type SecureString');

    const existing = sandbox(withSecret(), { secretExists: true });
    const r = run(existing, 'deploy.sh', ['--yes'], '');
    expect(r.status).toBe(0);
    expect(existing.calls()).not.toContain('put-parameter');
    expect(r.stdout).toContain('already stored');
  });

  test('an empty secret stops the deploy before anything is built', () => {
    const sb = sandbox(withSecret());
    const r = run(sb, 'deploy.sh', ['--yes'], '\n');
    expect(r.status).not.toBe(0);
    expect(sb.calls()).not.toContain('docker build');
  });

  test('no secrets: works with an empty list on any bash (no unbound variable)', () => {
    const r = run(sandbox(on()), 'deploy.sh', ['--yes']);
    expect(r.status).toBe(0);
  });

  test('a restart that Session Manager cannot deliver yet is not a failure', () => {
    const r = run(sandbox(on(), { ssmFails: true }), 'deploy.sh', ['--yes']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('starts the app by itself');
  });

  test('stops with a clear message when a tool is missing', () => {
    const sb = sandbox(on());
    const r = spawnSync('/bin/bash', [join(sb.dir, 'deploy.sh'), '--yes'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', DEPLOY_WAIT_SECONDS: '0' } as unknown as NodeJS.ProcessEnv });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/Missing tool: terraform/);
  });
});

describe('destroy.sh', () => {
  test('needs the app name typed, then destroys and offers to delete secrets', () => {
    const c = on({}, { env: [{ key: 'API_TOKEN', value: '', secret: true }] });
    const no = sandbox(c);
    expect(run(no, 'destroy.sh', [], 'wrong\n').status).not.toBe(0);
    expect(no.calls()).not.toContain('destroy');

    const yes = sandbox(c);
    const r = run(yes, 'destroy.sh', [], 'my-app\ny\n');
    expect(r.status).toBe(0);
    expect(yes.calls()).toContain('terraform -chdir=ec2 destroy -auto-approve');
    expect(yes.calls()).toContain('ssm delete-parameter --region us-east-1 --name /my-app/API_TOKEN');
  });
  test('the repository can be destroyed even though it holds images', () => {
    expect(gen(on()).files['ec2/main.tf']).toContain('force_delete         = true');
  });
});

describe('GitHub role', () => {
  test('not created unless a repository is given', () => {
    const { files } = gen(on());
    expect('ec2/github_oidc.tf' in files).toBe(false);
    expect(files['ec2/outputs.tf']).not.toContain('github_role_arn');
    expect(files['.github/workflows/deploy.yml']).toContain('Tip: set "GitHub repository"');
  });
  test('with a repository: role limited to that repo and the main branch, pushing only to this ECR repository', () => {
    const { files } = gen(on({ githubRepo: 'acme/shop' }));
    expect(files['ec2/github_oidc.tf']).toContain('repo:${var.github_repository}:ref:refs/heads/main');
    expect(files['ec2/github_oidc.tf']).toContain('resources = [aws_ecr_repository.app.arn]');
    expect(files['ec2/github_oidc.tf']).not.toMatch(/"repo:\*|StringLike/);
    expect(files['ec2/variables.tf']).toContain('"acme/shop"');
    expect(files['ec2/outputs.tf']).toContain('github_role_arn');
    expect(files['.github/workflows/deploy.yml']).toContain('terraform -chdir=ec2 output -raw github_role_arn');
    for (const [p, c] of Object.entries(files).filter(([p]) => p.endsWith('.tf'))) {
      for (const [o, cl] of [['{', '}'], ['[', ']'], ['(', ')']]) expect([p, c.split(o).length]).toEqual([p, c.split(cl).length]);
    }
  });
  test.each(['acme', 'acme/', '/shop', 'a b/c', 'acme/shop;rm', 'acme/shop"x'])('rejects the repository "%s"', (repo) => {
    expect(validate(on({ githubRepo: repo })).length).toBeGreaterThan(0);
  });
});

describe('README and files', () => {
  test('starts with the one-command path and names the secrets', () => {
    const r = gen(on({}, { env: [{ key: 'API_TOKEN', value: '', secret: true }] })).files['ec2/README.md']!;
    expect(r.indexOf('bash deploy.sh')).toBeGreaterThan(-1);
    expect(r.indexOf('bash deploy.sh')).toBeLessThan(r.indexOf('## What gets created'));
    expect(r).toContain('API_TOKEN');
  });
  test('Terraform state stays out of Git', () => {
    expect(gen(on()).files['ec2/.gitignore']).toContain('*.tfstate');
  });
});

describe('zip keeps scripts executable', () => {
  test('deploy.sh has Unix mode 0755 in the archive; other files have none', () => {
    const { list } = gen(on());
    const z = buildZip(list, 'app');
    const dv = new DataView(z.buffer);
    const entries = dv.getUint16(z.length - 22 + 10, true);
    let pos = dv.getUint32(z.length - 22 + 16, true);
    const modes: Record<string, number> = {};
    for (let i = 0; i < entries; i++) {
      const nameLen = dv.getUint16(pos + 28, true), extra = dv.getUint16(pos + 30, true), comment = dv.getUint16(pos + 32, true);
      const name = new TextDecoder().decode(z.slice(pos + 46, pos + 46 + nameLen));
      modes[name] = dv.getUint32(pos + 38, true) >>> 16;
      expect(dv.getUint16(pos + 4, true) >> 8).toBe(name.endsWith('.sh') && !name.includes('user_data') ? 3 : 0);
      pos += 46 + nameLen + extra + comment;
    }
    expect(modes['app/deploy.sh']! & 0o777).toBe(0o755);
    expect(modes['app/destroy.sh']! & 0o777).toBe(0o755);
    expect(modes['app/ec2/main.tf']).toBe(0);
  });
});

describe('sample apps', () => {
  const full = (c: ContainerConfig) => gen({ ...c, includeSample: true });
  test('node: a lockfile that npm ci accepts, a start script and a server that reads PORT', () => {
    const { files } = full(defaultConfig('node'));
    const pkg = JSON.parse(files['package.json']!);
    expect(pkg.scripts.start).toBe('node server.js');
    expect(pkg.scripts.build).toBeDefined();
    const lock = JSON.parse(files['package-lock.json']!);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[''].name).toBe(pkg.name);
    expect(files['server.js']).toContain('process.env.PORT');
    expect(() => execFileSync('node', ['--check', '-'], { input: files['server.js'] })).not.toThrow();
  });
  test('python: FastAPI and Flask files land where the module setting points', () => {
    const fa = full({ ...defaultConfig('python'), pythonModule: 'app.main:app' }).files;
    expect(fa['app/main.py']).toContain('FastAPI');
    expect(fa['requirements.txt']).toContain('uvicorn');
    const fl = full({ ...defaultConfig('python'), pythonFramework: 'flask', pythonModule: 'wsgi:application' }).files;
    expect(fl['wsgi.py']).toContain('application = Flask');
    expect(fl['requirements.txt']).toContain('gunicorn');
  });
  test('java: Maven project with Actuator, Java version from the form', () => {
    const { files } = full({ ...defaultConfig('java'), version: '17' });
    expect(files['pom.xml']).toContain('<java.version>17</java.version>');
    expect(files['pom.xml']).toContain('spring-boot-starter-actuator');
    expect(files['src/main/java/com/example/demo/Application.java']).toContain('@SpringBootApplication');
  });
  test('static: a page and a build script that fills the configured folder', () => {
    const { files } = full({ ...defaultConfig('static'), staticBuildDir: 'build' });
    expect(files['public/index.html']).toContain('<h1>my-app</h1>');
    expect(JSON.parse(files['package.json']!).scripts.build).toContain('build/');
  });
  test('off by default; unsupported combinations say so instead of failing', () => {
    expect('server.js' in gen(defaultConfig('node')).files).toBe(false);
    expect(full({ ...defaultConfig('node'), nextStandalone: true }).warnings.join()).toMatch(/standalone/);
    expect(full({ ...defaultConfig('python'), pythonFramework: 'django', pythonModule: 'config' }).warnings.join()).toMatch(/FastAPI and Flask/);
    expect(full({ ...defaultConfig('java'), javaBuildTool: 'gradle' }).warnings.join()).toMatch(/Maven/);
  });
});

describe('starter templates', () => {
  test.each(STARTER_TEMPLATES.map((t) => [t.id, t] as const))('%s is valid and complete', (_id, t) => {
    const c = t.config();
    expect(validate(c)).toEqual([]);
    const { files, warnings } = gen(c);
    expect(c.ec2.enabled).toBe(true);
    expect(c.includeSample).toBe(true);
    for (const p of ['Dockerfile', 'deploy.sh', 'destroy.sh', 'ec2/main.tf', 'ec2/user_data.sh']) expect(files[p]).toBeDefined();
    expect(warnings.filter((w) => w.startsWith('Sample app'))).toEqual([]);
    expect(files['ec2/variables.tf']).toContain(`"${c.appName}"`);
  });
  test('the templates cover every stack with distinct names', () => {
    expect(new Set(STARTER_TEMPLATES.map((t) => t.config().stack))).toEqual(new Set(['node', 'python', 'java', 'go', 'dotnet', 'ruby', 'static']));
    expect(new Set(STARTER_TEMPLATES.map((t) => t.config().appName)).size).toBe(STARTER_TEMPLATES.length);
  });
});
