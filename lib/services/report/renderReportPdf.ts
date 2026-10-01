/**
 * Professional PDF rendering of the structured AssessmentReport (server only).
 *
 * Generated directly from report data with pdfkit — vector text, tables and a
 * vector architecture diagram — never a screenshot of the UI.
 */
import { COMMENTARY_DISCLAIMER } from '@/lib/ai/reportCommentary';
import type { AssessmentReport, RecommendationGroup } from '@/lib/engines/assessment/report/buildReport';
import type { Finding, Severity } from '@/lib/engines/assessment/types';
import type { CanvasNode } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { VERIFICATION_LABEL } from '@/lib/engines/assessment/references';

type Doc = PDFKit.PDFDocument;

export const C = {
  navy: '#0B2545', accent: '#1F5FAD', text: '#1F2937', muted: '#64748B', rule: '#D6DEE8', zebra: '#F4F7FA', box: '#EEF3F9',
  sev: { CRITICAL: '#9F1239', HIGH: '#C2410C', MEDIUM: '#A16207', LOW: '#1D4ED8', INFORMATIONAL: '#475569' } as Record<Severity, string>,
  pass: '#15803D', fail: '#B91C1C', warn: '#A16207', na: '#64748B',
};
export const PAGE = { w: 595.28, h: 841.89, m: 54, top: 72, bottom: 64 };
export const CONTENT_W = PAGE.w - PAGE.m * 2;

/** Standard PDF fonts are WinAnsi-encoded; map characters they cannot render. */
export function pdfSafe(s: unknown): string {
  return String(s ?? '')
    .replace(/→/g, '->').replace(/←/g, '<-').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/≠/g, '!=')
    .replace(/[✓✔]/g, 'Yes').replace(/[✗✘]/g, 'No').replace(/Σ/g, 'Sum').replace(/÷/g, '/').replace(/[−‐‑]/g, '-')
    .replace(/[→⇒]/g, '->').replace(/ /g, ' ')
    .replace(/[^\x00-\xFF–—‘’“”•…€™]/g, '?');
}

export interface Col { header: string; width: number; align?: 'left' | 'center' | 'right'; render?: (row: string[], i: number) => { color?: string; bold?: boolean } }

export class Writer {
  sections: { title: string; page: number; level: number }[] = [];
  constructor(public doc: Doc, public report: AssessmentReport) {}

  get y() { return this.doc.y; }
  ensure(h: number) { if (this.doc.y + h > PAGE.h - PAGE.bottom) this.newPage(); }
  newPage() { this.doc.addPage(); this.doc.y = PAGE.top; this.doc.x = PAGE.m; }
  pageIndex() { return this.doc.bufferedPageRange().start + this.doc.bufferedPageRange().count - 1; }

  h1(num: string, title: string) {
    this.newPage();
    this.sections.push({ title: `${num}  ${title}`, page: this.pageIndex(), level: 1 });
    const d = this.doc;
    d.font('Helvetica-Bold').fontSize(18).fillColor(C.navy).text(pdfSafe(`${num}  ${title}`), PAGE.m, PAGE.top, { width: CONTENT_W });
    d.moveTo(PAGE.m, d.y + 4).lineTo(PAGE.m + CONTENT_W, d.y + 4).lineWidth(1.2).strokeColor(C.accent).stroke();
    d.y += 14;
  }
  h2(title: string, record = false) {
    // Keep a heading with at least the start of what follows (avoids orphaned headings).
    this.ensure(90);
    if (record) this.sections.push({ title, page: this.pageIndex(), level: 2 });
    this.doc.moveDown(0.4).font('Helvetica-Bold').fontSize(12.5).fillColor(C.navy).text(pdfSafe(title), PAGE.m, this.doc.y, { width: CONTENT_W });
    this.doc.moveDown(0.3);
  }
  h3(title: string, color = C.text) {
    this.ensure(28);
    this.doc.moveDown(0.3).font('Helvetica-Bold').fontSize(10.5).fillColor(color).text(pdfSafe(title), PAGE.m, this.doc.y, { width: CONTENT_W });
    this.doc.moveDown(0.15);
  }
  p(text: string, opts: { size?: number; color?: string; bold?: boolean; indent?: number } = {}) {
    const size = opts.size ?? 9.5;
    const w = CONTENT_W - (opts.indent ?? 0);
    this.doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    this.ensure(this.doc.heightOfString(pdfSafe(text), { width: w }) + 4);
    this.doc.fillColor(opts.color ?? C.text).text(pdfSafe(text), PAGE.m + (opts.indent ?? 0), this.doc.y, { width: w, lineGap: 1.5 });
    this.doc.moveDown(0.35);
  }
  bullets(items: string[], opts: { size?: number; empty?: string } = {}) {
    if (items.length === 0) { this.p(opts.empty ?? 'None.', { color: C.muted, size: opts.size }); return; }
    const size = opts.size ?? 9.5;
    for (const it of items) {
      this.doc.font('Helvetica').fontSize(size);
      const h = this.doc.heightOfString(pdfSafe(it), { width: CONTENT_W - 14 });
      this.ensure(h + 3);
      const y = this.doc.y;
      this.doc.fillColor(C.accent).text('•', PAGE.m + 2, y);
      this.doc.fillColor(C.text).text(pdfSafe(it), PAGE.m + 14, y, { width: CONTENT_W - 14, lineGap: 1.5 });
      this.doc.moveDown(0.2);
    }
    this.doc.moveDown(0.2);
  }
  box(title: string, body: string, color = C.accent) {
    const d = this.doc;
    d.font('Helvetica').fontSize(9);
    const h = d.heightOfString(pdfSafe(body), { width: CONTENT_W - 24 }) + 30;
    this.ensure(h + 6);
    const y = d.y;
    d.rect(PAGE.m, y, CONTENT_W, h).fillColor(C.box).fill();
    d.rect(PAGE.m, y, 3, h).fillColor(color).fill();
    d.font('Helvetica-Bold').fontSize(9.5).fillColor(color).text(pdfSafe(title), PAGE.m + 12, y + 8, { width: CONTENT_W - 24 });
    d.font('Helvetica').fontSize(9).fillColor(C.text).text(pdfSafe(body), PAGE.m + 12, d.y + 2, { width: CONTENT_W - 24, lineGap: 1.5 });
    d.y = y + h + 8;
  }
  pill(text: string, color: string, x: number, y: number) {
    const d = this.doc;
    d.font('Helvetica-Bold').fontSize(7.5);
    const w = d.widthOfString(text) + 10;
    d.roundedRect(x, y, w, 12, 3).fillColor(color).fill();
    d.fillColor('#FFFFFF').text(text, x + 5, y + 2.6, { lineBreak: false });
    return w;
  }
  kv(rows: [string, string][], labelW = 150) {
    for (const [k, v] of rows) {
      this.doc.font('Helvetica').fontSize(9.5);
      const h = Math.max(this.doc.heightOfString(pdfSafe(v), { width: CONTENT_W - labelW }), 12) + 5;
      this.ensure(h);
      const y = this.doc.y;
      this.doc.font('Helvetica-Bold').fillColor(C.muted).text(pdfSafe(k), PAGE.m, y, { width: labelW - 8 });
      this.doc.font('Helvetica').fillColor(C.text).text(pdfSafe(v), PAGE.m + labelW, y, { width: CONTENT_W - labelW, lineGap: 1 });
      this.doc.y = y + h;
      this.doc.moveTo(PAGE.m, this.doc.y - 2).lineTo(PAGE.m + CONTENT_W, this.doc.y - 2).lineWidth(0.4).strokeColor(C.rule).stroke();
    }
    this.doc.moveDown(0.5);
  }
  table(cols: Col[], rows: string[][], opts: { size?: number; empty?: string } = {}) {
    const d = this.doc; const size = opts.size ?? 8.5; const pad = 4;
    const total = cols.reduce((s, c) => s + c.width, 0);
    const scale = CONTENT_W / total;
    const widths = cols.map((c) => c.width * scale);
    const header = () => {
      d.font('Helvetica-Bold').fontSize(size);
      const hh = Math.max(...cols.map((c, i) => d.heightOfString(pdfSafe(c.header), { width: widths[i] - pad * 2 }))) + pad * 2;
      this.ensure(hh + 16);
      const y = d.y; let x = PAGE.m;
      d.rect(PAGE.m, y, CONTENT_W, hh).fillColor(C.navy).fill();
      cols.forEach((c, i) => { d.fillColor('#FFFFFF').text(pdfSafe(c.header), x + pad, y + pad, { width: widths[i] - pad * 2, align: c.align ?? 'left' }); x += widths[i]; });
      d.y = y + hh;
    };
    if (rows.length === 0) { header(); this.p(opts.empty ?? 'None.', { color: C.muted, size }); return; }
    header();
    rows.forEach((row, ri) => {
      d.font('Helvetica').fontSize(size);
      const rh = Math.max(...row.map((cell, i) => d.heightOfString(pdfSafe(cell), { width: widths[i] - pad * 2 }))) + pad * 2;
      if (d.y + rh > PAGE.h - PAGE.bottom) { this.newPage(); header(); }
      const y = d.y; let x = PAGE.m;
      if (ri % 2 === 1) d.rect(PAGE.m, y, CONTENT_W, rh).fillColor(C.zebra).fill();
      row.forEach((cell, i) => {
        const st = cols[i].render?.(row, i) ?? {};
        d.font(st.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(st.color ?? C.text)
          .text(pdfSafe(cell), x + pad, y + pad, { width: widths[i] - pad * 2, align: cols[i].align ?? 'left' });
        x += widths[i];
      });
      d.moveTo(PAGE.m, y + rh).lineTo(PAGE.m + CONTENT_W, y + rh).lineWidth(0.3).strokeColor(C.rule).stroke();
      d.y = y + rh;
    });
    d.x = PAGE.m;
    d.moveDown(0.6);
  }
}

export const sevColor = (row: string[], i: number) => ({ color: C.sev[row[i] as Severity] ?? C.text, bold: true });
export const statusColor = (v: string) => (/^(Pass|No issues|Technical evidence)/.test(v) ? C.pass : /^(Gap|Fail|Critical|Gaps)/.test(v) ? C.fail : /^(Warning|Issues|Partial)/.test(v) ? C.warn : C.na);
export const fmtDate = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
export const scoreText = (s: number | null) => (s === null ? 'Not scored' : `${s}/100`);
export const human = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

// ─── Architecture diagram ─────────────────────────────────────────────────────

function drawDiagram(w: Writer, nodes: CanvasNode[], edges: { source: string; target: string }[], x0: number, y0: number, W: number, maxH: number) {
  let H = maxH;
  const d = w.doc;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Mirrors InfraCanvas: positions are absolute canvas coordinates and sizes fall
  // back to the resource definition defaults.
  const size = (n: CanvasNode) => {
    const def = getResourceDefinition(n.resourceType);
    const isBoundary = n.resourceType.endsWith('_cloud_boundary');
    const isVpc = ['aws_vpc', 'azure_vnet', 'azure_resource_group'].includes(n.resourceType);
    const isSubnet = n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet';
    return {
      w: n.width || def?.defaultWidth || (isBoundary ? 980 : isVpc ? 840 : isSubnet ? 380 : 180),
      h: n.height || def?.defaultHeight || (isBoundary ? 620 : isVpc ? 520 : isSubnet ? 200 : 100),
    };
  };
  const abs = (n: CanvasNode) => ({ x: n.position?.x ?? 0, y: n.position?.y ?? 0 });
  if (nodes.length === 0) { w.p('No resources.'); return; }
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const n of nodes) { const p = abs(n); const s = size(n); minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h); }
  const scale = Math.min(W / Math.max(1, maxX - minX), H / Math.max(1, maxY - minY), 0.6);
  // Frame height follows the content (no large empty band under a wide, shallow diagram).
  H = Math.max(120, Math.min(H, (maxY - minY) * scale));
  const tx = (x: number) => x0 + (x - minX) * scale + (W - (maxX - minX) * scale) / 2;
  const ty = (y: number) => y0 + (y - minY) * scale;
  d.rect(x0 - 6, y0 - 6, W + 12, H + 12).lineWidth(0.5).strokeColor(C.rule).stroke();
  const isCont = (n: CanvasNode) => getResourceDefinition(n.resourceType)?.isContainer === true || n.resourceType.endsWith('_cloud_boundary');
  const containers = nodes.filter(isCont);
  const leaves = nodes.filter((n) => !isCont(n));
  for (const n of containers.sort((a, b) => size(b).w * size(b).h - size(a).w * size(a).h)) {
    const p = abs(n); const s = size(n);
    const color = n.provider === 'azure' ? '#0078D4' : '#E67E00';
    d.roundedRect(tx(p.x), ty(p.y), s.w * scale, s.h * scale, 4).lineWidth(0.8).dash(3, { space: 2 }).strokeColor(color).stroke().undash();
    d.font('Helvetica-Bold').fontSize(6.5).fillColor(color).text(pdfSafe(n.label), tx(p.x) + 3, ty(p.y) + 2, { width: Math.max(40, s.w * scale - 6), lineBreak: false, ellipsis: true });
  }
  const center = (n: CanvasNode) => { const p = abs(n); const s = size(n); return { x: tx(p.x + s.w / 2), y: ty(p.y + s.h / 2) }; };
  for (const e of edges) {
    const a = byId.get(e.source); const b = byId.get(e.target);
    if (!a || !b) continue;
    const pa = center(a); const pb = center(b);
    d.moveTo(pa.x, pa.y).lineTo(pb.x, pb.y).lineWidth(0.6).strokeColor('#94A3B8').stroke();
  }
  for (const n of leaves) {
    const p = abs(n); const s = size(n);
    const bw = Math.max(46, s.w * scale); const bh = Math.max(18, s.h * scale);
    const color = n.provider === 'azure' ? '#0078D4' : '#E67E00';
    d.roundedRect(tx(p.x), ty(p.y), bw, bh, 3).fillColor('#FFFFFF').fill();
    d.roundedRect(tx(p.x), ty(p.y), bw, bh, 3).lineWidth(0.9).strokeColor(color).stroke();
    d.rect(tx(p.x), ty(p.y), 2.5, bh).fillColor(color).fill();
    d.font('Helvetica-Bold').fontSize(6).fillColor(C.text).text(pdfSafe(n.label), tx(p.x) + 5, ty(p.y) + 3, { width: bw - 7, height: bh - 4, ellipsis: true });
    d.font('Helvetica').fontSize(5).fillColor(C.muted).text(pdfSafe(getResourceDefinition(n.resourceType)?.label ?? n.resourceType), tx(p.x) + 5, d.y, { width: bw - 7, lineBreak: false, ellipsis: true });
  }
  d.y = y0 + H + 14; d.x = PAGE.m;
  d.font('Helvetica').fontSize(7.5).fillColor(C.muted).text('Orange: AWS   Blue: Azure   Dashed boxes: network/containment boundaries   Lines: modelled connections', PAGE.m, d.y, { width: CONTENT_W });
  d.moveDown(0.6);
}

// ─── Finding detail block ─────────────────────────────────────────────────────

function findingBlock(w: Writer, f: Finding) {
  const d = w.doc;
  w.ensure(120);
  const y = d.y;
  d.rect(PAGE.m, y, CONTENT_W, 0.8).fillColor(C.sev[f.severity]).fill();
  d.y = y + 6;
  let x = PAGE.m;
  x += w.pill(f.severity, C.sev[f.severity], x, d.y) + 4;
  x += w.pill(f.status, f.status === 'FAIL' ? C.fail : C.warn, x, d.y) + 4;
  if (f.reviewStatus !== 'OPEN') x += w.pill(f.reviewStatus.replace('_', ' '), '#6D28D9', x, d.y) + 4;
  d.font('Helvetica-Bold').fontSize(8.5).fillColor(C.muted).text(f.findingId, x + 4, d.y + 2, { lineBreak: false });
  d.y += 17; d.x = PAGE.m;
  d.font('Helvetica-Bold').fontSize(11).fillColor(C.navy).text(pdfSafe(f.title), PAGE.m, d.y, { width: CONTENT_W });
  d.moveDown(0.3);
  w.kv([
    ['Affected resource(s)', f.resourceLabels.join(', ') || 'Architecture-wide'],
    ['Provider / service', `${f.provider === 'aws' ? 'AWS' : 'Azure'} — ${f.service}${f.region ? ` — ${f.region}` : ''}`],
    ['Category / pillar', `${f.category} — ${human(f.pillar)}${f.practice ? ` (${f.practice})` : ''}`],
    ['Evidence basis', f.provenance === 'DESIGN_TIME' ? 'Design-time configuration' : 'Discovered configuration (point-in-time)'],
  ], 118);
  w.p(`What CloudCraft observed: ${f.observation}`, { bold: false });
  if (f.evidence.length > 0) {
    w.table([
      { header: 'Evidence', width: 32 }, { header: 'Observed', width: 30 }, { header: 'Expected', width: 30 }, { header: 'Basis', width: 16 },
    ], f.evidence.map((e) => [e.label, e.observed, e.expected ?? '—', human(e.basis)]), { size: 8 });
  }
  w.p(`Why this matters: ${f.rationale}`, { size: 9 });
  w.p(`Risk: ${f.risk}  Potential impact: ${f.impact}`, { size: 9 });
  w.p(`Recommendation: ${f.recommendation}`, { size: 9, bold: true });
  if (f.manualSteps.length) { w.p('Manual remediation steps:', { size: 9, color: C.muted }); w.bullets(f.manualSteps, { size: 8.5 }); }
  if (f.terraform) w.p(`Terraform: ${f.terraform}`, { size: 8.5, color: C.muted });
  w.p(`Auto-Fix: ${f.autoFix.available ? `${f.autoFix.safety === 'SAFE_AUTOFIX' ? 'Safe Auto-Fix' : 'Auto-Fix with review'} — ${f.autoFix.description}` : 'Manual remediation only'} (${f.autoFix.safetyReason})`, { size: 8.5 });
  if (f.review) w.p(`Review: ${human(f.review.status)} by ${f.review.approvedBy} on ${f.review.approvedAt.slice(0, 10)}${f.review.expiresAt ? `, review by ${f.review.expiresAt.slice(0, 10)}` : ''} — "${f.review.reason}". The finding remains technically failing.`, { size: 8.5, color: '#6D28D9' });
  const refs = f.references.filter((r) => r.identifier || r.url).map((r) => `${r.framework}${r.identifier ? ` ${r.identifier}` : ''}: ${r.title}`);
  if (refs.length) { w.p('Official references:', { size: 8.5, color: C.muted }); w.bullets(refs, { size: 8 }); }
  d.moveDown(0.4);
}

function recTable(w: Writer, groups: RecommendationGroup[], empty: string) {
  w.table([
    { header: 'Rule', width: 17 }, { header: 'Severity', width: 13, render: sevColor }, { header: 'Recommendation', width: 52 }, { header: 'Affected resources', width: 28 }, { header: 'Auto-Fix', width: 20 },
  ], groups.map((g) => [g.ruleId, g.severity, g.recommendation, Array.from(new Set(g.resources)).join(', ') || 'Architecture-wide', g.autoFix]), { size: 8, empty });
}

// ─── Main renderer ────────────────────────────────────────────────────────────

/** Fills the contents page with real page numbers and stamps the running header/footer on every page but the cover. */
export function finishPdf(w: Writer, tocPage: number, title: string): void {
  const doc = w.doc;
  const m = w.report.meta;
  // ── TOC (with real page numbers) ──
  doc.switchToPage(tocPage);
  doc.y = PAGE.top; doc.x = PAGE.m;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(C.navy).text('Contents', PAGE.m, PAGE.top);
  doc.moveDown(0.8);
  for (const s of w.sections) {
    const indent = s.level === 1 ? 0 : 16;
    doc.font(s.level === 1 ? 'Helvetica-Bold' : 'Helvetica').fontSize(s.level === 1 ? 10.5 : 9).fillColor(C.text);
    const y = doc.y;
    if (y > PAGE.h - PAGE.bottom - 20) break;
    doc.text(pdfSafe(s.title), PAGE.m + indent, y, { width: CONTENT_W - 60 - indent, lineBreak: false, ellipsis: true });
    doc.text(String(s.page + 1), PAGE.m + CONTENT_W - 40, y, { width: 40, align: 'right' });
    doc.y = y + (s.level === 1 ? 17 : 14);
  }

  // ── Running header/footer with page numbers ──
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (i === range.start) continue; // cover
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted);
    doc.text(pdfSafe(`${title} — ${m.projectName}`), PAGE.m, 30, { width: CONTENT_W * 0.7, lineBreak: false, ellipsis: true });
    doc.text(pdfSafe(`${m.environment} · Rev ${m.architectureRevision}`), PAGE.m + CONTENT_W * 0.7, 30, { width: CONTENT_W * 0.3, align: 'right', lineBreak: false });
    doc.moveTo(PAGE.m, 44).lineTo(PAGE.m + CONTENT_W, 44).lineWidth(0.4).strokeColor(C.rule).stroke();
    doc.moveTo(PAGE.m, PAGE.h - 44).lineTo(PAGE.m + CONTENT_W, PAGE.h - 44).lineWidth(0.4).strokeColor(C.rule).stroke();
    doc.text(pdfSafe(`${m.reportId} · Ruleset ${m.rulesetVersion} · Design-time assessment — not an audit opinion`), PAGE.m, PAGE.h - 38, { width: CONTENT_W * 0.75, lineBreak: false, ellipsis: true });
    doc.text(`Page ${i + 1} of ${range.count}`, PAGE.m + CONTENT_W * 0.75, PAGE.h - 38, { width: CONTENT_W * 0.25, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
  }
}

/** Creates the A4 document, its Writer and the promise that resolves with the finished file. */
export async function openPdf(report: AssessmentReport, opts: { title: string; subject: string }) {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ size: 'A4', margins: { top: PAGE.top, bottom: PAGE.bottom - 20, left: PAGE.m, right: PAGE.m }, bufferPages: true, autoFirstPage: true, info: {
    Title: `${opts.title} — ${report.meta.projectName}`, Author: 'CloudCraft', Subject: opts.subject, Keywords: `${report.meta.reportId} ruleset ${report.meta.rulesetVersion}`,
  } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  return { doc, w: new Writer(doc, report), done };
}

export async function renderReportPdf(report: AssessmentReport): Promise<Buffer> {
  const { doc, w, done } = await openPdf(report, { title: report.meta.title, subject: 'Architecture & Security Assessment (design-time)' });
  const m = report.meta;
  const ex = report.executive;

  // ── Cover ──
  doc.rect(0, 0, PAGE.w, 300).fillColor(C.navy).fill();
  doc.font('Helvetica').fontSize(11).fillColor('#9FB6D3').text('CLOUDCRAFT', PAGE.m, 70, { characterSpacing: 3 });
  doc.font('Helvetica-Bold').fontSize(28).fillColor('#FFFFFF').text('Architecture & Security Assessment', PAGE.m, 100, { width: CONTENT_W });
  doc.font('Helvetica').fontSize(14).fillColor('#D5E1F0').text(pdfSafe(m.projectName), PAGE.m, doc.y + 10, { width: CONTENT_W });
  doc.roundedRect(PAGE.m, 250, 150, 22, 4).fillColor('#F59E0B').fill();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.navy).text('DESIGN-TIME ASSESSMENT', PAGE.m + 12, 257);
  doc.y = 340; doc.x = PAGE.m;
  w.kv([
    ['Project', m.projectName],
    ['Environment', m.environment],
    ['Provider(s)', m.providers.join(', ') || '—'],
    ['Region(s)', m.regions.join(', ') || 'Not specified'],
    ['Assessment date', fmtDate(m.assessmentDate)],
    ['Architecture version', `Revision ${m.architectureRevision}`],
    ['Report ID', m.reportId],
    ['Security score', `${scoreText(ex.security.score)} (${ex.security.rating}) — assessment coverage ${ex.security.coverage.coveragePct ?? 0}%`],
  ], 140);
  doc.y = PAGE.h - 150;
  w.box('Important', 'This report is an automated, design-time technical assessment generated by CloudCraft from the architecture as modelled. It is not an audit, attestation, certification or compliance opinion. The SOC 1 Readiness Analysis maps technical evidence only and is not a SOC 1® examination.', '#B45309');

  // ── TOC placeholder page ──
  w.newPage();
  const tocPage = w.pageIndex();

  // ── 1 Document control ──
  w.h1('1', 'Document Control');
  w.kv([
    ['Report ID', m.reportId],
    ['Report format version', m.reportFormatVersion],
    ['Generated', fmtDate(m.generatedAt)],
    ['Assessment timestamp', fmtDate(m.assessmentDate)],
    ['Assessment snapshot (scan) ID', m.scanId],
    ['Architecture revision', String(m.architectureRevision)],
    ['Architecture graph hash', m.graphHash],
    ['Architecture content SHA-256', m.contentSha256],
    ['Assessment engine / ruleset', `${m.engine} / ${m.rulesetVersion}`],
    ['Analysis mode', m.analysisMode],
  ], 170);
  w.p('Integrity: all results in this report were computed from the architecture snapshot identified above. Regenerating the report from the same snapshot ID produces the same results even if the architecture has changed since; a new assessment creates a new snapshot.', { size: 9, color: C.muted });

  // ── 2 Executive summary ──
  w.h1('2', 'Executive Summary');
  w.p(ex.overview);
  w.table([
    { header: 'Measure', width: 40 }, { header: 'Result', width: 25, render: (r) => ({ bold: true, color: r[1] === 'Not scored' ? C.na : C.navy }) }, { header: 'Coverage', width: 18 }, { header: 'Rating', width: 25 },
  ], [
    ['Security score', scoreText(ex.security.score), `${ex.security.coverage.coveragePct ?? 0}%`, ex.security.rating],
    ['All checks (security + Well-Architected)', scoreText(ex.overall.score), `${ex.overall.coverage.coveragePct ?? 0}%`, ex.overall.rating],
  ]);
  if (ex.security.capApplied) w.p(ex.security.capApplied, { size: 8.5, color: C.muted });
  if (ex.security.lowCoverage) w.box('Low assessment coverage', 'Less than 60% of applicable security checks could be evaluated. The score reflects only the evaluated checks and must not be read as the overall security posture.', '#B45309');
  w.h3('Open findings by severity');
  w.table((['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'] as Severity[]).map((s) => ({ header: s, width: 20, align: 'center' as const, render: () => ({ color: C.sev[s], bold: true }) })), [(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'] as Severity[]).map((s) => String(ex.counts[s]))]);
  w.h3('Well-Architected summary');
  for (const p of ex.wellArchitected) {
    w.p(`${p.framework}`, { bold: true, size: 9 });
    w.table([{ header: 'Pillar', width: 40 }, { header: 'Status', width: 30, render: (r) => ({ color: statusColor(r[1]) }) }, { header: 'Score', width: 18 }, { header: 'Coverage', width: 18 }],
      p.pillars.map((x) => [x.label, x.status, scoreText(x.score), x.coverage === null ? '—' : `${x.coverage}%`]), { size: 8.5 });
  }
  w.h3('SOC 1 readiness summary');
  w.p(`${ex.soc1.observed} control area(s) with technical evidence observed, ${ex.soc1.gaps} with technical gaps, ${ex.soc1.partial} partially evaluated and ${ex.soc1.notEvaluated} not evaluated. All areas also require organizational evidence and independent auditor assessment.`, { size: 9 });
  w.h3('High-impact checks passed'); w.bullets(ex.strengths, { empty: 'No critical- or high-severity security checks passed in the evaluated configuration.' });
  w.h3('Major risks'); w.bullets(ex.majorRisks, { empty: 'No critical- or high-severity failures were identified in the checks that could be evaluated.' });
  w.h3('Immediate priorities'); w.bullets(ex.immediatePriorities, { empty: 'No immediate (critical/high required) remediation items.' });
  if (report.aiCommentary) {
    const ai = report.aiCommentary;
    w.ensure(200); // keep the heading, notice and first lines together
    w.h3('AI-generated commentary');
    w.box('AI-generated', `${COMMENTARY_DISCLAIMER} Generated ${fmtDate(ai.generatedAt)}.`, '#B45309');
    if (ai.summary) w.p(ai.summary);
    if (ai.priorities.length) { w.p('Suggested order of work', { bold: true, size: 9 }); w.bullets(ai.priorities.map((p) => `${p.title} (${p.severity}, ${p.ruleId}) — ${p.problem} Fix: ${p.fix}`), { size: 8.5 }); }
    if (ai.suggestions.length) { w.p('Unverified AI suggestions (not backed by a finding)', { bold: true, size: 9 }); w.bullets(ai.suggestions, { size: 8.5 }); }
  }

  // ── 3 Architecture overview ──
  w.h1('3', 'Architecture Overview');
  w.kv([['Providers', m.providers.join(', ') || '—'], ['Regions', m.regions.join(', ') || 'Not specified'], ['Resources', String(report.architecture.resourceCount)], ['Connections', String(report.architecture.edges.length)]], 120);
  w.h2('Architecture diagram');
  w.ensure(470);
  drawDiagram(w, report.architecture.nodes, report.architecture.edges, PAGE.m + 6, doc.y + 6, CONTENT_W - 12, 440);
  w.h2('Resource summary');
  w.table([{ header: 'Provider', width: 15 }, { header: 'Resource type', width: 60 }, { header: 'Count', width: 15, align: 'right' }], report.architecture.resourceSummary.map((r) => [r.provider, r.type, String(r.count)]));
  w.h2('Data flow summary');
  w.table([{ header: 'From', width: 35 }, { header: 'To', width: 35 }, { header: 'Connection', width: 30 }], report.architecture.dataFlows.slice(0, 80).map((f) => [f.from, f.to, f.label]), { empty: 'No connections are modelled.' });

  // ── 4 Scope ──
  w.h1('4', 'Assessment Scope');
  w.h2('What was evaluated'); w.bullets(report.scope.evaluated);
  w.h2('What was not evaluated'); w.bullets(report.scope.notEvaluated.slice(0, 25), { empty: 'All applicable checks were evaluated.' });
  if (report.scope.notEvaluated.length > 25) w.p(`…and ${report.scope.notEvaluated.length - 25} more (see Appendix D).`, { color: C.muted, size: 8.5 });
  w.h2('Data sources'); w.bullets(report.scope.dataSources);
  w.h2('Limitations'); w.bullets(report.scope.limitations);

  // ── 5 Well-Architected ──
  w.h1('5', 'Well-Architected Review');
  w.p('Results are presented per provider using that provider\'s own framework and pillar terminology. A pillar is scored only when at least one check in it could be evaluated.', { size: 9, color: C.muted });
  for (const prov of report.wellArchitected) {
    w.h2(prov.framework, true);
    for (const p of prov.pillars) {
      w.h3(`${p.label} — ${p.status}`, statusColor(p.status));
      w.p(`Score: ${scoreText(p.score.score)}   Coverage: ${p.score.coverage.coveragePct ?? '—'}${p.score.coverage.coveragePct === null ? '' : '%'} (${p.score.coverage.evaluated} evaluated, ${p.score.coverage.notEvaluated + p.score.coverage.insufficientData} not evaluated)${p.score.capApplied ? `   ${p.score.capApplied}` : ''}`, { size: 8.5, color: C.muted });
      if (p.strengths.length) { w.p('Strengths:', { size: 8.5, bold: true }); w.bullets(p.strengths.slice(0, 4), { size: 8.5 }); }
      if (p.findings.length) {
        w.table([{ header: 'Finding ID', width: 26 }, { header: 'Severity', width: 14, render: sevColor }, { header: 'Finding', width: 50 }, { header: 'Resources', width: 30 }],
          p.findings.map((f) => [f.findingId, f.severity, f.title, f.resourceLabels.join(', ') || 'Architecture-wide']), { size: 8 });
      } else if (p.status !== 'Insufficient evidence') {
        w.p('No findings in the evaluated checks.', { size: 8.5, color: C.muted });
      } else {
        w.p('Insufficient architecture evidence to assess this pillar.', { size: 8.5, color: C.muted });
      }
    }
  }

  // ── 6 Security assessment ──
  w.h1('6', 'Security Assessment');
  w.table((['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'] as Severity[]).map((s) => ({ header: s, width: 20, align: 'center' as const, render: () => ({ color: C.sev[s], bold: true }) })), [(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'] as Severity[]).map((s) => String(report.security.counts[s]))]);
  if (report.security.findings.length === 0) w.p('No security findings in the evaluated checks. See Appendix D for controls that could not be evaluated.');
  for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'] as Severity[]) {
    const list = report.security.findings.filter((f) => f.severity === sev);
    if (list.length === 0) continue;
    w.h2(`${human(sev)} severity (${list.length})`, true);
    for (const f of list) findingBlock(w, f);
  }

  // ── 7 SOC 1 ──
  w.h1('7', 'SOC 1 Readiness Analysis');
  w.box('Not a SOC 1 attestation', report.soc1.disclaimer, '#B91C1C');
  w.table([{ header: 'Control area', width: 45 }, { header: 'Status', width: 25, render: (r) => ({ color: statusColor(r[1]) }) }, { header: 'Evidence types', width: 45 }],
    report.soc1.areas.map((a) => [`${a.id} ${a.name}`, a.status, a.evidenceTypes.map(human).join(', ')]), { size: 8 });
  for (const a of report.soc1.areas) {
    w.h3(`${a.id}  ${a.name} — ${a.status}`, statusColor(a.status));
    w.p(`Objective: ${a.objective}`, { size: 8.5, color: C.muted });
    w.p('Architecture evidence (design-time configuration):', { size: 8.5, bold: true });
    w.bullets(a.architectureEvidence.slice(0, 8), { size: 8, empty: 'None.' });
    w.p('Discovered cloud evidence (configuration returned by AWS/Azure):', { size: 8.5, bold: true });
    w.bullets(a.discoveredEvidence.slice(0, 8), { size: 8, empty: 'None — no discovered configuration supported this area.' });
    w.p('User-provided evidence:', { size: 8.5, bold: true });
    w.bullets(a.userProvidedEvidence, { size: 8, empty: 'None recorded. CloudCraft does not collect organizational evidence.' });
    if (a.gaps.length) { w.p('Technical gaps / not evaluated:', { size: 8.5, bold: true }); w.bullets(a.gaps.slice(0, 8), { size: 8 }); }
    if (a.relatedResourceLabels.length) w.p(`Related resources: ${a.relatedResourceLabels.slice(0, 15).join(', ')}`, { size: 8 });
    if (a.recommendedActions.length) { w.p('Recommended actions:', { size: 8.5, bold: true }); w.bullets(a.recommendedActions.slice(0, 5), { size: 8 }); }
    w.p('Organizational evidence required:', { size: 8.5, bold: true }); w.bullets(a.organizationalEvidenceRequired, { size: 8 });
    w.p(`Auditor assessment required: ${a.auditorAssessmentRequired}`, { size: 8 });
    w.p(`Conclusion: not concluded. ${a.conclusionReason}`, { size: 8, bold: true });
    w.p(`Evidence limitations: ${a.limitations}`, { size: 8, color: C.muted });
  }
  w.h2('Organizational controls CloudCraft cannot evaluate');
  w.bullets(report.soc1.organizationalControls.map((c) => `${c} — requires organizational evidence and auditor assessment.`), { size: 8.5 });

  // ── 8 Best practices ──
  w.h1('8', 'Best-Practice Recommendations');
  w.h2('Required remediation'); recTable(w, report.bestPractices.required, 'No required remediation items.');
  w.h2('Recommended improvements'); recTable(w, report.bestPractices.recommended, 'No recommended improvements.');
  w.h2('Optional optimizations'); recTable(w, report.bestPractices.optional, 'No optional optimizations.');

  // ── 9 Remediation plan ──
  w.h1('9', 'Remediation Plan');
  w.h2('Immediate (critical, and high-severity required items)'); recTable(w, report.remediationPlan.immediate, 'Nothing requires immediate action.');
  w.h2('Short term (remaining high and medium)'); recTable(w, report.remediationPlan.shortTerm, 'No short-term items.');
  w.h2('Long term (low and informational)'); recTable(w, report.remediationPlan.longTerm, 'No long-term items.');

  // ── 10 Auto-Fix ──
  w.h1('10', 'Auto-Fix Summary');
  w.table([{ header: 'Category', width: 60 }, { header: 'Open findings', width: 20, align: 'right' }], [
    ['Eligible for safe Auto-Fix', String(report.autoFix.safe.length)],
    ['Auto-Fix available after review and confirmation', String(report.autoFix.reviewRequired.length)],
    ['Manual remediation only', String(report.autoFix.manual.length)],
    ['Resolved since previous assessment', report.comparison ? String(report.autoFix.resolvedSincePrevious.length) : 'No previous assessment'],
  ]);
  const afRows = [...report.autoFix.safe, ...report.autoFix.reviewRequired].map((f) => [f.findingId, f.autoFix.safety === 'SAFE_AUTOFIX' ? 'Safe' : 'Review required', f.autoFix.description ?? '', f.resourceLabels.join(', ')]);
  w.table([{ header: 'Finding ID', width: 28 }, { header: 'Safety', width: 18 }, { header: 'Proposed change', width: 50 }, { header: 'Resource', width: 25 }], afRows, { size: 8, empty: 'No open findings are eligible for Auto-Fix.' });
  if (report.autoFix.history.length) {
    w.h2('Auto-Fix change history');
    w.table([{ header: 'Timestamp', width: 25 }, { header: 'Change', width: 75 }, { header: 'By', width: 20 }], report.autoFix.history.map((h) => [fmtDate(h.timestamp), h.summary, h.author]), { size: 8 });
  }

  // ── 11 Inventory ──
  w.h1('11', 'Resource Security Inventory');
  w.p('Pass = all evaluated checks in the category passed; Gap = at least one failing check; Partial = some checks not evaluated; — = no applicable check.', { size: 8.5, color: C.muted });
  const invColor = (r: string[], i: number) => ({ color: statusColor(r[i]) });
  w.table([
    { header: 'Resource', width: 24 }, { header: 'Type', width: 22 }, { header: 'Prov.', width: 9 }, { header: 'Open', width: 8, align: 'center' },
    { header: 'Encryption', width: 13, render: invColor }, { header: 'Exposure', width: 13, render: invColor }, { header: 'Identity', width: 12, render: invColor }, { header: 'Backup', width: 12, render: invColor }, { header: 'Monitoring', width: 14, render: invColor },
  ], report.inventory.map((r) => [r.resource, r.type, r.provider, String(r.openFindings), r.encryption, r.exposure, r.identity, r.backup, r.monitoring]), { size: 7.5 });

  // ── 12 Mapping ──
  w.h1('12', 'Framework / Control Mapping');
  w.p('Each technical finding is evaluated once and mapped to multiple frameworks. Mappings to SOC 1 readiness areas are technical-evidence mappings only.', { size: 8.5, color: C.muted });
  w.table([{ header: 'Finding', width: 30 }, { header: 'Well-Architected', width: 38 }, { header: 'Security guidance', width: 32 }, { header: 'SOC 1 area', width: 20 }],
    report.mapping.map((r) => [`${r.findingId}\n${r.title}`, r.wellArchitected, r.securityGuidance, r.soc1]), { size: 7.5, empty: 'No findings to map.' });

  // ── 13 Comparison ──
  if (report.comparison) {
    const c = report.comparison;
    w.h1('13', 'Comparison With Previous Assessment');
    w.kv([
      ['Previous assessment', `${fmtDate(c.previousCreatedAt)} (revision ${c.previousRevision}, snapshot ${c.previousScanId.slice(0, 8)})`],
      ['Security score', `${scoreText(c.securityScore.previous)} -> ${scoreText(c.securityScore.current)}`],
      ['Security coverage', `${c.coverage.previous ?? '—'}% -> ${c.coverage.current ?? '—'}%`],
      ['New / resolved / unchanged', `${c.newFindings.length} / ${c.resolvedFindings.length} / ${c.unchangedCount}`],
      ['Regressions', `${c.regressions.length} (checks that previously passed and now fail)`],
    ], 150);
    if (c.rulesetChanged) w.p('Note: the ruleset version changed between assessments; some differences may reflect rule changes rather than architecture changes.', { size: 8.5, color: C.warn });
    w.h2('New findings'); w.table([{ header: 'Finding ID', width: 30 }, { header: 'Severity', width: 15, render: sevColor }, { header: 'Title', width: 60 }], c.newFindings.map((f) => [f.findingId, f.severity, f.title]), { size: 8, empty: 'None.' });
    w.h2('Resolved findings'); w.table([{ header: 'Finding ID', width: 30 }, { header: 'Severity', width: 15, render: sevColor }, { header: 'Title', width: 60 }], c.resolvedFindings.map((f) => [f.findingId, f.severity, f.title]), { size: 8, empty: 'None.' });
    if (c.regressions.length) { w.h2('Regressions'); w.table([{ header: 'Finding ID', width: 30 }, { header: 'Severity', width: 15, render: sevColor }, { header: 'Title', width: 60 }], c.regressions.map((f) => [f.findingId, f.severity, f.title]), { size: 8 }); }
  }

  // ── Appendices ──
  w.h1('Appendix A', 'Rule Reference');
  w.table([{ header: 'Rule ID', width: 17 }, { header: 'Prov.', width: 8 }, { header: 'Service', width: 20 }, { header: 'Check', width: 45 }, { header: 'Severity', width: 13, render: sevColor }, { header: 'Control refs', width: 20 }],
    report.appendix.rules.map((r) => [r.id, r.provider, r.service, r.title, r.severity, r.references]), { size: 7.5 });
  w.h1('Appendix B', 'Official References');
  w.p('Reference metadata only; CloudCraft does not reproduce documentation text. Verification describes how each reference was checked when the ruleset was built.', { size: 8.5, color: C.muted });
  w.table([{ header: 'Framework', width: 30 }, { header: 'Identifier', width: 18 }, { header: 'Title', width: 42 }, { header: 'Verification', width: 18 }],
    report.appendix.references.map((r) => [r.framework, r.identifier ?? '—', `${r.title}${r.url ? `\n${r.url}` : ''}`, VERIFICATION_LABEL[r.verification]]), { size: 7 });
  w.h1('Appendix C', 'Methodology & Definitions');
  w.bullets(report.appendix.methodology, { size: 8.5 });
  w.table([{ header: 'Term', width: 25 }, { header: 'Definition', width: 75 }], report.appendix.definitions.map((d) => [d.term, d.definition]), { size: 8 });
  w.h1('Appendix D', 'Controls Not Evaluated');
  w.p('Each control below could not be evaluated from the evidence available to this assessment. It is not counted as passing. The last column states where the evidence could come from.', { size: 8.5, color: C.muted });
  w.table([{ header: 'ID', width: 22 }, { header: 'Control', width: 30 }, { header: 'Resources', width: 18 }, { header: 'Why not evaluated / evidence needed', width: 50 }],
    report.appendix.notEvaluated.map((r) => [r.id, r.control, r.resources, `${r.availability}\n${r.requiredData}`]), { size: 7.5, empty: 'All applicable checks were evaluated.' });
  w.h1('Appendix E', 'Limitations');
  w.bullets(report.appendix.limitations);

  finishPdf(w, tocPage, m.title);

  doc.end();
  return done;
}
