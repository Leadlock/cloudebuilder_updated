/**
 * Architecture templates as database rows: what is written for a built-in one, how a row is read back, what an organization may save, and the sync.
 */
import { architectureTemplates } from '@/lib/templates';
import { builtInRow, fromRow, graphOf, graphProblems, SaveTemplateBody, toTemplate, MAX_TEMPLATE_NODES } from '@/lib/templates/stored';
import { syncBuiltInTemplates } from '@/lib/templates/sync';
import type { ArchitectureTemplate } from '@/types';

const ref = architectureTemplates.find((t) => t.isReferenceArchitecture)!;

describe('a built-in template as a row', () => {
  test('holds what the gallery shows and the graph it makes, and the same template always gives the same hash', () => {
    const a = builtInRow(ref); const b = builtInRow(ref);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a).toMatchObject({ id: ref.id, orgId: null, source: 'builtin', name: ref.name, provider: ref.provider, category: ref.category });
    const g = ref.generate({});
    expect(JSON.parse(a.graphJson)).toEqual({ nodes: JSON.parse(JSON.stringify(g.nodes)), edges: JSON.parse(JSON.stringify(g.edges)) });
    expect(JSON.parse(a.metaJson)).toMatchObject({ isReferenceArchitecture: true });
  });
  test('a change to the template is a different hash', () => {
    const changed = { ...ref, description: `${ref.description} (changed)` } as ArchitectureTemplate;
    expect(builtInRow(changed).contentHash).not.toBe(builtInRow(ref).contentHash);
  });
  test('every built-in template can be written, with a unique id', () => {
    const rows = architectureTemplates.map(builtInRow);
    expect(new Set(rows.map((r) => r.id)).size).toBe(architectureTemplates.length);
    expect(rows.every((r) => graphOf(r as unknown as Record<string, unknown>) !== null)).toBe(true);
  });
});

describe('reading a row back', () => {
  const row = { ...builtInRow(ref), createdBy: null, createdAt: 't', updatedAt: 't' } as unknown as Record<string, unknown>;
  test('gives the template and its graph, and a template whose generate() returns a copy of the saved graph', () => {
    const t = fromRow(row);
    expect(t).toMatchObject({ id: ref.id, source: 'builtin', orgId: null, tags: ref.tags, features: ref.features });
    const graph = graphOf(row)!;
    const tpl = toTemplate(t, graph);
    const first = tpl.generate({});
    expect(first).toEqual(graph);
    first.nodes.pop();
    expect(tpl.generate({}).nodes).toHaveLength(graph.nodes.length);      // a use of the template never changes it
    expect(tpl.isReferenceArchitecture).toBe(true);
  });
  test('a damaged row is not trusted', () => {
    expect(graphOf({ graphJson: 'not json' })).toBeNull();
    expect(graphOf({ graphJson: '{"nodes":1}' })).toBeNull();
    expect(fromRow({ ...row, tagsJson: 'oops', metaJson: '[]' })).toMatchObject({ tags: [], meta: {} });
  });
});

describe('what an organization may save', () => {
  const ok = { name: 'My app', provider: 'aws', nodes: [{ id: 'a', type: 'aws_vpc', label: 'VPC', position: { x: 0, y: 0 } }, { id: 'b', type: 'aws_ec2', label: 'EC2', position: { x: 1, y: 1 } }], edges: [{ id: 'e', source: 'a', target: 'b' }] };
  test('a good template, with defaults filled in', () => {
    const r = SaveTemplateBody.parse(ok);
    expect(r).toMatchObject({ name: 'My app', category: 'Custom', description: '', tags: [] });
  });
  test.each([
    ['no name', { ...ok, name: '  ' }], ['an unknown provider', { ...ok, provider: 'gcp' }], ['no resources', { ...ok, nodes: [] }],
    ['too many resources', { ...ok, nodes: Array.from({ length: MAX_TEMPLATE_NODES + 1 }, (_, i) => ({ id: `n${i}`, type: 't', label: 'x', position: { x: 0, y: 0 } })) }],
    ['a node without a position', { ...ok, nodes: [{ id: 'a', type: 't', label: 'x' }] }], ['an infinite position', { ...ok, nodes: [{ id: 'a', type: 't', label: 'x', position: { x: Infinity, y: 0 } }] }],
  ])('refuses %s', (_n, body) => { expect(SaveTemplateBody.safeParse(body).success).toBe(false); });
  test('a connection to nothing, a repeated id and a huge template are refused', () => {
    expect(graphProblems([{ id: 'a' }], [{ source: 'a', target: 'zzz' }])).toEqual(['A connection points at a resource that is not in the template.']);
    expect(graphProblems([{ id: 'a' }, { id: 'a' }], [])).toEqual(['Two resources have the same id.']);
    expect(graphProblems([{ id: 'a', x: 'y'.repeat(1_100_000) } as { id: string }], [])).toEqual(['The template is larger than 1 MB.']);
    expect(graphProblems([{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'b' }])).toEqual([]);
  });
});

describe('the sync from the code', () => {
  function fakeStore(initial: Record<string, string> = {}) {
    const hashes = new Map(Object.entries(initial)); const writes: string[] = []; let removedIds: string[] = [];
    return {
      writes, get removed() { return removedIds; }, hashes,
      builtInHashes: async () => new Map(hashes),
      upsertBuiltIn: async (r: { id: string; contentHash: string }) => { hashes.set(r.id, r.contentHash); writes.push(r.id); },
      deleteBuiltInExcept: async (keep: string[]) => { removedIds = [...hashes.keys()].filter((id) => !keep.includes(id)); removedIds.forEach((id) => hashes.delete(id)); return removedIds.length; },
    };
  }
  const three = architectureTemplates.slice(0, 3);
  test('writes every template the first time, and nothing the second', async () => {
    const s = fakeStore();
    expect(await syncBuiltInTemplates(s, three)).toEqual({ added: 3, updated: 0, removed: 0, unchanged: 0 });
    expect(await syncBuiltInTemplates(s, three)).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 3 });
    expect(s.writes).toHaveLength(3);
  });
  test('updates a template that changed and removes one that is no longer in the code', async () => {
    const s = fakeStore();
    await syncBuiltInTemplates(s, three);
    const changed = [{ ...three[0]!, name: 'Renamed' } as ArchitectureTemplate, three[1]!];
    expect(await syncBuiltInTemplates(s, changed)).toEqual({ added: 0, updated: 1, removed: 1, unchanged: 1 });
    expect(s.removed).toEqual([three[2]!.id]);
  });
});
