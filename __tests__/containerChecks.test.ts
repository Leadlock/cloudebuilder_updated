import { checkContainer } from '@/lib/engines/containers/checks';
import { defaultConfig, generateContainerFiles, STARTER_TEMPLATES, type ContainerConfig, type GeneratedFile } from '@/lib/engines/containers/dockerTemplates';
import { estimateEc2Cost } from '@/lib/engines/containers/ec2Deploy';

function gen(c: ContainerConfig) {
  const r = generateContainerFiles(c);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r;
}
const ids = (c: ContainerConfig, files?: GeneratedFile[]) => checkContainer(c, files ?? gen(c).files).map((f) => f.id);
const withEc2 = (c: ContainerConfig, over: Partial<ContainerConfig['ec2']> = {}): ContainerConfig => ({ ...c, ec2: { ...c.ec2, enabled: true, ...over } });

describe('what CloudCraft generates passes its own checks', () => {
  test.each(['node', 'python', 'java', 'static'] as const)('%s with databases and EC2: nothing high', (stack) => {
    const c = withEc2({ ...defaultConfig(stack), postgres: true, redis: true, ec2: { ...defaultConfig(stack).ec2, imageTag: 'v1', allowedCidr: '10.0.0.0/8' } });
    const f = checkContainer(c, gen(c).files);
    expect(f.filter((x) => x.severity !== 'low')).toEqual([]);
  });
  test.each(STARTER_TEMPLATES.map((t) => [t.id, t] as const))('starter %s has no high finding', (_id, t) => {
    expect(checkContainer(t.config(), gen(t.config()).files).filter((f) => f.severity === 'high')).toEqual([]);
  });
  it('is returned with the generated files', () => {
    expect(Array.isArray(gen(defaultConfig('node')).findings)).toBe(true);
  });
});

describe('each rule fires on the problem it is named for', () => {
  const base = () => defaultConfig('node');
  const edit = (c: ContainerConfig, file: string, fn: (s: string) => string): GeneratedFile[] =>
    gen(c).files.map((f) => (f.path === file ? { ...f, content: fn(f.content) } : f));

  it('CT-001 unpinned base image, in the Dockerfile and in compose, but not a build-stage name', () => {
    const c = base();
    expect(ids(c, edit(c, 'Dockerfile', (s) => s.replace('FROM node:22-alpine AS runtime', 'FROM node AS runtime')))).toContain('CT-001');
    expect(ids(c, edit(c, 'Dockerfile', (s) => s.replace('FROM node:22-alpine AS runtime', 'FROM node:latest AS runtime')))).toContain('CT-001');
    expect(ids(c, edit(c, 'Dockerfile', (s) => s.replace('FROM node:22-alpine AS runtime', 'FROM build AS runtime')))).not.toContain('CT-001');
    const db = { ...c, postgres: true };
    expect(ids(db, edit(db, 'docker-compose.yml', (s) => s.replace('postgres:16-alpine', 'postgres:latest')))).toContain('CT-001');
  });
  it('CT-002 root', () => {
    const c = base();
    expect(ids(c, edit(c, 'Dockerfile', (s) => s.replace('USER app\n', '')))).toContain('CT-002');
    expect(ids({ ...c, runAsNonRoot: false })).toContain('CT-002');
    expect(ids(defaultConfig('static'))).not.toContain('CT-002');
  });
  it('CT-003 no health check', () => {
    const c = base();
    expect(ids(c, edit(c, 'Dockerfile', (s) => s.replace(/^HEALTHCHECK.*$/m, '')))).toContain('CT-003');
  });
  it('CT-004 curl pipe sh and ADD from a URL', () => {
    const c = base();
    expect(ids(c, edit(c, 'Dockerfile', (s) => s + 'RUN curl -fsSL https://x.example/i.sh | sh\n'))).toContain('CT-004');
    expect(ids(c, edit(c, 'Dockerfile', (s) => s + 'ADD https://x.example/a.tgz /a\n'))).toContain('CT-004');
  });
  it('CT-005 .env not ignored', () => {
    const c = base();
    expect(ids(c, edit(c, '.dockerignore', (s) => s.replace(/^\.env$/m, '')))).toContain('CT-005');
  });
  it('CT-006 secret-looking variable stored as plain text, by name or by a password in a URL', () => {
    expect(ids({ ...base(), env: [{ key: 'API_TOKEN', value: 'abc' }] })).toContain('CT-006');
    expect(ids({ ...base(), env: [{ key: 'DB', value: 'postgres://u:pw@h/d' }] })).toContain('CT-006');
    expect(ids({ ...base(), env: [{ key: 'API_TOKEN', value: '', secret: true }] })).not.toContain('CT-006');
    expect(ids({ ...base(), env: [{ key: 'LOG_LEVEL', value: 'debug' }] })).not.toContain('CT-006');
  });
  it('CT-007 control of the host', () => {
    const c = base();
    for (const add of ['    privileged: true\n', '    network_mode: host\n', '    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n'])
      expect(ids(c, edit(c, 'docker-compose.yml', (s) => s.replace('    restart:', add + '    restart:')))).toContain('CT-007');
  });
  it('CT-008 database published on the host', () => {
    const c = { ...base(), postgres: true };
    expect(ids(c, edit(c, 'docker-compose.yml', (s) => s.replace('    image: postgres:16-alpine\n', '    image: postgres:16-alpine\n    ports:\n      - "5432:5432"\n')))).toContain('CT-008');
    expect(ids(c)).not.toContain('CT-008');
  });
  it('CT-009 limits and CT-010 restart', () => {
    const c = base();
    expect(ids(c, edit(c, 'docker-compose.yml', (s) => s.replace(/^\s+mem_limit:.*$/m, '')))).toContain('CT-009');
    expect(ids({ ...base(), restart: 'no' })).toContain('CT-010');
  });
  it('CT-011 open port, CT-016 latest tag, CT-015 no scan', () => {
    const c = withEc2(base());
    expect(ids(c)).toEqual(expect.arrayContaining(['CT-011', 'CT-016']));
    expect(ids(withEc2(base(), { allowedCidr: '10.0.0.0/8', imageTag: 'v1' }))).not.toEqual(expect.arrayContaining(['CT-011']));
    expect(ids(withEc2(base(), { scanImage: false }))).toContain('CT-015');
    expect(ids(withEc2(base()))).not.toContain('CT-015');
  });
  it('CT-012/13/14 weakened Terraform', () => {
    const c = withEc2(base());
    expect(ids(c, edit(c, 'ec2/main.tf', (s) => s.replace('http_tokens   = "required"', 'http_tokens   = "optional"')))).toContain('CT-012');
    expect(ids(c, edit(c, 'ec2/main.tf', (s) => s.replace('encrypted   = true', 'encrypted   = false')))).toContain('CT-013');
    expect(ids(c, edit(c, 'ec2/main.tf', (s) => s + '\nresource "aws_security_group_rule" "ssh" {\n  from_port = 22\n}\n'))).toContain('CT-014');
  });
  it('is sorted most severe first and has no repeats', () => {
    const c = { ...withEc2(base(), { scanImage: false }), runAsNonRoot: false, restart: 'no' as const, env: [{ key: 'DB_PASSWORD', value: 'x' }] };
    const f = checkContainer(c, gen(c).files);
    const order = { high: 0, medium: 1, low: 2 };
    expect(f.map((x) => order[x.severity])).toEqual(f.map((x) => order[x.severity]).slice().sort());
    expect(new Set(f.map((x) => `${x.id}|${x.title}`)).size).toBe(f.length);
  });
});

describe('image scan in the workflow', () => {
  const wf = (over = {}) => gen(withEc2(defaultConfig('node'), over)).files.find((f) => f.path === '.github/workflows/deploy.yml')!.content;
  it('scans the built image after the build and before the push, pinned to a commit', () => {
    const w = wf();
    expect(w.indexOf('docker build')).toBeLessThan(w.indexOf('aquasecurity/trivy-action@'));
    expect(w.indexOf('aquasecurity/trivy-action@')).toBeLessThan(w.indexOf('docker push'));
    expect(w).toMatch(/trivy-action@[0-9a-f]{40} # v0\.28\.0/);
    expect(w).toContain("exit-code: '1'");
    expect(w).toContain('severity: HIGH,CRITICAL');
  });
  it('can be left out', () => {
    expect(wf({ scanImage: false })).not.toContain('trivy');
    expect(wf({ scanImage: false })).toContain('docker push');
  });
});

describe('EC2 monthly cost', () => {
  it('is undefined when EC2 is off', () => expect(estimateEc2Cost(defaultConfig('node'))).toBeUndefined());
  it('adds instance, disk and public IP at list price', () => {
    const cost = estimateEc2Cost(withEc2(defaultConfig('node'), { instanceType: 't3.small', volumeGb: 20 }))!;
    expect(cost.lines.map((l) => l.monthlyUsd)).toEqual([15.18, 1.6, 3.65]);
    expect(cost.monthlyUsd).toBe(20.43);
  });
  it('says so when it cannot price the instance type, and when the region is not us-east-1', () => {
    const cost = estimateEc2Cost(withEc2(defaultConfig('node'), { instanceType: 'z9.huge', region: 'eu-west-1' }))!;
    expect(cost.notes.join(' ')).toContain('not in the price table');
    expect(cost.notes.join(' ')).toContain('us-east-1');
  });
  it('is returned with the generated files', () => {
    expect(gen(withEc2(defaultConfig('node'))).cost?.monthlyUsd).toBeGreaterThan(0);
  });
});
