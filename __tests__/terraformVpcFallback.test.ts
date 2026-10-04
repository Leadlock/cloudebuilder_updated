/**
 * A resource that needs a VPC but is not in or connected to one must never produce a reference to a VPC that is not declared.
 * Terraform rejected the whole plan ("Reference to undeclared resource ... aws_vpc.main") for a security group drawn outside any VPC.
 */
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';

const res = (o: Partial<DbArchitectureResource> & { id: string; resourceType: string }): DbArchitectureResource => ({
  provider: 'aws', label: o.id, positionX: 0, positionY: 0, configJson: '{}', region: null, groupId: null, locked: false, architectureId: 'a', ...o,
} as DbArchitectureResource);
const conn = (sourceId: string, targetId: string): DbArchitectureConnection => ({ id: `${sourceId}-${targetId}`, label: null, edgeType: null, sourceId, targetId, architectureId: 'a' });

const gen = (resources: DbArchitectureResource[], connections: DbArchitectureConnection[] = []) => {
  const r = new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections });
  return { main: r.files.find((f) => f.filename === 'main.tf')!.content, warnings: r.warnings };
};

/** Every `aws_vpc.<name>` reference must have a matching `resource "aws_vpc" "<name>"`. */
function undeclaredVpcRefs(main: string): string[] {
  const declared = new Set([...main.matchAll(/resource "aws_vpc" "([^"]+)"/g)].map((m) => m[1]));
  return [...main.matchAll(/(?<![."\w])aws_vpc\.([A-Za-z0-9_-]+)\./g)].map((m) => m[1]!).filter((n) => !declared.has(n));
}

describe('VPC references are always declared', () => {
  test('a security group with no VPC at all uses the default VPC data source', () => {
    const { main, warnings } = gen([res({ id: 'sg', resourceType: 'aws_sg', label: 'Services SG' })]);
    expect(main).toContain('data "aws_vpc" "default"');
    expect(main).toMatch(/vpc_id\s*=\s*data\.aws_vpc\.default\.id/);
    expect(main).not.toContain('aws_vpc.main');
    expect(undeclaredVpcRefs(main)).toEqual([]);
    expect(warnings.join(' ')).toMatch(/Services SG.*default VPC/);
  });

  test('the default VPC is declared once, however many resources need it', () => {
    const { main } = gen([res({ id: 'sg1', resourceType: 'aws_sg' }), res({ id: 'sg2', resourceType: 'aws_sg' }), res({ id: 'igw', resourceType: 'aws_igw' })]);
    expect(main.match(/data "aws_vpc" "default"/g)).toHaveLength(1);
  });

  test('no default VPC is declared when every resource is inside a VPC', () => {
    const { main } = gen([res({ id: 'vpc', resourceType: 'aws_vpc', configJson: JSON.stringify({ name: 'main_vpc' }) }), res({ id: 'sg', resourceType: 'aws_sg', groupId: 'vpc' })]);
    expect(main).not.toContain('data "aws_vpc" "default"');
    expect(main).toMatch(/vpc_id\s*=\s*aws_vpc\.main_vpc\.id/);
  });

  test('an unconnected security group is placed in the architecture\'s only VPC, with a warning', () => {
    const { main, warnings } = gen([res({ id: 'vpc', resourceType: 'aws_vpc', label: 'Prod VPC', configJson: JSON.stringify({ name: 'prod_vpc' }) }), res({ id: 'sg', resourceType: 'aws_sg' })]);
    expect(main).toMatch(/vpc_id\s*=\s*aws_vpc\.prod_vpc\.id/);
    expect(main).not.toContain('data "aws_vpc" "default"');
    expect(warnings.join(' ')).toMatch(/only VPC/);
  });

  test('with several VPCs and no hint, the default VPC is used rather than guessing one', () => {
    const { main } = gen([
      res({ id: 'v1', resourceType: 'aws_vpc', configJson: JSON.stringify({ name: 'a' }) }),
      res({ id: 'v2', resourceType: 'aws_vpc', configJson: JSON.stringify({ name: 'b' }) }),
      res({ id: 'sg', resourceType: 'aws_sg' }),
    ]);
    expect(main).toMatch(/vpc_id\s*=\s*data\.aws_vpc\.default\.id/);
  });

  test('a resource connected to a subnet takes that subnet\'s VPC', () => {
    const { main } = gen([
      res({ id: 'v1', resourceType: 'aws_vpc', configJson: JSON.stringify({ name: 'a' }) }),
      res({ id: 'v2', resourceType: 'aws_vpc', configJson: JSON.stringify({ name: 'b' }) }),
      res({ id: 'sn', resourceType: 'aws_subnet', groupId: 'v2', configJson: JSON.stringify({ name: 'sn_b' }) }),
      res({ id: 'sg', resourceType: 'aws_sg', configJson: JSON.stringify({ name: 'my_sg' }) }),
    ], [conn('sg', 'sn')]);
    const start = main.indexOf('resource "aws_security_group"');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = main.slice(start, main.indexOf('\n}\n', start));
    expect(block).toMatch(/vpc_id\s*=\s*aws_vpc\.b\.id/);
  });

  test('a private Route 53 zone gets a declared VPC', () => {
    const { main } = gen([res({ id: 'z', resourceType: 'aws_route53', configJson: JSON.stringify({ hostedZoneType: 'Private', domainName: 'internal.example.com' }) })]);
    expect(main).toMatch(/vpc_id\s*=\s*data\.aws_vpc\.default\.id/);
    expect(undeclaredVpcRefs(main)).toEqual([]);
  });

  test('an internet gateway and a route table outside a VPC also resolve', () => {
    const { main } = gen([res({ id: 'igw', resourceType: 'aws_igw' }), res({ id: 'rt', resourceType: 'aws_route_table' }), res({ id: 'nacl', resourceType: 'aws_nacl' })]);
    expect(main).not.toContain('aws_vpc.main');
    expect(undeclaredVpcRefs(main)).toEqual([]);
  });
});
