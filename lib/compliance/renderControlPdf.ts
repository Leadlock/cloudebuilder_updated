/**
 * The Well-Architected control report (AWS or Azure) as a PDF (server only). One page that answers "where do we stand", a page per pillar overview, then every control
 * in a short block: who owns it, how it scores, what supports that score and what to do next. Drawn with pdfkit as vector text and shapes.
 */
import { pdfSafe } from '@/lib/services/report/renderReportPdf';
import { SCORE_LABEL, SCORE_MEANING, type ControlResult, type Score } from './types';
import { EVIDENCE_WINDOW_DAYS } from './scoring';
import type { ReadinessReport } from './report';

type Doc = PDFKit.PDFDocument;
const P = { w: 595.28, h: 841.89, m: 50, top: 64, bottom: 56 };
const CW = P.w - P.m * 2;
const K = {
  navy: '#1F3A5F', teal: '#0F766E', text: '#1F2937', muted: '#5B6573', line: '#D5DCE5', band: '#F1F4F8', white: '#FFFFFF',
  score: ['#B91C1C', '#C2410C', '#A16207', '#15803D', '#0F766E'] as string[], scoreBg: ['#FBE4E6', '#FDE9D6', '#FFF4C7', '#DDF1E2', '#C9EBD5'] as string[], none: '#64748B', noneBg: '#E7EAEE',
  sev: { High: '#B91C1C', Medium: '#A16207', Low: '#1D4ED8' } as Record<string, string>,
  ready: { Ready: '#15803D', 'Ready with conditions': '#A16207', 'Not ready': '#B91C1C', Incomplete: '#64748B' } as Record<string, string>,
};
const s = (x: unknown) => pdfSafe(x);
const plural = (n: number, a: string, b = `${a}s`) => `${n} ${n === 1 ? a : b}`;
const longDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const scoreColor = (r: ControlResult) => (r.score === null ? K.none : K.score[r.score]!);
const scoreBg = (r: ControlResult) => (r.score === null ? K.noneBg : K.scoreBg[r.score]!);

class Page {
  constructor(public doc: Doc) {}
  get y() { return this.doc.y; }
  ensure(h: number) { if (this.doc.y + h > P.h - P.bottom) this.add(); }
  add() { this.doc.addPage(); this.doc.x = P.m; this.doc.y = P.top; }
  text(t: string, o: { size?: number; bold?: boolean; color?: string; width?: number; x?: number; after?: number; align?: 'left' | 'center' | 'right'; gap?: number } = {}) {
    const d = this.doc;
    d.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size ?? 9.5).fillColor(o.color ?? K.text).text(s(t), o.x ?? P.m, d.y, { width: o.width ?? CW, align: o.align ?? 'left', lineGap: o.gap ?? 1.5 });
    if (o.after) d.y += o.after;
  }
  h1(t: string) { this.add(); this.text(t, { size: 20, bold: true, color: K.navy, after: 4 }); const y = this.doc.y; this.doc.moveTo(P.m, y).lineTo(P.m + 56, y).lineWidth(3).strokeColor(K.teal).stroke(); this.doc.y = y + 12; }
  h2(t: string, keep = 90) { this.ensure(keep); this.doc.y += 6; this.text(t, { size: 13, bold: true, color: K.navy, after: 4 }); }
  pill(t: string, x: number, y: number, fg: string, bg: string): number {
    const d = this.doc; d.font('Helvetica-Bold').fontSize(7.5);
    const w = d.widthOfString(s(t)) + 12;
    d.roundedRect(x, y, w, 13, 6).fillColor(bg).fill(); d.fillColor(fg).text(s(t), x + 6, y + 3, { lineBreak: false });
    return w;
  }
  box(t: string, color = K.teal, bg = K.band) {
    const d = this.doc; d.font('Helvetica').fontSize(9);
    const h = d.heightOfString(s(t), { width: CW - 24, lineGap: 1.5 }) + 16;
    this.ensure(h + 6);
    const y = d.y; d.rect(P.m, y, CW, h).fillColor(bg).fill(); d.rect(P.m, y, 3.5, h).fillColor(color).fill();
    d.fillColor(K.text).text(s(t), P.m + 14, y + 8, { width: CW - 24, lineGap: 1.5 }); d.y = y + h + 8;
  }
  table(cols: Array<{ h: string; w: number; align?: 'left' | 'right' | 'center' }>, rows: string[][], o: { size?: number; empty?: string; color?: (row: string[], c: number) => string | undefined } = {}) {
    const d = this.doc; const size = o.size ?? 8.5; const total = cols.reduce((a, c) => a + c.w, 0);
    const w = cols.map((c) => (c.w / total) * CW);
    const header = () => { const y = d.y; d.rect(P.m, y, CW, 18).fillColor(K.navy).fill(); let x = P.m; cols.forEach((c, i) => { d.font('Helvetica-Bold').fontSize(size).fillColor(K.white).text(s(c.h), x + 5, y + 5, { width: w[i]! - 10, align: c.align ?? 'left', lineBreak: false }); x += w[i]!; }); d.y = y + 18; };
    if (rows.length === 0) { this.text(o.empty ?? 'None.', { color: K.muted, size }); return; }
    this.ensure(40); header();
    rows.forEach((r, ri) => {
      d.font('Helvetica').fontSize(size);
      const h = Math.max(...r.map((cell, i) => d.heightOfString(s(cell), { width: w[i]! - 10, lineGap: 1 }))) + 9;
      if (d.y + h > P.h - P.bottom) { this.add(); header(); }
      const y = d.y; if (ri % 2 === 1) d.rect(P.m, y, CW, h).fillColor('#F7F9FB').fill();
      let x = P.m; r.forEach((cell, i) => { d.font('Helvetica').fontSize(size).fillColor(o.color?.(r, i) ?? K.text).text(s(cell), x + 5, y + 4.5, { width: w[i]! - 10, align: cols[i]!.align ?? 'left', lineGap: 1 }); x += w[i]!; });
      d.moveTo(P.m, y + h).lineTo(P.m + CW, y + h).lineWidth(0.4).strokeColor(K.line).stroke(); d.y = y + h;
    });
    d.y += 6;
  }
}

function cover(p: Page, r: ReadinessReport) {
  const d = p.doc;
  d.rect(0, 0, P.w, 330).fillColor(K.navy).fill(); d.rect(0, 330, P.w, 5).fillColor(K.teal).fill();
  d.font('Helvetica-Bold').fontSize(9).fillColor('#9FC5E8').text('CONTROL REPORT', P.m, 120, { characterSpacing: 2 });
  d.font('Helvetica-Bold').fontSize(31).fillColor(K.white).text(s(r.framework === 'aws-waf' ? 'AWS Well-Architected Framework' : 'Azure Well-Architected Framework'), P.m, 142, { width: CW });
  d.font('Helvetica').fontSize(15).fillColor('#D7E3F1').text('Where each control stands, what supports it, and what to do next', P.m, d.y + 8, { width: CW });
  d.y = 372;
  const facts: Array<[string, string]> = [['Prepared for', r.company], ['System', r.system.name], ['Control status as of', longDate(r.asOf)], ['Controls in scope', String(r.summary.total - r.summary.notApplicable)], ['Version', `${r.version}  (report ${r.reportId})`], ['Prepared by', r.preparedBy || 'To be completed']];
  facts.forEach(([k, v], i) => {
    const x = P.m + (i % 2) * (CW / 2); const y = 372 + Math.floor(i / 2) * 50;
    d.font('Helvetica').fontSize(8).fillColor(K.muted).text(s(k.toUpperCase()), x, y, { characterSpacing: 1 });
    d.font('Helvetica-Bold').fontSize(12).fillColor(K.text).text(s(v), x, y + 13, { width: CW / 2 - 16 });
  });
  d.rect(P.m, 640, CW, 0.5).fillColor(K.line).fill();
  d.font('Helvetica').fontSize(8.5).fillColor(K.muted).text(s('This report was prepared by the company with CloudBuilder. Scores come from checks CloudBuilder ran on the architecture, from readings of the cloud account, and from what the team answered and attached. It is not an audit or a certification and gives no opinion. Where something was not provided, the report says so.'), P.m, 650, { width: CW, lineGap: 2 });
}

function glance(p: Page, r: ReadinessReport) {
  const sm = r.summary; const d = p.doc;
  p.h1('Where you stand');
  const y0 = d.y;
  d.roundedRect(P.m, y0, CW, 74, 6).fillColor(K.band).fill(); d.rect(P.m, y0, 5, 74).fillColor(K.ready[r.readiness]!).fill();
  d.font('Helvetica').fontSize(8).fillColor(K.muted).text('READINESS', P.m + 18, y0 + 12, { characterSpacing: 1 });
  d.font('Helvetica-Bold').fontSize(20).fillColor(K.ready[r.readiness]!).text(s(r.readiness), P.m + 18, y0 + 26, { width: 190 });
  const meaning: Record<string, string> = {
    Ready: 'Every control operates and no serious finding is open.', 'Ready with conditions': 'Every control is at least implemented, but some are not yet shown to operate or findings are open.',
    'Not ready': 'At least one control is missing or only informal, or a serious finding is open.', Incomplete: 'Some controls have not been assessed, so no conclusion can be drawn yet.',
  };
  d.font('Helvetica').fontSize(10).fillColor(K.text).text(s(meaning[r.readiness]!), P.m + 220, y0 + 16, { width: CW - 236, lineGap: 2 });
  d.y = y0 + 90;

  // the number cards
  const cards: Array<[string, string]> = [['Controls in scope', String(sm.total - sm.notApplicable)], ['Assessed', `${sm.coveragePct}%`], ['Average score', sm.average === null ? 'n/a' : `${sm.average} / 4`], ['Open findings', String(r.findings.filter((f) => f.status === 'open' || f.status === 'in_progress').length)]];
  const cw = (CW - 3 * 10) / 4; const cy = d.y;
  cards.forEach(([k, v], i) => { const x = P.m + i * (cw + 10); d.roundedRect(x, cy, cw, 52, 5).lineWidth(0.8).strokeColor(K.line).stroke(); d.font('Helvetica-Bold').fontSize(18).fillColor(K.navy).text(s(v), x + 12, cy + 9, { width: cw - 20 }); d.font('Helvetica').fontSize(8).fillColor(K.muted).text(s(k), x + 12, cy + 34, { width: cw - 20 }); });
  d.y = cy + 70;

  // score distribution: one stacked bar and a legend
  p.text('Controls by score', { size: 11, bold: true, color: K.navy, after: 4 });
  const parts: Array<[string, number, string]> = [...([4, 3, 2, 1, 0] as Score[]).map((n): [string, number, string] => [`${n} ${SCORE_LABEL[n]}`, sm.byScore[n], K.score[n]!]), ['Not assessed', sm.notAssessed, K.none], ['Not applicable', sm.notApplicable, '#B8C0CA']];
  const total = parts.reduce((a, x) => a + x[1], 0) || 1; let x = P.m; const by = d.y;
  parts.forEach(([, n, c]) => { const w = (n / total) * CW; if (w > 0) { d.rect(x, by, w, 16).fillColor(c).fill(); x += w; } });
  const legendY = by + 26;
  parts.forEach(([k, n, c], i) => { const col = i % 3; const row = Math.floor(i / 3); const lx = P.m + col * (CW / 3); const ly = legendY + row * 15; d.rect(lx, ly + 2, 8, 8).fillColor(c).fill(); d.font('Helvetica').fontSize(8.5).fillColor(K.text).text(s(`${k}: ${n}`), lx + 13, ly, { lineBreak: false }); });
  d.y = legendY + Math.ceil(parts.length / 3) * 15 + 12;

  // by pillar
  p.h2('By pillar', 120);
  const rows = sm.groups.map((g) => [g.group, String(g.controls), g.average === null ? 'n/a' : String(g.average), String(g.belowTarget), String(g.notAssessed), g.confidence]);
  p.table([{ h: 'Pillar', w: 3.4 }, { h: 'Controls', w: 1.2, align: 'right' }, { h: 'Average (0-4)', w: 1.6, align: 'right' }, { h: 'Below 3', w: 1.2, align: 'right' }, { h: 'Not assessed', w: 2, align: 'right' }, { h: 'Confidence', w: 1.5 }], rows, { size: 9 });
  // average bars
  const bars = sm.groups.filter((g) => g.average !== null); if (bars.length) {
    p.text('Average score by pillar (0 to 4)', { size: 9, color: K.muted, after: 2 });
    bars.forEach((g) => { p.ensure(16); const y = d.y; d.font('Helvetica').fontSize(8.5).fillColor(K.text).text(s(g.group), P.m, y + 2, { width: 150, lineBreak: false }); d.rect(P.m + 160, y + 2, CW - 200, 9).fillColor('#EDF0F4').fill(); d.rect(P.m + 160, y + 2, (CW - 200) * ((g.average as number) / 4), 9).fillColor(K.score[Math.min(4, Math.round(g.average as number))]!).fill(); d.font('Helvetica-Bold').fontSize(8.5).fillColor(K.text).text(String(g.average), P.m + CW - 32, y + 2, { lineBreak: false }); d.y = y + 16; });
  }
}

function attention(p: Page, r: ReadinessReport) {
  const open = r.findings.filter((f) => f.status === 'open' || f.status === 'in_progress');
  p.h1('What needs attention');
  p.text(open.length ? `${plural(open.length, 'finding')} ${open.length === 1 ? 'is' : 'are'} open. The most serious come first. Each one is a control that is missing, only informal, only partly shown, or has a failing check.` : 'No finding is open.', { color: K.muted, after: 6 });
  const d = p.doc;
  open.slice(0, 14).forEach((f) => {
    p.ensure(70); const y = d.y;
    p.pill(f.severity.toUpperCase(), P.m, y, K.white, K.sev[f.severity]!); d.font('Helvetica-Bold').fontSize(8.5).fillColor(K.muted).text(s(`${f.controlId}  ${f.group}`), P.m + 62, y + 3, { lineBreak: false });
    d.y = y + 17; p.text(f.title, { bold: true, size: 10, color: K.navy, after: 1 });
    p.text(`What we found: ${f.condition}`, { size: 9, after: 1 }); p.text(`What to do: ${f.recommendation}`, { size: 9, bold: true, after: 8 });
  });
  if (open.length > 14) p.text(`${open.length - 14} more are listed with their controls.`, { color: K.muted, size: 9 });
}

function controlBlock(p: Page, r: ReadinessReport, c: ControlResult) {
  const d = p.doc; const def = r.defs.find((x) => x.id === c.id)!;
  const lines: string[] = [];
  const fails = c.signals.filter((x) => x.result === 'fail'); const passes = c.signals.filter((x) => x.result === 'pass'); const unclear = c.signals.filter((x) => x.result === 'unclear');
  fails.slice(0, 2).forEach((x) => lines.push(`Problem found: ${x.text}`));
  if (passes.length) lines.push(`${plural(passes.length, 'check')} passed (${[...new Set(passes.map((x) => ({ design: 'on the design', discovered: 'in the cloud account', live: 'live', answer: 'the team\'s answer', platform: 'CloudBuilder records' }[x.basis])))].join(', ')}).`);
  if (unclear.length) lines.push(`${plural(unclear.length, 'check')} could not be completed.`);
  c.evidence.slice(0, 3).forEach((e) => lines.push(`${e.id}: ${e.title}, dated ${e.collectedAt}${e.origin === 'system' ? ' (system export)' : ''}`));
  if (c.evidence.length > 3) lines.push(`${c.evidence.length - 3} more evidence items.`);
  if (!lines.length) lines.push(c.reasons[0] ?? 'Nothing supports this control yet.');
  if (c.note.trim()) lines.push(`Note: ${c.note.trim()}`);
  const text = lines.map((l) => `- ${l}`).join('\n');
  d.font('Helvetica-Bold').fontSize(10);
  const hTitle = d.heightOfString(s(`${c.id}   ${c.title}`), { width: CW - 130 });
  d.font('Helvetica').fontSize(8.7);
  const hBody = d.heightOfString(s(text), { width: CW - 22, lineGap: 1.2 }) + d.heightOfString(s(`To raise the score: ${c.nextStep}`), { width: CW - 22, lineGap: 1.2 });
  const h = Math.max(hTitle, 14) + 34 + hBody + 16;
  p.ensure(Math.min(h, 200)); if (d.y + h > P.h - P.bottom) p.add();
  const y = d.y;
  d.rect(P.m, y, 4, h - 6).fillColor(scoreColor(c)).fill();
  d.font('Helvetica-Bold').fontSize(10).fillColor(K.navy).text(s(`${c.id}   ${c.title}`), P.m + 14, y + 1, { width: CW - 130 });
  const label = c.score === null ? c.scoreLabel : `${c.score}  ${c.scoreLabel}`;
  d.font('Helvetica-Bold').fontSize(8); const lw = d.widthOfString(s(label)) + 14;
  d.roundedRect(P.m + CW - lw, y, lw, 15, 7).fillColor(scoreBg(c)).fill(); d.fillColor(scoreColor(c)).text(s(label), P.m + CW - lw + 7, y + 4, { lineBreak: false });
  const my = y + Math.max(hTitle, 14) + 4;
  d.font('Helvetica').fontSize(8.2).fillColor(K.muted).text(s(`Owner: ${c.owner || 'none named'} (${def.ownerRole})   |   Confidence: ${c.confidence}   |   ${c.status ? { implemented: 'Owner says: in place', partial: 'Owner says: in part', planned: 'Owner says: planned', none: 'Owner says: not in place', not_applicable: 'Owner says: not applicable' }[c.status] : 'Not yet answered'}${c.reviewer ? `   |   Reviewed by ${c.reviewer}` : ''}`), P.m + 14, my, { width: CW - 22 });
  d.font('Helvetica').fontSize(8.7).fillColor(K.text).text(s(text), P.m + 14, my + 16, { width: CW - 22, lineGap: 1.2 });
  d.font('Helvetica-Bold').fontSize(8.7).fillColor(K.teal).text(s(`To raise the score: ${c.nextStep}`), P.m + 14, d.y + 3, { width: CW - 22, lineGap: 1.2 });
  d.y = y + h;
}

function controls(p: Page, r: ReadinessReport) {
  p.h1('Every control');
  p.text('Grouped by pillar. The coloured bar and label show the score; the lines under it show what the score rests on.', { color: K.muted, after: 6 });
  for (const g of [...new Set(r.results.map((x) => x.group))]) {
    p.h2(g, 140);
    r.results.filter((x) => x.group === g).forEach((c) => controlBlock(p, r, c));
  }
}

function back(p: Page, r: ReadinessReport) {
  p.h1('Limits and method');
  p.h2('What this report cannot tell you');
  r.limitations.length ? p.table([{ h: 'ID', w: 0.8 }, { h: 'What is missing or limited', w: 5 }, { h: 'Effect', w: 4 }], r.limitations.map((l) => [l.id, l.item, l.effect]), { size: 8 }) : p.text('No limitations recorded.', { color: K.muted });
  p.h2('Evidence index', 100);
  p.table([{ h: 'Ref', w: 0.8 }, { h: 'Title', w: 4 }, { h: 'Source', w: 1.4 }, { h: 'Dated', w: 1.3 }, { h: 'Used for', w: 2.5 }], r.evidenceIndex.map((e) => [e.ref, e.title, e.origin === 'system' ? 'System export' : 'By hand', e.collectedAt, e.controls.join(', ')]), { size: 8, empty: 'No evidence has been attached yet.' });
  p.h2('How scores are decided', 160);
  p.table([{ h: 'Score', w: 1.6 }, { h: 'Meaning', w: 6 }], ([0, 1, 2, 3, 4] as Score[]).map((n) => [`${n}  ${SCORE_LABEL[n]}`, SCORE_MEANING[n]]), { size: 8.5, color: (row, i) => (i === 0 ? K.score[Number(row[0]![0])] : undefined) });
  p.text(`Evidence counts as current if it is dated within ${EVIDENCE_WINDOW_DAYS} days before the report date and has not expired. A failing check keeps a control at 2 or below. A control reaches 4 only when someone other than its owner has reviewed it. A control nobody has answered for is "Not assessed": it is not scored and it keeps the report from being called ready.`, { size: 9, color: K.muted, after: 8 });
  p.box(`Prepared by ${r.preparedBy || 'the company'} with CloudBuilder (rule set ${r.rulesetVersion}). Report ${r.reportId}, ${r.version}, generated ${longDate(r.generatedAt)}. This report is a working document for the control owners and for an auditor. A control marked as operating reflects the evidence and checks described, not an independent test of the control.`);
}

export async function renderControlPdf(r: ReadinessReport): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ size: 'A4', margins: { top: P.top, bottom: P.bottom - 20, left: P.m, right: P.m }, bufferPages: true, info: { Title: `${r.title}: ${r.company}`, Author: 'CloudBuilder', Subject: `${r.system.name} as of ${r.asOf}`, Keywords: r.reportId } });
  const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const p = new Page(doc);
  cover(p, r); glance(p, r); attention(p, r); controls(p, r); back(p, r);
  const range = doc.bufferedPageRange();
  for (let i = 1; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const bm = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(K.muted).text(s(`${r.company}  |  ${r.title}  |  ${r.reportId}  |  Confidential: for the company and its auditors`), P.m, P.h - 38, { width: CW * 0.8, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, P.m + CW * 0.8, P.h - 38, { width: CW * 0.2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bm;
  }
  doc.end();
  return done;
}
