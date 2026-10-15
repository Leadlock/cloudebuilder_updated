/**
 * "Deploy only these resources": the Terraform addresses handed to `terraform plan -target`, worked out from what the generator really writes.
 */
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import { selectTargets, MAX_TARGETS } from '@/lib/terraform/execution/targetSelection';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

const row = (id: string, resourceType: string, label: string, configJson = '{}', provider = 'aws'): DbArchitectureResource => ({
  id, resourceType, provider, label, positionX: 0, positionY: 0, configJson, region: null, groupId: null, locked: false, architectureId: 'a',
});
const resources = [
  row('vpc', 'aws_vpc', 'main'),
  row('logs', 'aws_s3', 'logs'),
  row('arch', 'aws_s3', 'logs archive'),
  row('imp', 'aws_s3', 'existing', JSON.stringify({ imported: true })),
  row('web', 'aws_ec2', 'web'),
];
const generated = terraformGenerator.generate({ architectureId: 'a', projectId: 'p', resources, connections: [], projectName: 'demo' });
const label = (id: string) => resources.find((r) => r.id === id)?.label ?? id;
const pick = (...ids: string[]) => selectTargets(generated, ids, label);

describe('selectTargets', () => {
  test('a bucket comes with the parts that protect it, and only its own', () => {
    const r = pick('logs');
    expect(r.error).toBeUndefined();
    const addresses = r.addresses ?? [];
    expect(addresses).toContain('aws_s3_bucket.logs');
    // Every block that was generated for this bucket is in, so it is not deployed without its public-access block or encryption.
    const own = [...generated.files.map((f) => f.content).join('\n').matchAll(/^resource "([a-z0-9_]+)" "(logs(?:_[a-z0-9_]+)?)"/gm)].map((m) => `${m[1]}.${m[2]}`);
    expect(own.length).toBeGreaterThan(1);
    for (const a of own.filter((a) => !a.includes('logs_archive'))) expect(addresses).toContain(a);
  });

  test('a resource whose name starts with another\'s is not mistaken for part of it', () => {
    const logs = pick('logs').addresses ?? [];
    const archive = pick('arch').addresses ?? [];
    expect(logs.some((a) => a.includes('logs_archive'))).toBe(false);
    expect(archive).toContain('aws_s3_bucket.logs_archive');
    expect(archive.some((a) => a === 'aws_s3_bucket.logs')).toBe(false);
  });

  test('two resources give both sets once each, sorted', () => {
    const r = pick('logs', 'web', 'logs');
    const a = r.addresses ?? [];
    expect(a).toEqual([...new Set(a)].sort());
    expect(a).toContain('aws_s3_bucket.logs');
    expect(a.some((x) => x.startsWith('aws_instance.web'))).toBe(true);
  });

  test('an imported resource is refused: nothing is created for it', () => {
    expect(pick('imp').error).toMatch(/imported/);
  });

  test('an unknown resource, none and too many are refused', () => {
    expect(pick('nope').error).toMatch(/nothing to deploy/);
    expect(selectTargets(generated, [], label).error).toMatch(/at least one/i);
    expect(selectTargets(generated, Array.from({ length: MAX_TARGETS + 1 }, (_, i) => `x${i}`), label).error).toMatch(/at most/);
  });

  test('every address is the plain type.name form Terraform accepts, with nothing that could reach a shell or add an option', () => {
    for (const a of pick('logs', 'web', 'vpc').addresses ?? []) expect(a).toMatch(/^[A-Za-z0-9_]+\.[A-Za-z0-9_-]+$/);
  });
});
