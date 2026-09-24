/**
 * Template instantiation must produce instance-unique resource IDs: the same template in
 * Project A, Project B, and twice in one project must never share a node or edge ID
 * (architectureResource.id / architectureConnection.id are global primary keys).
 */
import fs from 'fs';
import path from 'path';
import { architectureTemplates } from '@/lib/templates';
import { instantiateTemplate, rekeyGraph } from '@/lib/domain/instantiateTemplate';
import { generateFromPrompt, generateFromWizard } from '@/lib/generator';

describe('instantiateTemplate', () => {
  test.each(architectureTemplates.map((t) => [t.id, t]))('%s: two instances share no node or edge IDs', (_id, t) => {
    const a = instantiateTemplate(t, {});
    const b = instantiateTemplate(t, {});
    const ids = (g: typeof a) => [...g.nodes.map((n) => n.id), ...g.edges.map((e) => e.id)];
    const setA = new Set(ids(a));
    expect(setA.size).toBe(ids(a).length); // unique within an instance
    expect(ids(b).filter((x) => setA.has(x))).toEqual([]); // unique across instances
    // Master template IDs are never used as instance IDs
    const master = t.generate({});
    const masterIds = new Set(master.nodes.map((n) => n.id));
    expect(a.nodes.filter((n) => masterIds.has(n.id))).toEqual([]);
  });

  test.each(architectureTemplates.map((t) => [t.id, t]))('%s: structure and references are preserved', (_id, t) => {
    const master = t.generate({});
    const inst = instantiateTemplate(t, {});
    expect(inst.nodes).toHaveLength(master.nodes.length);
    expect(inst.edges).toHaveLength(master.edges.length);
    const ids = new Set(inst.nodes.map((n) => n.id));
    for (const e of inst.edges) { expect(ids.has(e.source)).toBe(true); expect(ids.has(e.target)).toBe(true); }
    for (const n of inst.nodes) {
      if (n.parentId) expect(ids.has(n.parentId)).toBe(true);
      if (n.groupId) expect(ids.has(n.groupId)).toBe(true);
      // stable template identity kept for traceability
      expect(master.nodes.some((m) => m.id === n.config.templateNodeId)).toBe(true);
      // resource type, label and config otherwise unchanged
      const m = master.nodes.find((x) => x.id === n.config.templateNodeId)!;
      expect(n.resourceType).toBe(m.resourceType);
      expect(n.label).toBe(m.label);
    }
  });

  test('config values that reference another node are remapped', () => {
    const g = rekeyGraph(
      [
        { id: 'a', type: 'cloudNode', resourceType: 'aws_ec2', provider: 'aws', label: 'a', position: { x: 0, y: 0 }, config: { targetId: 'b', ids: ['b', 'x'] } },
        { id: 'b', type: 'cloudNode', resourceType: 'aws_rds', provider: 'aws', label: 'b', position: { x: 0, y: 0 }, config: {} },
      ] as never,
      [{ id: 'e1', source: 'a', target: 'b' }],
    );
    const [a, b] = g.nodes;
    expect(a.config.targetId).toBe(b.id);
    expect(a.config.ids).toEqual([b.id, 'x']);
    expect(g.edges[0]).toMatchObject({ source: a.id, target: b.id });
  });

  test('AI generator and wizard produce unique IDs on every call', () => {
    const p1 = generateFromPrompt('three tier web app on AWS');
    const p2 = generateFromPrompt('three tier web app on AWS');
    expect(p1.nodes.some((n) => p2.nodes.some((m) => m.id === n.id))).toBe(false);
    const w1 = generateFromWizard({ templateId: '3tier-web' } as never);
    const w2 = generateFromWizard({ templateId: '3tier-web' } as never);
    expect(w1.nodes.some((n) => w2.nodes.some((m) => m.id === n.id))).toBe(false);
  });
});

describe('No product code persists master template IDs', () => {
  // Every call site that turns a template into a canvas must go through instantiateTemplate.
  test('template.generate() is only called by lib/templates and instantiateTemplate', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) { if (!['node_modules', '.next'].includes(f.name)) walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(f.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        src.split('\n').forEach((l, i) => {
          if (/\b(template|t|tpl)\.generate\(/.test(l) && !/estimateTemplateCostUsd|=> t\.generate\(\{\}\)\)/.test(l)) offenders.push(`${p}:${i + 1}: ${l.trim()}`);
        });
      }
    };
    for (const d of ['components', 'context', 'app', 'lib']) walk(d);
    expect(offenders.filter((o) => !o.startsWith('lib/templates') && !o.startsWith('lib/domain/instantiateTemplate.ts'))).toEqual([]);
  });
});
