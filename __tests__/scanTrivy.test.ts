/**
 * The scan of the generated files: reading Trivy's report, and the rules for what fails.
 */
import { readFileSync } from 'fs';
import { atLeast, evaluate, parseTrivy, pillarOf, report, validatePolicy, type Finding, type Policy } from '@/lib/scan/trivy';
import { scanCases } from '../scripts/scan/cases';

const trivy = (misconfigs: Array<Record<string, unknown>>, target = 'project-ecs/ecs/main.tf', type = 'terraform') => ({ Results: [{ Target: target, Type: type, Misconfigurations: misconfigs }] });
const m = (id: string, severity: string, extra: Record<string, unknown> = {}) => ({ ID: id, Title: `Title of ${id}`, Severity: severity, Status: 'FAIL', CauseMetadata: { Resource: 'aws_lb.app', StartLine: 12 }, ...extra });
const f = (id: string, severity: Finding['severity'], caseName = 'project-ecs'): Finding => ({ caseName, file: 'ecs/main.tf', type: 'terraform', id, title: `Title of ${id}`, severity, resource: 'r', line: 1, pillar: 'security' });

describe('reading Trivy\'s report', () => {
  test('keeps what failed, with its case, file, resource and line, and drops passed checks and code excerpts', () => {
    const r = parseTrivy(trivy([m('AWS-0104', 'CRITICAL', { Title: '\u001b[31mOpen egress\u001b[0m' }), m('AWS-0001', 'LOW', { Status: 'PASS' }), m('AWS-0002', 'weird')]));
    expect(r).toEqual([
      { caseName: 'project-ecs', file: 'ecs/main.tf', type: 'terraform', id: 'AWS-0104', title: 'Open egress', severity: 'CRITICAL', resource: 'aws_lb.app', line: 12, pillar: 'security' },
      expect.objectContaining({ id: 'AWS-0002', severity: 'UNKNOWN' }),
    ]);
  });
  test('a file with no misconfigurations, a missing line, and a report that is not Trivy\'s', () => {
    expect(parseTrivy({ Results: [{ Target: 'a/b', Type: 'dockerfile' }] })).toEqual([]);
    expect(parseTrivy(trivy([m('KSV-0014', 'HIGH', { CauseMetadata: {} })], 'x/k8s/a.yaml', 'kubernetes'))[0]).toMatchObject({ caseName: 'x', file: 'k8s/a.yaml', line: null, resource: '' });
    expect(() => parseTrivy({})).toThrow(/not a Trivy report/);
    expect(() => parseTrivy(null)).toThrow();
  });
  test('the real output of the pinned Trivy would have these fields (checked against the policy file\'s own rules)', () => {
    const policy = JSON.parse(readFileSync('security/scan-policy.json', 'utf8')) as Policy;
    expect(validatePolicy(policy)).toEqual([]);
  });
});

describe('the pillar of a finding', () => {
  test.each([
    ['Storage account should use geo-redundant replication', 'reliability'], ['S3 Data should be versioned', 'reliability'], ['Key vault should have purge protection enabled', 'reliability'],
    ['ECS clusters should have container insights enabled', 'operational_excellence'], ['S3 Bucket Logging', 'operational_excellence'], ['Storage account should have logging enabled', 'operational_excellence'],
    ['A security group rule should not allow unrestricted egress to any IP address.', 'security'], ['Image user should not be \'root\'', 'security'],
  ])('%s is %s', (title, pillar) => { expect(pillarOf(title)).toBe(pillar); });
});

describe('what fails', () => {
  const policy = (rules: Policy['rules'], failOn: Policy['failOn'] = 'HIGH'): Policy => ({ failOn, rules });
  const accept = (id: string) => ({ id, action: 'accept' as const, reason: 'This is how the product is meant to behave, on purpose.' });
  const todo = (id: string, max: number) => ({ id, action: 'todo' as const, max, reason: 'A known gap that is to be fixed in the generator.' });

  test('a finding at the failing level with no decision fails, and one below it does not', () => {
    const r = evaluate([f('A-1', 'CRITICAL'), f('B-2', 'HIGH'), f('C-3', 'MEDIUM'), f('D-4', 'LOW')], policy([]));
    expect(r.failures.map((x) => x.id)).toEqual(['A-1', 'B-2']);
    expect(r.passed).toBe(false);
    expect(evaluate([f('C-3', 'MEDIUM'), f('D-4', 'LOW')], policy([])).passed).toBe(true);
    expect(evaluate([f('C-3', 'MEDIUM')], policy([], 'MEDIUM')).passed).toBe(false);
  });
  test('an accepted rule never fails, however many findings it has', () => {
    expect(evaluate(Array.from({ length: 50 }, () => f('AWS-0104', 'CRITICAL')), policy([accept('AWS-0104')])).passed).toBe(true);
  });
  test('a known gap may stay the size it is, but not grow: something new made it worse', () => {
    const rules = policy([todo('DS-0002', 2)]);
    expect(evaluate([f('DS-0002', 'HIGH'), f('DS-0002', 'HIGH')], rules).passed).toBe(true);
    const grown = evaluate([f('DS-0002', 'HIGH'), f('DS-0002', 'HIGH'), f('DS-0002', 'HIGH', 'another-case')], rules);
    expect(grown.passed).toBe(false);
    expect(grown.failures[0]).toMatchObject({ id: 'DS-0002', cases: ['another-case', 'project-ecs'] });
    expect(grown.failures[0]!.why).toMatch(/3 findings, more than the 2/);
  });
  test('a decision about a rule that no longer fires has to be removed, so the list holds only live decisions', () => {
    const r = evaluate([f('A-1', 'LOW')], policy([accept('GONE-1'), todo('GONE-2', 3)]));
    expect(r.stale).toEqual(['GONE-1', 'GONE-2']);
    expect(r.passed).toBe(false);
    expect(report(r, { cases: 1, trivy: '0', failOn: 'HIGH' })).toMatch(/Remove from the policy[\s\S]*GONE-1/);
  });
  test('the counts by severity and by pillar, and the worst rule first', () => {
    const r = evaluate([f('L-1', 'LOW'), f('H-1', 'HIGH'), f('H-1', 'HIGH'), f('C-1', 'CRITICAL')], policy([accept('C-1'), accept('H-1')]));
    expect(r.rules.map((x) => x.id)).toEqual(['C-1', 'H-1', 'L-1']);
    expect(r.bySeverity).toMatchObject({ CRITICAL: 1, HIGH: 2, MEDIUM: 0, LOW: 1 });
    expect(r.byPillar).toEqual({ security: 4 });
  });
  test('severity order', () => {
    expect(atLeast('CRITICAL', 'HIGH')).toBe(true);
    expect(atLeast('HIGH', 'HIGH')).toBe(true);
    expect(atLeast('MEDIUM', 'HIGH')).toBe(false);
    expect(atLeast('UNKNOWN', 'LOW')).toBe(false);
  });
});

describe('the report', () => {
  test('says what was found, what was decided, and whether it passes', () => {
    const p: Policy = { failOn: 'HIGH', rules: [{ id: 'AWS-0104', action: 'accept', reason: 'This is how the product is meant to behave, on purpose.' }] };
    const r = evaluate([f('AWS-0104', 'CRITICAL'), f('X-9', 'HIGH')], p);
    const md = report(r, { cases: 35, trivy: '0.76.1', failOn: 'HIGH' });
    expect(md).toMatch(/35 generated cases scanned with Trivy 0.76.1/);
    expect(md).toMatch(/\| AWS-0104 Title of AWS-0104 \| CRITICAL \| security \| 1 \| 1 \| accepted \|/);
    expect(md).toMatch(/\| X-9 Title of X-9 \| HIGH .* \*\*no decision\*\* \|/);
    expect(md).toMatch(/## Fails[\s\S]*X-9 \(HIGH\)/);
    expect(md.trim().endsWith('**The scan fails.**')).toBe(true);
    expect(report(evaluate([], p), { cases: 1, trivy: '0', failOn: 'HIGH' })).toMatch(/Remove from the policy/);   // its AWS-0104 entry matches nothing
  });
  test('a long title does not break the table', () => {
    const long = { ...f('AWS-0178', 'MEDIUM'), title: `VPC Flow Logs | ${'x'.repeat(300)}` };
    const md = report(evaluate([long], { failOn: 'HIGH', rules: [] }), { cases: 1, trivy: '0', failOn: 'HIGH' });
    const row = md.split('\n').find((l) => l.startsWith('| AWS-0178'))!;
    expect(row.length).toBeLessThan(200);
    expect(row.split('|').length).toBe(8);
  });
});

describe('the policy file', () => {
  const ok = { failOn: 'HIGH', rules: [{ id: 'AWS-0104', action: 'accept', reason: 'This is how the product is meant to behave, on purpose.' }] };
  test('refuses a reason that says nothing, a todo with no ceiling, a rule listed twice, and a bad level', () => {
    expect(validatePolicy(ok)).toEqual([]);
    expect(validatePolicy({ ...ok, failOn: 'NONE' })).toEqual(['failOn must be CRITICAL, HIGH, MEDIUM or LOW.']);
    expect(validatePolicy({ ...ok, rules: [{ ...ok.rules[0], reason: 'fine' }] })[0]).toMatch(/at least 30 characters/);
    expect(validatePolicy({ ...ok, rules: [{ id: 'AWS-1', action: 'todo', reason: ok.rules[0]!.reason }] })[0]).toMatch(/needs max/);
    expect(validatePolicy({ ...ok, rules: [{ ...ok.rules[0], max: 3 }] })[0]).toMatch(/accepted rule has no max/);
    expect(validatePolicy({ ...ok, rules: [ok.rules[0], ok.rules[0]] })[0]).toMatch(/listed twice/);
    expect(validatePolicy({ ...ok, rules: [{ id: 'nope', action: 'accept', reason: ok.rules[0]!.reason }] })[0]).toMatch(/id looks like/);
    expect(validatePolicy(null)).toEqual(['The policy is not an object.']);
  });
});

describe('what is scanned', () => {
  const cases = scanCases();
  test('every deployment target, as a project and as a service, with the release variants, and the canvas designs of both clouds', () => {
    const names = cases.map((c) => c.name);
    for (const t of ['ec2', 'ecs', 'azure-vm', 'container-apps', 'aks', 'kubernetes']) { expect(names).toContain(`project-${t}`); expect(names).toContain(`service-${t}`); }
    for (const t of ['ec2', 'ecs', 'azure-vm', 'container-apps']) expect(names).toContain(`project-${t}-release`);
    expect(names.filter((n) => n.startsWith('aws-')).length).toBeGreaterThanOrEqual(9);
    expect(names.filter((n) => n.startsWith('azure-')).length).toBeGreaterThanOrEqual(7);
    expect(new Set(names).size).toBe(names.length);
  });
  test('every case has files, with Terraform, a Dockerfile or manifests to look at, and nothing escapes its folder', () => {
    for (const c of cases) {
      expect(c.files.length).toBeGreaterThan(0);
      expect(c.files.some((x) => /\.tf$|Dockerfile$|\.ya?ml$/.test(x.path))).toBe(true);
      for (const x of c.files) { expect(x.path.startsWith('/')).toBe(false); expect(x.path.includes('..')).toBe(false); }
    }
  });
  test('the release variants carry what a release adds (CodeBuild or placeholders), which the downloads do not', () => {
    const tf = (n: string) => cases.find((c) => c.name === n)!.files.filter((x) => x.path.endsWith('.tf')).map((x) => x.content).join('\n');
    expect(tf('project-ec2-release')).toContain('aws_codebuild_project');
    expect(tf('project-ec2')).not.toContain('aws_codebuild_project');
    expect(tf('project-container-apps-release')).toContain('placeholder');
  });
});
