/**
 * The architecture as a draw.io (diagrams.net) diagram.
 *
 * Two outputs from one model:
 *  - drawioModelXml: the <mxGraphModel> text that draw.io's "Extras > Edit Diagram" accepts when pasted;
 *  - drawioFileXml: the same model wrapped as a .drawio file, which draw.io opens with "File > Open from > Device" or by dropping it in.
 *
 * Only draw.io's built-in shapes are used (rounded boxes, cylinders, hexagons), so every box renders in every draw.io, with no icon library to
 * enable. Groups (VPC, subnet, resource group, virtual network) become real draw.io containers, so moving one moves what is inside it.
 * Everything that comes from the architecture (names, types, edge labels) is escaped, so a name such as `<script>` stays plain text.
 */
import type { CanvasEdge, CanvasNode } from '@/types';
import { getResourceDefinition } from '@/lib/resources';

export interface DrawioInput {
  title: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const NODE_W = 150;
const NODE_H = 64;
const PAD = 40;
const HEADER = 34;

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
/** Text that is shown as HTML in a label. It is put in an XML attribute, so it is escaped twice: for HTML here, then for XML (escapeXml) around it. */
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PROVIDER = { aws: { stroke: '#D86613', fill: '#FFF3E6' }, azure: { stroke: '#0078D4', fill: '#E8F3FC' } } as const;
const CATEGORY_FILL: Record<string, string> = {
  compute: '#FFE9D0', database: '#DDEBFA', storage: '#E4F5E1', networking: '#EEE4F7', security: '#FBE0E0',
  messaging: '#FFF4CC', monitoring: '#E6F0F2', analytics: '#E0F0F5',
};

const isContainer = (n: CanvasNode) => /vpc|vnet|subnet|boundary|resource_group/.test(n.resourceType) || n.type === 'containerNode';
const providerOf = (n: CanvasNode): 'aws' | 'azure' => (n.provider === 'azure' || n.resourceType.startsWith('azure_') ? 'azure' : 'aws');
const pretty = (type: string) => type.replace(/^(aws|azure)_/, '').replace(/_/g, ' ');

interface Box { id: string; x: number; y: number; w: number; h: number; parent: string | null }

/** How many groups a box is inside. (The loop is capped: layout() already removed any cycle, this only guards against a mistake there.) */
const depthOf = (boxes: Map<string, Box>, id: string): number => { let d = 0; let p = boxes.get(id)?.parent; while (p && d < 50) { d++; p = boxes.get(p)?.parent; } return d; };

/** Positions and sizes: absolute on the canvas; a container with no size of its own wraps what is inside it. */
function layout(nodes: CanvasNode[]): Map<string, Box> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const boxes = new Map<string, Box>();
  const parentOf = (n: CanvasNode): string | null => (n.groupId && n.groupId !== n.id && byId.has(n.groupId) ? n.groupId : null);

  // Parents that point at each other (A inside B inside A) would never finish: every box in such a loop is put at the top level instead.
  const safeParent = new Map<string, string | null>();
  for (const n of nodes) {
    const first = parentOf(n);
    const seen = new Set([n.id]);
    let cur = first;
    let loop = false;
    while (cur) {
      if (seen.has(cur)) { loop = true; break; }
      seen.add(cur);
      cur = parentOf(byId.get(cur)!);
    }
    safeParent.set(n.id, loop ? null : first);
  }

  for (const n of nodes) boxes.set(n.id, { id: n.id, x: n.position.x, y: n.position.y, w: n.width ?? (isContainer(n) ? 0 : NODE_W), h: n.height ?? (isContainer(n) ? 0 : NODE_H), parent: safeParent.get(n.id) ?? null });

  // A container with no size wraps its members, deepest first.
  for (const n of [...nodes].filter((x) => isContainer(x)).sort((a, b) => depthOf(boxes, b.id) - depthOf(boxes, a.id))) {
    const b = boxes.get(n.id)!;
    if (b.w > 0 && b.h > 0) continue;
    const members = [...boxes.values()].filter((m) => m.parent === n.id);
    if (members.length === 0) { b.w = 320; b.h = 200; continue; }
    const minX = Math.min(...members.map((m) => m.x)), minY = Math.min(...members.map((m) => m.y));
    const maxX = Math.max(...members.map((m) => m.x + m.w)), maxY = Math.max(...members.map((m) => m.y + m.h));
    b.x = Math.min(b.x, minX - PAD); b.y = Math.min(b.y, minY - PAD - HEADER);
    b.w = maxX - b.x + PAD; b.h = maxY - b.y + PAD;
  }
  return boxes;
}

function nodeStyle(n: CanvasNode): string {
  const prov = PROVIDER[providerOf(n)];
  if (isContainer(n)) {
    const subnet = n.resourceType.includes('subnet');
    return `rounded=1;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=4;fontStyle=1;fontSize=12;dashed=1;dashPattern=${subnet ? '4 4' : '8 4'};strokeColor=${prov.stroke};fillColor=${subnet ? '#FFFFFF' : prov.fill};opacity=${subnet ? 100 : 70};arcSize=3;`;
  }
  const category = getResourceDefinition(n.resourceType)?.category ?? 'compute';
  const fill = CATEGORY_FILL[category] ?? '#F1F5F9';
  const shape = category === 'database' ? 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=10;' : category === 'networking' ? 'shape=hexagon;perimeter=hexagonPerimeter2;size=0.18;' : 'rounded=1;arcSize=12;';
  return `${shape}whiteSpace=wrap;html=1;fontSize=12;strokeWidth=2;strokeColor=${prov.stroke};fillColor=${fill};fontColor=#1E293B;`;
}

function edgeStyle(e: CanvasEdge): string {
  const color = e.edgeType === 'security' ? '#C0392B' : e.edgeType === 'management' ? '#7F8C8D' : e.edgeType === 'cross-cloud' ? '#8E44AD' : '#475569';
  const dashed = e.edgeType === 'security' || e.edgeType === 'management' || e.networkScope === 'public' ? 'dashed=1;' : '';
  const start = e.direction === 'bidirectional' ? 'startArrow=block;startFill=1;' : 'startArrow=none;';
  return `edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;${start}${dashed}strokeColor=${color};fontColor=${color};fontSize=11;`;
}

const edgeLabel = (e: CanvasEdge): string => [e.label, e.protocol && e.port ? `${e.protocol}/${e.port}` : e.port ? String(e.port) : e.protocol].filter(Boolean).join(' · ');

/** The <mxGraphModel> for draw.io's "Edit Diagram". */
export function drawioModelXml(input: DrawioInput): string {
  const nodes = input.nodes.filter((n) => n && typeof n.id === 'string' && n.position);
  const ids = new Set(nodes.map((n) => n.id));
  const boxes = layout(nodes);
  // Containers first (outer before inner), so what is inside is drawn on top.
  const ordered = [...nodes].sort((a, b) => (Number(isContainer(b)) - Number(isContainer(a))) || (depthOf(boxes, a.id) - depthOf(boxes, b.id)));

  const cell = (n: CanvasNode): string => {
    const b = boxes.get(n.id)!;
    const parent = b.parent ? boxes.get(b.parent)! : null;
    const x = Math.round(b.x - (parent?.x ?? 0)), y = Math.round(b.y - (parent?.y ?? 0));
    const label = isContainer(n)
      ? `<b>${escapeHtml(n.label)}</b>`
      : `<b>${escapeHtml(n.label)}</b><br><font style="font-size:10px" color="#64748B">${escapeHtml(pretty(n.resourceType))}</font>`;
    return `<mxCell id="n-${escapeXml(n.id)}" value="${escapeXml(label)}" style="${nodeStyle(n)}" vertex="1" parent="${parent ? `n-${escapeXml(parent.id)}` : '1'}"><mxGeometry x="${x}" y="${y}" width="${Math.round(b.w)}" height="${Math.round(b.h)}" as="geometry"/></mxCell>`;
  };

  const edges = input.edges.filter((e) => e && ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const edgeCells = edges.map((e, i) => {
    const label = edgeLabel(e);
    return `<mxCell id="e-${i}-${escapeXml(e.id ?? String(i))}" value="${escapeXml(escapeHtml(label))}" style="${edgeStyle(e)}" edge="1" parent="1" source="n-${escapeXml(e.source)}" target="n-${escapeXml(e.target)}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
  });

  return [
    '<mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0">',
    '  <root>',
    '    <mxCell id="0"/>',
    '    <mxCell id="1" parent="0"/>',
    ...ordered.map((n) => `    ${cell(n)}`),
    ...edgeCells.map((c) => `    ${c}`),
    '  </root>',
    '</mxGraphModel>',
  ].join('\n');
}

/** A .drawio file: the same diagram, wrapped the way draw.io saves it (not compressed, so it can be read and diffed). */
export function drawioFileXml(input: DrawioInput): string {
  const name = escapeXml((input.title || 'CloudCraft architecture').slice(0, 120));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="CloudCraft" version="24.0.0" type="device">\n  <diagram id="cloudcraft-1" name="${name}">\n${drawioModelXml(input)}\n  </diagram>\n</mxfile>\n`;
}

/** A safe file name for the download. */
export const drawioFileName = (title: string): string => `${(title || 'architecture').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'architecture'}.drawio`;
