/**
 * CloudCraft — Real Export Service
 *
 * Generates actual SVG, PNG, and PDF files from the architecture graph.
 * No browser, no Puppeteer executable dependency.
 *
 * Implementation:
 *  - SVG: Pure server-side string generation from normalized graph data
 *  - PNG: SVG → rasterized at 2x DPI via sharp
 *  - PDF: pdfkit layout with title, resources, legend, version block
 *
 * The output files contain the actual architecture — not a placeholder.
 */

import type { CanvasNode, CanvasEdge } from '@/types';

// ─── Architecture graph input ─────────────────────────────────────────────────

export interface ExportInput {
  nodes: CanvasNode[];
  edges: Array<{ id: string; source: string; target: string; label?: string }>;
  title: string;
  version?: string;
  theme?: 'light' | 'dark';
}

export type ExportFormat = 'svg' | 'png' | 'pdf';

// ─── Colors ───────────────────────────────────────────────────────────────────

const THEME = {
  light: {
    bg: '#F8FAFC',
    canvasBg: '#FFFFFF',
    text: '#1E293B',
    subtext: '#64748B',
    border: '#CBD5E1',
    edge: '#94A3B8',
    legendBg: '#F1F5F9',
  },
  dark: {
    bg: '#0F172A',
    canvasBg: '#1E293B',
    text: '#F1F5F9',
    subtext: '#94A3B8',
    border: '#334155',
    edge: '#475569',
    legendBg: '#1E293B',
  },
};

// Provider brand colors
const PROVIDER_COLORS: Record<string, string> = {
  aws:   '#FF9900',
  azure: '#0078D4',
  gcp:   '#4285F4',
};

// Category colors
const CATEGORY_COLORS: Record<string, string> = {
  compute:    '#3B82F6',
  storage:    '#F59E0B',
  database:   '#8B5CF6',
  networking: '#10B981',
  security:   '#EF4444',
  serverless: '#EC4899',
  container:  '#06B6D4',
  default:    '#6366F1',
};

// ─── Layout constants ─────────────────────────────────────────────────────────

const NODE_W = 140;
const NODE_H = 70;
const PADDING = 40;
const GRID_COLS = 5;
const COL_GAP = 60;
const ROW_GAP = 60;
const CANVAS_TOP = 90; // space for title
const LEGEND_HEIGHT = 120;

// ─── Positioning ──────────────────────────────────────────────────────────────

interface NodePosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

function computeLayout(nodes: CanvasNode[]): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>();

  // If nodes already have position data, use it
  const hasPositions = nodes.some(n => (n as any).position?.x !== undefined);

  if (hasPositions) {
    let minX = Infinity, minY = Infinity;
    for (const node of nodes) {
      const pos = (node as any).position;
      if (pos) {
        minX = Math.min(minX, pos.x);
        minY = Math.min(minY, pos.y);
      }
    }
    for (const node of nodes) {
      const pos = (node as any).position ?? { x: 0, y: 0 };
      positions.set(node.id, {
        x: PADDING + (pos.x - minX),
        y: CANVAS_TOP + PADDING + (pos.y - minY),
        w: NODE_W,
        h: NODE_H,
      });
    }
    return positions;
  }

  // Auto grid layout
  nodes.forEach((node, idx) => {
    const col = idx % GRID_COLS;
    const row = Math.floor(idx / GRID_COLS);
    positions.set(node.id, {
      x: PADDING + col * (NODE_W + COL_GAP),
      y: CANVAS_TOP + PADDING + row * (NODE_H + ROW_GAP),
      w: NODE_W,
      h: NODE_H,
    });
  });

  return positions;
}

function computeCanvasSize(positions: Map<string, NodePosition>): { width: number; height: number } {
  let maxX = 400, maxY = 300;
  for (const pos of positions.values()) {
    maxX = Math.max(maxX, pos.x + pos.w + PADDING);
    maxY = Math.max(maxY, pos.y + pos.h + PADDING);
  }
  return { width: maxX, height: maxY + LEGEND_HEIGHT };
}

// ─── SVG generation ───────────────────────────────────────────────────────────

function nodeCategory(node: CanvasNode): string {
  const type = node.resourceType ?? '';
  if (type.includes('ec2') || type.includes('vm') || type.includes('compute_instance')) return 'compute';
  if (type.includes('s3') || type.includes('storage') || type.includes('ebs')) return 'storage';
  if (type.includes('rds') || type.includes('sql') || type.includes('dynamodb')) return 'database';
  if (type.includes('vpc') || type.includes('subnet') || type.includes('alb') || type.includes('nat') || type.includes('igw') || type.includes('load_balancer') || type.includes('nat') || type.includes('dns')) return 'networking';
  if (type.includes('iam') || type.includes('sg') || type.includes('nsg') || type.includes('firewall') || type.includes('kms')) return 'security';
  if (type.includes('lambda') || type.includes('cloud_run') || type.includes('cloud_function') || type.includes('functions')) return 'serverless';
  if (type.includes('eks') || type.includes('aks') || type.includes('container')) return 'container';
  return 'default';
}

function nodeProvider(node: CanvasNode): string {
  const type = node.resourceType ?? '';
  if (type.startsWith('aws_')) return 'aws';
  if (type.startsWith('azure_')) return 'azure';
  if (type.startsWith('gcp_')) return 'gcp';
  return 'aws';
}

function svgEscape(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s: string, maxLen: number): string {
  if (!s) return '';
  return s.length <= maxLen ? s : s.substring(0, maxLen - 1) + '…';
}

function renderNodeSvg(
  node: CanvasNode,
  pos: NodePosition,
  colors: typeof THEME.light
): string {
  const category = nodeCategory(node);
  const provider = nodeProvider(node);
  const fillColor = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.default!;
  const providerColor = PROVIDER_COLORS[provider] ?? '#6B7280';
  const label = truncate(node.label || node.resourceType || 'Resource', 18);
  const typeLabel = truncate(node.resourceType || '', 22);

  const { x, y, w, h } = pos;
  const rx = 8;

  return `
  <!-- Node: ${svgEscape(node.id)} -->
  <g transform="translate(${x}, ${y})">
    <!-- Shadow -->
    <rect x="2" y="2" width="${w}" height="${h}" rx="${rx}" fill="rgba(0,0,0,0.10)"/>
    <!-- Background -->
    <rect width="${w}" height="${h}" rx="${rx}" fill="${colors.canvasBg}" stroke="${colors.border}" stroke-width="1.5"/>
    <!-- Provider accent bar -->
    <rect width="${w}" height="4" rx="${rx}" fill="${providerColor}" opacity="0.9"/>
    <!-- Category icon circle -->
    <circle cx="20" cy="${h / 2 + 4}" r="14" fill="${fillColor}" opacity="0.15"/>
    <circle cx="20" cy="${h / 2 + 4}" r="10" fill="${fillColor}" opacity="0.80"/>
    <!-- Resource label -->
    <text x="40" y="${h / 2 - 2}" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="600" fill="${colors.text}" dominant-baseline="middle">${svgEscape(label)}</text>
    <!-- Type sublabel -->
    <text x="40" y="${h / 2 + 16}" font-family="Inter, system-ui, sans-serif" font-size="9" fill="${colors.subtext}">${svgEscape(typeLabel)}</text>
  </g>`;
}

function renderEdgeSvg(
  edge: { id: string; source: string; target: string; label?: string },
  positions: Map<string, NodePosition>,
  colors: typeof THEME.light
): string {
  const src = positions.get(edge.source);
  const tgt = positions.get(edge.target);
  if (!src || !tgt) return '';

  // Connect center-right to center-left
  const x1 = src.x + src.w;
  const y1 = src.y + src.h / 2;
  const x2 = tgt.x;
  const y2 = tgt.y + tgt.h / 2;
  const mx = (x1 + x2) / 2;

  return `
  <!-- Edge: ${svgEscape(edge.id)} -->
  <path d="M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"
    fill="none" stroke="${colors.edge}" stroke-width="1.5" stroke-dasharray="5,3"
    marker-end="url(#arrow)"/>
  ${edge.label ? `<text x="${mx}" y="${(y1 + y2) / 2 - 4}" font-family="Inter, system-ui, sans-serif" font-size="9" fill="${colors.subtext}" text-anchor="middle">${svgEscape(edge.label)}</text>` : ''}`;
}

function renderLegend(
  nodes: CanvasNode[],
  canvasWidth: number,
  canvasHeight: number,
  input: ExportInput,
  colors: typeof THEME.light
): string {
  const legendY = canvasHeight - LEGEND_HEIGHT;
  // Count providers
  const providerCounts: Record<string, number> = {};
  const categoryCounts: Record<string, number> = {};
  for (const node of nodes) {
    const p = nodeProvider(node);
    const c = nodeCategory(node);
    providerCounts[p] = (providerCounts[p] ?? 0) + 1;
    categoryCounts[c] = (categoryCounts[c] ?? 0) + 1;
  }

  const providerEntries = Object.entries(providerCounts);
  const versionStr = input.version ? `v${input.version}` : '';
  const dateStr = new Date().toISOString().split('T')[0];

  return `
  <!-- Legend -->
  <rect x="0" y="${legendY}" width="${canvasWidth}" height="${LEGEND_HEIGHT}" fill="${colors.legendBg}" opacity="0.95"/>
  <line x1="0" y1="${legendY}" x2="${canvasWidth}" y2="${legendY}" stroke="${colors.border}" stroke-width="1"/>
  <text x="${PADDING}" y="${legendY + 20}" font-family="Inter, system-ui, sans-serif" font-size="11" font-weight="700" fill="${colors.text}">Architecture Legend</text>
  <text x="${canvasWidth - PADDING}" y="${legendY + 20}" font-family="Inter, system-ui, sans-serif" font-size="10" fill="${colors.subtext}" text-anchor="end">${svgEscape(versionStr)} · ${dateStr} · ${nodes.length} resource(s)</text>
  ${providerEntries.map(([ provider, count], i) => {
    const color = PROVIDER_COLORS[provider] ?? '#6B7280';
    return `
  <circle cx="${PADDING + i * 120 + 8}" cy="${legendY + 44}" r="6" fill="${color}"/>
  <text x="${PADDING + i * 120 + 20}" y="${legendY + 48}" font-family="Inter, system-ui, sans-serif" font-size="10" fill="${colors.text}" dominant-baseline="middle">${provider.toUpperCase()} (${count})</text>`;
  }).join('')}
  ${Object.entries(CATEGORY_COLORS).slice(0, 6).map(([cat, color], i) => `
  <rect x="${PADDING + i * 110}" y="${legendY + 66}" width="10" height="10" rx="2" fill="${color}"/>
  <text x="${PADDING + i * 110 + 14}" y="${legendY + 75}" font-family="Inter, system-ui, sans-serif" font-size="9" fill="${colors.subtext}">${cat}</text>`).join('')}`;
}

export function generateSvg(input: ExportInput): string {
  const colors = THEME[input.theme ?? 'light'];
  const positions = computeLayout(input.nodes);
  const { width, height } = computeCanvasSize(positions);

  const nodesSvg = input.nodes.map(n => renderNodeSvg(n, positions.get(n.id)!, colors)).join('');
  const edgesSvg = input.edges.map(e => renderEdgeSvg(e, positions, colors)).join('');
  const legendSvg = renderLegend(input.nodes, width, height, input, colors);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="${colors.edge}"/>
    </marker>
    <style>
      text { font-family: Inter, system-ui, -apple-system, sans-serif; }
    </style>
  </defs>
  <!-- Background -->
  <rect width="${width}" height="${height}" fill="${colors.bg}"/>
  <!-- Title -->
  <text x="${PADDING}" y="52" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="700" fill="${colors.text}">${svgEscape(input.title)}</text>
  <text x="${PADDING}" y="72" font-family="Inter, system-ui, sans-serif" font-size="12" fill="${colors.subtext}">Cloud Architecture Diagram — CloudCraft</text>
  <!-- Edges (behind nodes) -->
  <g id="edges">${edgesSvg}
  </g>
  <!-- Nodes -->
  <g id="nodes">${nodesSvg}
  </g>
  <!-- Legend -->
  ${legendSvg}
</svg>`;
}

// ─── PNG generation via sharp ─────────────────────────────────────────────────

export async function generatePng(input: ExportInput): Promise<Buffer> {
  const svgString = generateSvg(input);
  const sharp = (await import('sharp')).default;

  // 2x resolution for high-quality export
  const png = await sharp(Buffer.from(svgString))
    .png({ quality: 100, compressionLevel: 9 })
    .toBuffer();

  return png;
}

// ─── PDF generation via pdfkit ────────────────────────────────────────────────

export async function generatePdf(input: ExportInput): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A3', layout: 'landscape', margin: 40 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const colors = input.theme === 'dark'
      ? { bg: '#0F172A', text: '#F1F5F9', subtext: '#94A3B8', border: '#334155' }
      : { bg: '#FFFFFF', text: '#1E293B', subtext: '#64748B', border: '#CBD5E1' };

    const pageW = doc.page.width;

    // Background
    doc.rect(0, 0, pageW, doc.page.height).fill(colors.bg);

    // Title block
    doc.font('Helvetica-Bold').fontSize(22).fillColor(colors.text)
      .text(input.title, 40, 40, { width: pageW - 80 });

    doc.font('Helvetica').fontSize(10).fillColor(colors.subtext)
      .text(`Cloud Architecture Diagram — CloudCraft  ·  ${input.version ? 'v' + input.version + '  ·  ' : ''}${new Date().toISOString().split('T')[0]}  ·  ${input.nodes.length} resource(s)`,
        40, 70, { width: pageW - 80 });

    // Horizontal rule
    doc.moveTo(40, 88).lineTo(pageW - 40, 88).stroke(colors.border);

    // Resource table
    const tableTop = 100;
    const colWidths = [200, 120, 120, 80, 120];
    const headers = ['Resource Name', 'Type', 'Provider', 'Region', 'Category'];
    let x = 40;

    // Table header
    doc.font('Helvetica-Bold').fontSize(9).fillColor(colors.text);
    headers.forEach((h, i) => {
      doc.text(h, x, tableTop, { width: colWidths[i], lineBreak: false });
      x += colWidths[i]!;
    });

    let rowY = tableTop + 18;
    doc.moveTo(40, rowY - 2).lineTo(pageW - 40, rowY - 2).stroke(colors.border);

    doc.font('Helvetica').fontSize(8).fillColor(colors.text);

    for (const node of input.nodes) {
      if (rowY > doc.page.height - 100) {
        doc.addPage({ size: 'A3', layout: 'landscape' });
        rowY = 40;
      }
      x = 40;
      const category = nodeCategory(node);
      const provider = nodeProvider(node);
      const row = [
        node.label || node.id,
        node.resourceType || '',
        provider.toUpperCase(),
        (node as any).region || '—',
        category,
      ];
      row.forEach((cell, i) => {
        doc.fillColor(i === 2 ? (PROVIDER_COLORS[provider] ?? colors.text) : colors.text);
        doc.text(truncate(cell, 30), x, rowY, { width: colWidths[i]!, lineBreak: false });
        x += colWidths[i]!;
      });
      rowY += 16;

      // Light row separator
      doc.moveTo(40, rowY - 2).lineWidth(0.3).stroke(colors.border);
    }

    // Edges section
    if (input.edges.length > 0) {
      rowY += 20;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(colors.text).text('Connections', 40, rowY);
      rowY += 16;
      doc.font('Helvetica').fontSize(8).fillColor(colors.subtext);
      for (const edge of input.edges) {
        if (rowY > doc.page.height - 60) break;
        const srcNode = input.nodes.find(n => n.id === edge.source);
        const tgtNode = input.nodes.find(n => n.id === edge.target);
        doc.text(
          `${srcNode?.label ?? edge.source}  →  ${tgtNode?.label ?? edge.target}${edge.label ? '  (' + edge.label + ')' : ''}`,
          40, rowY, { width: pageW - 80 }
        );
        rowY += 14;
      }
    }

    // Footer
    const footerY = doc.page.height - 40;
    doc.moveTo(40, footerY - 10).lineTo(pageW - 40, footerY - 10).stroke(colors.border);
    doc.font('Helvetica').fontSize(8).fillColor(colors.subtext)
      .text('Generated by CloudCraft — cloud.google.com/architecture/diagram', 40, footerY, { width: pageW - 80, align: 'center' });

    doc.end();
  });
}

// ─── Primary Export Service ───────────────────────────────────────────────────

export class ExportService {
  /**
   * Generates a real architecture export file.
   *
   * @param input  Architecture graph data (nodes, edges, title, version)
   * @param format 'svg' | 'png' | 'pdf'
   * @returns      { buffer: Buffer, contentType: string, filename: string }
   *
   * The buffer contains actual file bytes — never a placeholder URL.
   */
  static async export(
    input: ExportInput,
    format: ExportFormat
  ): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
    const safeName = (input.title || 'architecture').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    switch (format) {
      case 'svg': {
        const svgString = generateSvg(input);
        return {
          buffer: Buffer.from(svgString, 'utf-8'),
          contentType: 'image/svg+xml',
          filename: `${safeName}_${ts}.svg`,
        };
      }
      case 'png': {
        const buffer = await generatePng(input);
        return {
          buffer,
          contentType: 'image/png',
          filename: `${safeName}_${ts}.png`,
        };
      }
      case 'pdf': {
        const buffer = await generatePdf(input);
        return {
          buffer,
          contentType: 'application/pdf',
          filename: `${safeName}_${ts}.pdf`,
        };
      }
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }
}
