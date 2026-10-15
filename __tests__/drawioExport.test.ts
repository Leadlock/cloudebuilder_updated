/**
 * @jest-environment jsdom
 */
/**
 * The draw.io export: well-formed XML that draw.io accepts, every box and arrow of the architecture, containers that hold their members,
 * and no way for a name in the architecture to break out of the file.
 */
import { drawioFileName, drawioFileXml, drawioModelXml } from '@/lib/engines/export/drawio';
import type { CanvasEdge, CanvasNode } from '@/types';

const node = (id: string, resourceType: string, label: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, type: 'cloudNode', resourceType, provider: resourceType.startsWith('azure_') ? 'azure' : 'aws', label, position: { x, y }, config: {}, ...extra,
});
const edge = (id: string, source: string, target: string, extra: Partial<CanvasEdge> = {}): CanvasEdge => ({ id, source, target, ...extra });

const parse = (xml: string) => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return doc;
};
const cells = (xml: string) => Array.from(parse(xml).getElementsByTagName('mxCell'));

const sample = {
  title: 'Shop',
  nodes: [
    node('vpc', 'aws_vpc', 'Main VPC', 100, 100, { type: 'containerNode', width: 600, height: 400 }),
    node('sub', 'aws_subnet', 'Public', 140, 160, { type: 'containerNode', groupId: 'vpc', width: 300, height: 200 }),
    node('web', 'aws_ec2', 'Web', 180, 220, { groupId: 'sub' }),
    node('db', 'aws_rds', 'Orders DB', 480, 220, { groupId: 'vpc' }),
  ],
  edges: [edge('e1', 'web', 'db', { label: 'SQL', protocol: 'tcp', port: 5432 })],
};

describe('draw.io export', () => {
  test('is well-formed XML with the two root cells draw.io needs', () => {
    const all = cells(drawioModelXml(sample));
    expect(all[0]!.getAttribute('id')).toBe('0');
    expect(all[1]!.getAttribute('id')).toBe('1');
    expect(all[1]!.getAttribute('parent')).toBe('0');
  });

  test('has a box for every resource and an arrow for every connection, with unique ids', () => {
    const all = cells(drawioModelXml(sample));
    expect(all.filter((c) => c.getAttribute('vertex') === '1')).toHaveLength(4);
    expect(all.filter((c) => c.getAttribute('edge') === '1')).toHaveLength(1);
    const ids = all.map((c) => c.getAttribute('id'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the arrow joins the right boxes and carries its label, protocol and port', () => {
    const e = cells(drawioModelXml(sample)).find((c) => c.getAttribute('edge') === '1')!;
    expect(e.getAttribute('source')).toBe('n-web');
    expect(e.getAttribute('target')).toBe('n-db');
    expect(e.getAttribute('value')).toBe('SQL · tcp/5432');
  });

  test('groups are containers and hold their members, with positions relative to the group', () => {
    const all = cells(drawioModelXml(sample));
    const byId = (id: string) => all.find((c) => c.getAttribute('id') === id)!;
    expect(byId('n-vpc').getAttribute('style')).toContain('container=1');
    expect(byId('n-vpc').getAttribute('parent')).toBe('1');
    expect(byId('n-sub').getAttribute('parent')).toBe('n-vpc');
    expect(byId('n-web').getAttribute('parent')).toBe('n-sub');
    const geo = (id: string) => byId(id).getElementsByTagName('mxGeometry')[0]!;
    expect(geo('n-sub').getAttribute('x')).toBe('40');   // 140 - 100
    expect(geo('n-web').getAttribute('x')).toBe('40');   // 180 - 140
    expect(geo('n-web').getAttribute('y')).toBe('60');   // 220 - 160
  });

  test('containers come before what they hold, so they are drawn underneath', () => {
    const ids = cells(drawioModelXml(sample)).map((c) => c.getAttribute('id'));
    expect(ids.indexOf('n-vpc')).toBeLessThan(ids.indexOf('n-sub'));
    expect(ids.indexOf('n-sub')).toBeLessThan(ids.indexOf('n-web'));
  });

  test('a database is drawn as a cylinder and an Azure box uses the Azure colour', () => {
    const all = cells(drawioModelXml({ title: 'x', edges: [], nodes: [node('d', 'aws_rds', 'DB', 0, 0), node('a', 'azure_vm', 'VM', 200, 0)] }));
    expect(all.find((c) => c.getAttribute('id') === 'n-d')!.getAttribute('style')).toContain('shape=cylinder3');
    expect(all.find((c) => c.getAttribute('id') === 'n-a')!.getAttribute('style')).toContain('#0078D4');
  });

  test('a container with no size of its own wraps its members', () => {
    const all = cells(drawioModelXml({ title: 'x', edges: [], nodes: [node('g', 'aws_vpc', 'VPC', 500, 500, { type: 'containerNode' }), node('a', 'aws_ec2', 'A', 100, 100, { groupId: 'g' }), node('b', 'aws_ec2', 'B', 400, 300, { groupId: 'g' })] }));
    const g = all.find((c) => c.getAttribute('id') === 'n-g')!.getElementsByTagName('mxGeometry')[0]!;
    expect(Number(g.getAttribute('width'))).toBeGreaterThan(450);
    expect(Number(g.getAttribute('height'))).toBeGreaterThan(300);
    expect(Number(g.getAttribute('x'))).toBeLessThan(100);
  });

  test('arrows to resources that are not on the canvas, and arrows to themselves, are left out', () => {
    const all = cells(drawioModelXml({ ...sample, edges: [edge('x', 'web', 'ghost'), edge('y', 'web', 'web'), edge('z', 'web', 'db')] }));
    expect(all.filter((c) => c.getAttribute('edge') === '1')).toHaveLength(1);
  });

  test('parents that point at each other do not hang or break the file', () => {
    const all = cells(drawioModelXml({ title: 'x', edges: [], nodes: [node('a', 'aws_vpc', 'A', 0, 0, { groupId: 'b', width: 100, height: 100 }), node('b', 'aws_vpc', 'B', 0, 0, { groupId: 'a', width: 100, height: 100 })] }));
    expect(all.filter((c) => c.getAttribute('vertex') === '1')).toHaveLength(2);
  });

  test('a name that looks like markup stays plain text, and cannot break out of the attribute', () => {
    const evil = `</mxCell><mxCell id="x" value="pwned"/><script>alert(1)</script> "quoted" & 'single'`;
    const xml = drawioModelXml({ title: evil, edges: [edge('e', 'a', 'b', { label: evil })], nodes: [node('a', 'aws_ec2', evil, 0, 0), node('b', 'aws_ec2', 'B', 300, 0)] });
    const all = cells(xml);
    expect(all.some((c) => c.getAttribute('id') === 'x')).toBe(false);
    const value = all.find((c) => c.getAttribute('id') === 'n-a')!.getAttribute('value')!;
    expect(value).not.toContain('<script>');
    expect(value).toContain('&lt;script&gt;');
  });

  test('an id that looks like markup cannot break the file either', () => {
    const xml = drawioModelXml({ title: 'x', edges: [edge('e"><x', 'a"b', 'b')], nodes: [node('a"b', 'aws_ec2', 'A', 0, 0), node('b', 'aws_ec2', 'B', 300, 0)] });
    expect(() => cells(xml)).not.toThrow();
  });

  test('the file wraps the same model and names the diagram', () => {
    const xml = drawioFileXml({ ...sample, title: 'Shop & "Co"' });
    const doc = parse(xml);
    expect(doc.documentElement.tagName).toBe('mxfile');
    expect(doc.getElementsByTagName('diagram')[0]!.getAttribute('name')).toBe('Shop & "Co"');
    expect(doc.getElementsByTagName('mxGraphModel')).toHaveLength(1);
  });

  test('an empty architecture still gives a valid file', () => {
    expect(cells(drawioModelXml({ title: 'x', nodes: [], edges: [] }))).toHaveLength(2);
  });

  test('file names are safe', () => {
    expect(drawioFileName('My Shop / v2!')).toBe('my-shop-v2.drawio');
    expect(drawioFileName('')).toBe('architecture.drawio');
    expect(drawioFileName('../../etc')).toBe('etc.drawio');
  });
});
