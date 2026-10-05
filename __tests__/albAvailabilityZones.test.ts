/**
 * A load balancer needs subnets in two different Availability Zones. AWS refuses it only when the load balancer is created, after the
 * resources before it were already built (the deployment that built 34 resources and then failed on this). The generator now picks one
 * subnet per zone and stops the plan when two zones cannot be found.
 */
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';

const res = (o: Partial<DbArchitectureResource> & { id: string; resourceType: string }): DbArchitectureResource => ({
  provider: 'aws', label: o.id, positionX: 0, positionY: 0, configJson: '{}', region: null, groupId: null, locked: false, architectureId: 'a', ...o,
} as DbArchitectureResource);
const conn = (sourceId: string, targetId: string): DbArchitectureConnection => ({ id: `${sourceId}-${targetId}`, label: null, edgeType: null, sourceId, targetId, architectureId: 'a' });
const named = (id: string, resourceType: string, name: string, extra: Record<string, unknown> = {}, over: Partial<DbArchitectureResource> = {}) =>
  res({ id, resourceType, label: name, configJson: JSON.stringify({ name, ...extra }), ...over });

const vpc = named('vpc', 'aws_vpc', 'main_vpc');
const gen = (resources: DbArchitectureResource[], connections: DbArchitectureConnection[]) => {
  const r = new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections });
  const main = r.files.find((f) => f.filename === 'main.tf')!.content;
  const lb = main.slice(main.indexOf('resource "aws_lb"'), main.indexOf('\n}\n', main.indexOf('resource "aws_lb"')));
  return { main, lb, warnings: r.warnings, blocking: r.blocking ?? [] };
};
const subnetsIn = (lb: string) => [...lb.matchAll(/aws_subnet\.([A-Za-z0-9_]+)\.id/g)].map((m) => m[1]!);

describe('load balancer subnets span two Availability Zones', () => {
  test('two connected subnets in different zones are both used and nothing is blocked', () => {
    const r = gen([vpc, named('sa', 'aws_subnet', 'public_a', {}, { groupId: 'vpc' }), named('sb', 'aws_subnet', 'public_b', {}, { groupId: 'vpc' }), named('alb', 'aws_alb', 'web_alb', {}, { groupId: 'vpc' })],
      [conn('alb', 'sa'), conn('alb', 'sb')]);
    expect(subnetsIn(r.lb).sort()).toEqual(['public_a', 'public_b']);
    expect(r.blocking).toEqual([]);
  });

  test('two connected subnets in the SAME zone: the second is not used, and a subnet in another zone is found instead', () => {
    // public_a and private_a are both zone a; private_b is zone b.
    const r = gen([vpc, named('s1', 'aws_subnet', 'public_a', {}, { groupId: 'vpc' }), named('s2', 'aws_subnet', 'private_a', {}, { groupId: 'vpc' }), named('s3', 'aws_subnet', 'private_b', {}, { groupId: 'vpc' }),
      named('alb', 'aws_alb', 'web_alb', {}, { groupId: 'vpc' })], [conn('alb', 's1'), conn('alb', 's2')]);
    const used = subnetsIn(r.lb);
    expect(used).toContain('public_a');
    expect(used).not.toContain('private_a');            // never two subnets of one zone
    expect(used).toContain('private_b');
    expect(r.blocking).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/internet-facing.*private subnet "private_b".*second PUBLIC subnet/);
  });

  test('an internal load balancer may use private subnets without that warning', () => {
    const r = gen([vpc, named('s1', 'aws_subnet', 'app_a', {}, { groupId: 'vpc' }), named('s2', 'aws_subnet', 'app_b', {}, { groupId: 'vpc' }), named('alb', 'aws_alb', 'int_alb', { scheme: 'internal' }, { groupId: 'vpc' })],
      [conn('alb', 's1')]);
    expect(subnetsIn(r.lb).sort()).toEqual(['app_a', 'app_b']);
    expect(r.warnings.join(' ')).not.toMatch(/internet-facing/);
    expect(r.blocking).toEqual([]);
  });

  test('only one zone available: the plan is blocked with a plain explanation, not left to fail halfway through an apply', () => {
    const r = gen([vpc, named('s1', 'aws_subnet', 'public_a', {}, { groupId: 'vpc' }), named('s2', 'aws_subnet', 'private_a', {}, { groupId: 'vpc' }), named('alb', 'aws_alb', 'web_alb', {}, { groupId: 'vpc' })],
      [conn('alb', 's1'), conn('alb', 's2')]);
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0]).toMatch(/"web_alb" needs subnets in at least two different Availability Zones/);
    expect(r.blocking[0]).toMatch(/all in us-east-1a/);
    expect(r.blocking[0]).toMatch(/after other resources were already built/);
  });

  test('a load balancer with no subnet at all is blocked too', () => {
    expect(gen([vpc, named('alb', 'aws_alb', 'web_alb', {}, { groupId: 'vpc' })], []).blocking[0]).toMatch(/needs subnets in at least two different Availability Zones/);
  });

  test('an architecture with no load balancer is never blocked by this', () => {
    expect(gen([vpc, named('s1', 'aws_subnet', 'public_a', {}, { groupId: 'vpc' })], []).blocking).toEqual([]);
  });
});
