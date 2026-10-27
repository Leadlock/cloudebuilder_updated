/**
 * The SOC 2 Type 1 readiness report as a Word document (server only). It is written to be read by a manager first and an auditor second: a one-page answer,
 * then the detail, then the appendices an auditor asks for. It is a readiness report prepared by the company: it gives no opinion and is never called a SOC 2 report.
 */
import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, LevelFormat, PageNumber, PageOrientation, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
  type ISectionOptions,
} from 'docx';
import { SCORE_LABEL, SCORE_MEANING, type ControlResult, type Score } from './types';
import { SOC2_CATEGORY_LABEL, SOC2_CATEGORY_RANGE, SOC2_CRITERIA, SOC2_CRITERIA_BY_ID } from './soc2/criteria';
import { periodRows, periodSentence } from './snapshots';
import type { CpaCheck, ReadinessReport } from './report';
import { EVIDENCE_WINDOW_DAYS } from './scoring';

const NAVY = '1F3A5F'; const TEAL = '0F766E'; const GREY = '5B6573'; const LINE = 'C9D1DB'; const BAND = 'F1F4F8';
const SCORE_FILL: Record<string, string> = { 0: 'F8D7DA', 1: 'FDE4CC', 2: 'FFF1B8', 3: 'D8EFDD', 4: 'B9E5C8', n: 'E7EAEE' };
const SEV_FILL: Record<string, string> = { High: 'F8D7DA', Medium: 'FFF1B8', Low: 'DCE8F8' };
const READY_FILL: Record<string, string> = { Ready: 'B9E5C8', 'Ready with conditions': 'FFF1B8', 'Not ready': 'F8D7DA', Incomplete: 'E7EAEE' };
const TBD = 'To be completed by management';
const FONT = 'Calibri';

const W_PORTRAIT = 9638;      // A4 width minus 2 cm margins, in twentieths of a point
const W_LANDSCAPE = 14173;    // A4 landscape

// ── small builders ────────────────────────────────────────────────────────
const t = (text: string, o: { bold?: boolean; color?: string; size?: number; italics?: boolean } = {}) => new TextRun({ text, font: FONT, bold: o.bold, color: o.color, size: o.size, italics: o.italics });
const p = (text: string | TextRun[], o: { bold?: boolean; color?: string; size?: number; after?: number; before?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; italics?: boolean; keepNext?: boolean } = {}) =>
  new Paragraph({ children: typeof text === 'string' ? [t(text, o)] : text, spacing: { after: o.after ?? 120, before: o.before ?? 0, line: 276 }, alignment: o.align, keepNext: o.keepNext });
const h1 = (text: string) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [t(text, { bold: true, color: NAVY, size: 34 })], spacing: { before: 120, after: 160 }, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: TEAL, space: 4 } }, keepNext: true });
const h2 = (text: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [t(text, { bold: true, color: NAVY, size: 26 })], spacing: { before: 240, after: 100 }, keepNext: true });
const h3 = (text: string) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [t(text, { bold: true, color: TEAL, size: 22 })], spacing: { before: 160, after: 60 }, keepNext: true });
const bullet = (text: string | TextRun[]) => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: typeof text === 'string' ? [t(text)] : text, spacing: { after: 60, line: 276 } });
const note = (text: string, fill = BAND) => new Table({
  width: { size: W_PORTRAIT, type: WidthType.DXA }, columnWidths: [W_PORTRAIT],
  rows: [new TableRow({ children: [new TableCell({ width: { size: W_PORTRAIT, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill, color: 'auto' }, margins: { top: 100, bottom: 100, left: 160, right: 160 },
    borders: { left: { style: BorderStyle.SINGLE, size: 24, color: TEAL }, top: NONE, bottom: NONE, right: NONE }, children: [p(text, { size: 20, after: 0 })] })] })],
});
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const thin = { style: BorderStyle.SINGLE, size: 4, color: LINE };

interface Col { header: string; width: number }
function table(total: number, cols: Col[], rows: Array<Array<string | { text: string; fill?: string; bold?: boolean }>>, o: { size?: number; empty?: string } = {}) {
  const size = o.size ?? 18;
  const scale = total / cols.reduce((a, c) => a + c.width, 0);
  const widths = cols.map((c) => Math.round(c.width * scale));
  const cell = (c: string | { text: string; fill?: string; bold?: boolean }, w: number, header = false, zebra = false) => {
    const o2 = typeof c === 'string' ? { text: c } : c;
    const lines = o2.text.split('\n');
    return new TableCell({
      width: { size: w, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 90, right: 90 },
      shading: header ? { type: ShadingType.CLEAR, fill: NAVY, color: 'auto' } : o2.fill ? { type: ShadingType.CLEAR, fill: o2.fill, color: 'auto' } : zebra ? { type: ShadingType.CLEAR, fill: 'F7F9FB', color: 'auto' } : undefined,
      borders: { top: thin, bottom: thin, left: thin, right: thin },
      children: lines.map((ln) => new Paragraph({ children: [t(ln, { size, bold: header || o2.bold, color: header ? 'FFFFFF' : undefined })], spacing: { after: 30, line: 252 } })),
    });
  };
  if (rows.length === 0) return [p(o.empty ?? 'None.', { color: GREY, italics: true })];
  return [new Table({
    width: { size: total, type: WidthType.DXA }, columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: cols.map((c, i) => cell(c.header, widths[i]!, true)) }),
      ...rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, widths[i]!, false, ri % 2 === 1)) })),
    ],
  })];
}
const spacer = (after = 120) => new Paragraph({ children: [], spacing: { after } });

const scoreCell = (r: ControlResult) => ({ text: r.score === null ? r.scoreLabel : `${r.score} ${r.scoreLabel}`, fill: SCORE_FILL[r.score === null ? 'n' : String(r.score)], bold: true });
const dateLong = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const plural = (n: number, a: string, b = `${a}s`) => `${n} ${n === 1 ? a : b}`;

function basisText(r: ControlResult): string {
  const lines: string[] = [];
  const fails = r.signals.filter((s) => s.result === 'fail'); const passes = r.signals.filter((s) => s.result === 'pass'); const unclear = r.signals.filter((s) => s.result === 'unclear');
  if (fails.length) lines.push(`Problem found: ${fails[0]!.text}${fails.length > 1 ? ` (+${fails.length - 1} more)` : ''}`);
  if (passes.length) lines.push(`${plural(passes.length, 'check')} passed (${[...new Set(passes.map((s) => ({ design: 'design', discovered: 'cloud account', live: 'live', answer: 'team answer', platform: 'CloudBuilder records' }[s.basis])))].join(', ')})`);
  if (unclear.length) lines.push(`${plural(unclear.length, 'check')} could not be completed`);
  for (const e of r.evidence.slice(0, 3)) lines.push(`${e.id}: ${e.title} (${e.collectedAt}${e.origin === 'system' ? ', system export' : ''})`);
  if (r.evidence.length > 3) lines.push(`+${r.evidence.length - 3} more evidence`);
  if (r.note.trim()) lines.push(`Note: ${r.note.trim()}`);
  return lines.length ? lines.join('\n') : r.reasons[0] ?? '';
}

// ── sections ──────────────────────────────────────────────────────────────
function cover(r: ReadinessReport): Array<Paragraph | Table> {
  const cats = r.categories.map((c) => SOC2_CATEGORY_LABEL[c]).join(', ');
  const row = (k: string, v: string) => new TableRow({ children: [
    new TableCell({ width: { size: 2600, type: WidthType.DXA }, borders: { top: NONE, left: NONE, right: NONE, bottom: thin }, margins: { top: 90, bottom: 90, left: 0, right: 90 }, children: [p(k, { color: GREY, size: 19, after: 0 })] }),
    new TableCell({ width: { size: 7038, type: WidthType.DXA }, borders: { top: NONE, left: NONE, right: NONE, bottom: thin }, margins: { top: 90, bottom: 90, left: 90, right: 0 }, children: [p(v, { bold: true, size: 21, after: 0 })] }),
  ] });
  return [
    p('', { after: 1400 }),
    p('SOC 2 TYPE 1 READINESS', { bold: true, color: TEAL, size: 22, after: 80 }),
    p('SOC 2 Type 1 readiness report', { bold: true, color: NAVY, size: 56, after: 120 }),
    p(`${r.company}  |  ${r.system.name}`, { color: GREY, size: 28, after: 500 }),
    new Table({ width: { size: W_PORTRAIT, type: WidthType.DXA }, columnWidths: [2600, 7038], rows: [
      row('Control status as of', dateLong(r.asOf)), row('Trust services categories', cats), row('Version', `${r.version}  |  Draft for management and CPA review`), row('Report ID', r.reportId),
      row('Prepared by', r.preparedBy || TBD), row('Generated', `${dateLong(r.generatedAt)} with CloudBuilder (rule set ${r.rulesetVersion})`),
    ] }),
    p('', { after: 500 }),
    note('This is a readiness report that the company prepared with CloudBuilder. It is not a SOC 2 report, it gives no opinion on the company, and it does not say the company meets any standard. A SOC 2 report can only be issued by an independent CPA firm after its own examination. Use this report to find and fix gaps first, and to give the CPA firm a clear starting point.', 'FFF7E0'),
  ];
}

function howToRead(): Array<Paragraph | Table> {
  return [
    h2('How to read this report'),
    p('Every control gets a score from 0 to 4, and a confidence level. The score says how far the control is in place and shown to be working. The confidence says how much you can rely on that score.'),
    ...table(W_PORTRAIT, [{ header: 'Score', width: 1.3 }, { header: 'Meaning', width: 6 }], ([0, 1, 2, 3, 4] as Score[]).map((s) => [{ text: `${s}  ${SCORE_LABEL[s]}`, fill: SCORE_FILL[String(s)], bold: true }, SCORE_MEANING[s]])),
    spacer(80),
    p('Confidence is High when a check read the setting from the cloud account (or a system export and an independent review back it), Medium when there is dated evidence or a check on the design, and Low when it rests on a statement alone. "Not assessed" means nobody has answered for the control and no check applies; it is a gap in this report, not a pass.'),
  ];
}

function summarySection(r: ReadinessReport): Array<Paragraph | Table> {
  const s = r.summary;
  const meaning: Record<string, string> = {
    Ready: 'Every control in scope operates and no serious finding is open. Ask the CPA firm to begin.',
    'Ready with conditions': 'Every control is at least implemented, but some are not yet shown to operate, or findings are still open. Close the findings below before the CPA firm starts.',
    'Not ready': 'At least one control is missing, only informal, or has a serious open finding. Fix these first.',
    Incomplete: 'Some controls have not been assessed, so no conclusion can be drawn yet. Assign owners and answer for every control.',
  };
  const top = r.findings.filter((f) => f.status === 'open' || f.status === 'in_progress').slice(0, 5);
  return [
    h1('1. Summary'),
    new Table({ width: { size: W_PORTRAIT, type: WidthType.DXA }, columnWidths: [2400, 7238], rows: [new TableRow({ children: [
      new TableCell({ width: { size: 2400, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: READY_FILL[r.readiness], color: 'auto' }, margins: { top: 140, bottom: 140, left: 140, right: 140 }, borders: { top: NONE, bottom: NONE, left: NONE, right: NONE }, children: [p('Readiness', { size: 17, color: GREY, after: 20 }), p(r.readiness, { bold: true, size: 28, after: 0 })] }),
      new TableCell({ width: { size: 7238, type: WidthType.DXA }, margins: { top: 100, bottom: 100, left: 200, right: 100 }, borders: { top: NONE, bottom: NONE, left: NONE, right: NONE }, children: [p(meaning[r.readiness]!, { after: 0 })] }),
    ] })] }),
    spacer(160),
    h3('Controls by score'),
    ...table(W_PORTRAIT, [{ header: 'Result', width: 3 }, { header: 'Controls', width: 1 }], [
      ...([4, 3, 2, 1, 0] as Score[]).map((n) => [{ text: `${n}  ${SCORE_LABEL[n]}`, fill: SCORE_FILL[String(n)] }, String(s.byScore[n])]),
      [{ text: 'Not assessed', fill: SCORE_FILL.n }, String(s.notAssessed)], [{ text: 'Not applicable', fill: SCORE_FILL.n }, String(s.notApplicable)], [{ text: 'Total', bold: true }, { text: String(s.total), bold: true }],
    ]),
    spacer(80),
    p(`${s.coveragePct}% of the controls in scope have been assessed. The average score of the assessed controls is ${s.average ?? 'n/a'} out of 4.`),
    h3('What to fix first'),
    ...(top.length ? top.map((f) => bullet([t(`${f.id}  `, { bold: true }), t(`${f.severity}: ${f.title}. `), t(f.recommendation, { color: GREY })])) : [p('No open findings.', { color: GREY, italics: true })]),
    ...(r.findings.filter((f) => f.status === 'open' || f.status === 'in_progress').length > 5 ? [p(`The full list is in section 5.`, { color: GREY, size: 19 })] : []),
    h3('Before asking the CPA firm to start'),
    ...r.cpaChecks.filter((c) => !c.done).slice(0, 6).map((c) => bullet([t(`${c.label}. `, { bold: true }), t(c.detail, { color: GREY })])),
    ...(r.cpaChecks.every((c) => c.done) ? [p('Everything on the checklist in section 7 is done.', { color: GREY, italics: true })] : []),
  ];
}

function scopeSection(r: ReadinessReport): Array<Paragraph | Table> {
  const s = r.system;
  const cats = r.categories.map((c) => ({ id: c, label: SOC2_CATEGORY_LABEL[c], range: SOC2_CATEGORY_RANGE[c], n: r.defs.filter((d) => SOC2_CRITERIA_BY_ID.get(d.group)?.category === c).length }));
  const providers = s.providers.map((x) => (x === 'aws' ? 'Amazon Web Services' : 'Microsoft Azure'));
  return [
    h1('2. Scope and limits'),
    h2('2.1 The system'),
    ...table(W_PORTRAIT, [{ header: '', width: 2 }, { header: '', width: 6 }], [
      [{ text: 'System', bold: true }, `${s.name}${s.description ? `: ${s.description}` : ''}`], [{ text: 'Environment', bold: true }, s.environment || TBD],
      [{ text: 'Cloud providers', bold: true }, providers.join(' and ') || TBD], [{ text: 'Regions', bold: true }, s.regions.join(', ') || TBD],
      [{ text: 'Main components', bold: true }, s.services.join('; ') || TBD],
      [{ text: 'Third-party services', bold: true }, s.thirdParties.length ? s.thirdParties.map((x) => `${x.vendor} (${x.use})`).join('; ') : 'None drawn in the design'],
    ], {}),
    h2('2.2 What is assessed'),
    ...table(W_PORTRAIT, [{ header: 'Category', width: 3 }, { header: 'Criteria', width: 2.5 }, { header: 'Controls', width: 1.5 }], cats.map((c) => [c.label, c.range, String(c.n)])),
    ...(r.exclusions.length ? [spacer(80), h3('Not in scope'), ...table(W_PORTRAIT, [{ header: 'Category', width: 2 }, { header: 'Why', width: 6 }], r.exclusions.map((e) => [e.category, e.reason || TBD]))] : []),
    p('The criteria are the AICPA trust services criteria. The names and one-line meanings used here are written in plain words and are not the AICPA\'s text; the CPA firm works from the official criteria, so confirm every reference against them.', { color: GREY, size: 19, before: 120 }),
    h2('2.3 Limits of this report'),
    bullet('It is about one date. It describes whether controls were designed and in place on that date. It does not say they worked over a period (that is a SOC 2 Type 2 report).'),
    bullet('It rests on three kinds of information: checks CloudBuilder ran on the architecture design, checks that read the cloud account, and what the team answered and attached. It says which one stands behind each score.'),
    bullet('Anything not provided is listed in section 6 as a limitation. It is never assumed to exist.'),
    bullet('It is not an audit and gives no opinion. Nothing in it should be described as certification or compliance.'),
  ];
}

function domainSection(r: ReadinessReport): Array<Paragraph | Table> {
  return [
    h1('3. Results by area'),
    p('One row for each criterion. "Below 3" counts the controls that are not yet shown to operate.'),
    ...table(W_PORTRAIT, [{ header: 'Criterion', width: 4.2 }, { header: 'Controls', width: 1 }, { header: 'Average', width: 1 }, { header: 'Below 3', width: 1 }, { header: 'Not assessed', width: 1.2 }, { header: 'Confidence', width: 1.3 }],
      r.summary.groups.map((g) => {
        const c = SOC2_CRITERIA_BY_ID.get(g.group);
        return [`${g.group}  ${c?.name ?? ''}`, String(g.controls), { text: g.average === null ? 'n/a' : String(g.average), fill: g.average === null ? SCORE_FILL.n : SCORE_FILL[String(Math.min(4, Math.round(g.average)))] }, String(g.belowTarget), String(g.notAssessed), g.confidence];
      }), { size: 17 }),
  ];
}

function controlsSection(r: ReadinessReport): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [h1('4. Controls, one by one'), p('Each control belongs to one criterion. The last column says what would raise its score.')];
  const order = [...new Set(r.results.map((x) => x.group))];
  for (const g of order) {
    const c = SOC2_CRITERIA_BY_ID.get(g);
    out.push(h3(`${g}  ${c?.name ?? ''}`), p(c?.asks ?? '', { color: GREY, size: 19, after: 60 }));
    const rows = r.results.filter((x) => x.group === g).map((x) => {
      const d = r.defs.find((y) => y.id === x.id)!;
      return [{ text: `${x.id}\n${x.title}`, bold: false }, `${x.owner || 'No owner'}\n${d.ownerRole} role\n${d.frequency ?? ''}`, scoreCell(x), `${x.confidence}`, basisText(x), x.nextStep];
    });
    out.push(...table(W_LANDSCAPE, [{ header: 'Control', width: 3.4 }, { header: 'Owner and frequency', width: 2 }, { header: 'Score', width: 1.5 }, { header: 'Confidence', width: 1.1 }, { header: 'What supports it', width: 4.4 }, { header: 'To raise the score', width: 3 }], rows, { size: 16 }));
  }
  return out;
}

function findingsSection(r: ReadinessReport): Array<Paragraph | Table> {
  const rows = r.findings.map((f) => [
    { text: `${f.id}\n${f.severity}`, fill: SEV_FILL[f.severity], bold: true }, `${f.title}\n${f.group}`, `What we found: ${f.condition}\nWhy: ${f.cause}\nEffect: ${f.effect}`, f.recommendation,
    `${f.owner || 'No owner'}\n${f.targetDate ?? 'No date'}\n${{ open: 'Open', in_progress: 'In progress', closed: 'Closed', risk_accepted: 'Risk accepted' }[f.status]}`,
    f.managementResponse || `${TBD}${f.status === 'risk_accepted' && f.acceptedBy ? `\nAccepted by ${f.acceptedBy}` : ''}`,
  ]);
  return [
    h1('5. Findings and management response'),
    p('A finding is raised for every control that is missing, informal, only partly implemented, or has a failing check. A finding closes when the fix is retested, or when management accepts the risk in writing.'),
    ...table(W_LANDSCAPE, [{ header: 'Finding', width: 1.1 }, { header: 'Control', width: 2.6 }, { header: 'Detail', width: 5 }, { header: 'Recommendation', width: 3 }, { header: 'Owner, date, status', width: 1.8 }, { header: 'Management response', width: 2.6 }], rows, { size: 16, empty: 'No findings.' }),
  ];
}

function limitationsSection(r: ReadinessReport): Array<Paragraph | Table> {
  return [
    h1('6. Limitations'),
    p('Everything that was not provided, could not be checked, or limits a conclusion. A limitation stays open until the missing information is provided.'),
    ...table(W_LANDSCAPE, [{ header: 'ID', width: 0.8 }, { header: 'What is missing or limited', width: 6 }, { header: 'Effect on the report', width: 6 }], r.limitations.map((l) => [l.id, l.item, l.effect]), { size: 17, empty: 'No limitations recorded.' }),
  ];
}

function cpaSection(r: ReadinessReport): Array<Paragraph | Table> {
  const tick = (c: CpaCheck) => ({ text: c.done ? 'Done' : 'Open', fill: c.done ? SCORE_FILL[3] : SCORE_FILL[1], bold: true });
  const role = (k: 'preparer' | 'reviewer' | 'management', label: string) => {
    const s = r.signoffs.find((x) => x.role === k);
    return [label, s ? s.name : 'Not signed', s ? dateLong(s.signedAt) : ''];
  };
  return [
    h1('7. Ready for the CPA firm?'),
    p('The CPA firm decides what it relies on and does its own testing. This checklist shows what it will usually ask for first.'),
    ...table(W_PORTRAIT, [{ header: 'Check', width: 3.6 }, { header: 'State', width: 1 }, { header: 'Detail', width: 4 }], r.cpaChecks.map((c) => [c.label, tick(c), c.detail])),
    h2('Questions to settle with the CPA firm'),
    bullet('Which categories will the report cover, and is the cloud provider carved out or included as a subservice organization?'),
    bullet('What date should the Type 1 report be as of, and is evidence dated within a year of it acceptable?'),
    bullet('How will controls that rest on a statement alone be treated, and what evidence would you rather see?'),
    bullet('How should findings that are still open on the report date be described?'),
    h2('8. Sign-off'),
    p('Signing records a role. None of these signatures is an opinion. The independent reviewer must not operate any control in scope.'),
    ...table(W_PORTRAIT, [{ header: 'Role', width: 3 }, { header: 'Name', width: 3 }, { header: 'Date', width: 2 }], [
      role('preparer', `Prepared by (${r.preparedBy || 'company'})`), role('reviewer', 'Independent reviewer'), role('management', 'Management acknowledgement (CEO or CISO)'),
      ['Received by the CPA firm', '', ''],
    ]),
    h3('Document control'),
    ...table(W_PORTRAIT, [{ header: 'Version', width: 1 }, { header: 'Date', width: 1.5 }, { header: 'By', width: 2 }, { header: 'Change', width: 4 }], r.history.map((h) => [h.version, h.date, h.by, h.change])),
  ];
}

function appendices(r: ReadinessReport): Array<Paragraph | Table> {
  const s = r.system;
  const cats = r.categories.map((c) => SOC2_CATEGORY_LABEL[c]).join(', ');
  const matrix = r.defs.map((d) => [d.id, d.group, `${d.title}\n${d.activity ?? ''}`, d.ownerRole, d.frequency ?? '', d.evidence.join('\n'), r.results.find((x) => x.id === d.id)?.scoreLabel === 'Not applicable' ? 'Not applicable' : 'In scope']);
  const providers = s.providers.map((x) => (x === 'aws' ? 'Amazon Web Services' : 'Microsoft Azure'));
  const out: Array<Paragraph | Table> = [
    h1('Appendix A. Control matrix'),
    p('One row for each control. This is the list the CPA firm tests against. Edit the activity so that it matches what the company really does.'),
    ...table(W_LANDSCAPE, [{ header: 'Control', width: 0.9 }, { header: 'Criterion', width: 0.9 }, { header: 'What is done', width: 5 }, { header: 'Owner role', width: 1.4 }, { header: 'How often', width: 1.4 }, { header: 'Evidence to show', width: 3.4 }, { header: 'In scope', width: 1 }], matrix, { size: 15 }),
    h1('Appendix B. Evidence index'),
    p('Every piece of evidence attached to a control. The fingerprint (SHA-256) lets the CPA firm confirm a file is the one that was attached.'),
    ...table(W_LANDSCAPE, [{ header: 'Ref', width: 0.8 }, { header: 'Title', width: 4 }, { header: 'Kind', width: 0.9 }, { header: 'Source', width: 1.3 }, { header: 'Dated', width: 1.2 }, { header: 'Used for', width: 3 }, { header: 'Fingerprint', width: 2.4 }],
      r.evidenceIndex.map((e) => [e.ref, `${e.title}${e.fileName ? `\n${e.fileName}` : ''}`, e.kind, e.origin === 'system' ? 'System export' : 'Written by hand', e.collectedAt, e.controls.join(', '), e.sha256 ? e.sha256.slice(0, 16) : e.kind === 'link' ? 'Link' : '']), { size: 16, empty: 'No evidence has been attached yet.' }),
  ];
  // portrait appendices are added in the second block
  return out.concat([
    h1('Appendix C. Draft system description'),
    p('The CPA firm needs a description of the system, written by management. This outline fills in what CloudBuilder knows and marks the rest. It follows the usual headings; confirm them with the CPA firm.'),
    ...table(W_LANDSCAPE, [{ header: 'Heading', width: 3 }, { header: 'Draft', width: 8 }], [
      ['Services provided', s.description ? `${s.name}: ${s.description}` : `${TBD}: what the system does for customers.`],
      ['Commitments and requirements', `${TBD}: the service commitments made to customers (availability, security, confidentiality) and the requirements that follow.`],
      ['Infrastructure', providers.length ? `Hosted on ${providers.join(' and ')}${s.regions.length ? ` in ${s.regions.join(', ')}` : ''}. Components: ${s.services.join('; ') || 'none listed'}.` : TBD],
      ['Software', TBD], ['People', `${TBD}: the teams that operate the system and their roles (see the owners in Appendix A).`], ['Procedures', `${TBD}: the policies and procedures behind the controls in Appendix A.`],
      ['Data', `${TBD}: the kinds of customer and company data the system holds.`],
      ['System boundary', `${s.environment ? `The ${s.environment} environment. ` : ''}${TBD}: what is inside and outside the boundary.`],
      ['Criteria and controls', `${cats}. The controls are in Appendix A.`],
      ['Subservice organizations', [...providers.map((x) => `${x} (cloud hosting)`), ...s.thirdParties.map((x) => `${x.vendor} (${x.use})`)].join('; ') || TBD],
      ['Complementary controls', 'See Appendix E.'], ['Significant changes and incidents', `${TBD}: changes to the system and any incidents up to ${dateLong(r.asOf)}.`],
    ], { size: 17 }),
    h1('Appendix D. Draft management assertion'),
    p('Management writes and signs this. CloudBuilder does not sign it and does not say it is true. The wording below is a starting point; the CPA firm confirms the final text.'),
    note(`We, the management of ${r.company}, are responsible for designing, implementing and operating controls over ${s.name}. We confirm, to the best of our knowledge and belief, that as of ${dateLong(r.asOf)}: (1) the description of ${s.name} fairly presents the system as it was designed and implemented on that date; and (2) the controls described were suitably designed to meet the applicable trust services criteria (${cats}), if they operated as described and if subservice organizations and customers applied the complementary controls assumed in the description.`),
    p(`Signed: ${TBD}.   Name and title: ${TBD}.   Date: ${TBD}.`, { before: 160 }),
    h1('Appendix E. Complementary controls and subservice organizations'),
    h2('Subservice organizations'),
    ...table(W_LANDSCAPE, [{ header: 'Organization', width: 3 }, { header: 'What it provides', width: 4 }, { header: 'Treatment', width: 2.5 }, { header: 'Report reviewed', width: 3 }], [
      ...providers.map((x) => [x, 'Cloud hosting: physical security, environment, network and host infrastructure', 'Usually carved out: the CPA firm confirms', `${TBD}: the latest SOC 2 report and its date`]),
      ...s.thirdParties.map((x) => [x.vendor, `${x.use}. Data held: ${x.dataHeld || 'not stated'}`, TBD, TBD]),
    ], { size: 17, empty: 'None.' }),
    h2('Controls the company relies on from its providers'),
    ...['Physical access to data centres is controlled by the cloud provider.', 'Power, cooling and network connectivity of the data centres are the cloud provider\'s responsibility.', 'The underlying host and virtualization layer is secured and patched by the cloud provider.'].map(bullet),
    h2('Controls customers are expected to operate'),
    ...['Customers keep their own sign-in credentials secure and use a second factor where offered.', 'Customers review the access given to their own users and remove it when it is no longer needed.', 'Customers tell the company promptly about suspected security incidents affecting their data.', 'Customers configure the service as the documentation describes.'].map(bullet),
    p('These are suggestions: management confirms what applies and states it in the system description.', { color: GREY, size: 19 }),
    h1('Appendix F. How scores are decided'),
    ...([0, 1, 2, 3, 4] as Score[]).map((n) => bullet([t(`${n} ${SCORE_LABEL[n]}: `, { bold: true }), t(SCORE_MEANING[n])])),
    bullet([t('Evidence window: ', { bold: true }), t(`evidence counts as current if it is dated within ${EVIDENCE_WINDOW_DAYS} days before the report date and has not expired.`)]),
    bullet([t('Failing check: ', { bold: true }), t('a failing check keeps a control at 2 or below, whatever the owner says.')]),
    bullet([t('Independence: ', { bold: true }), t('a control reaches 4 only when someone other than its owner has reviewed it inside the window.')]),
    bullet([t('Not assessed: ', { bold: true }), t('a control nobody has answered for is not scored. It is listed as a limitation and keeps the report from being called ready.')]),
    ...(SOC2_CRITERIA.length ? [] : []),
  ]);
}


function periodAppendix(r: ReadinessReport): Array<Paragraph | Table> {
  const a = r.period;
  const out: Array<Paragraph | Table> = [
    h1('Appendix G. Operating over time (Type 2 preparation)'),
    p('A Type 1 report is about one date. A Type 2 report asks whether controls kept operating across a period. CloudBuilder takes dated snapshots of every control on a schedule, and this section shows what they say. It is preparation, not a Type 2 result: the CPA firm does its own testing of the period.'),
  ];
  if (!a) return [...out, p('No snapshots are available.', { color: GREY, italics: true })];
  const { rows, more } = periodRows(a, (id) => r.defs.find((d) => d.id === id)?.title ?? id);
  return [
    ...out, note(periodSentence(a)),
    ...(a.gaps.length ? [h3('Gaps in the record'), ...table(W_PORTRAIT, [{ header: 'From', width: 2 }, { header: 'To', width: 2 }, { header: 'Days', width: 1 }], a.gaps.slice(0, 20).map((g) => [g.from, g.to, String(g.days)]))] : []),
    h3('Controls that did not operate in every snapshot'),
    ...table(W_PORTRAIT, [{ header: 'Control', width: 1 }, { header: 'Title', width: 4 }, { header: 'Operating', width: 1.3 }, { header: 'Failing', width: 1 }, { header: 'Lowest', width: 1 }, { header: 'Latest', width: 1 }], rows, { empty: 'Every assessed control operated in every snapshot.' }),
    ...(more ? [p(`${more} more are not shown.`, { color: GREY, size: 19 })] : []),
  ];
}

const fmtHeader = (r: ReadinessReport) => new Header({ children: [new Paragraph({ spacing: { after: 0 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 4 } }, children: [t('SOC 2 Type 1 readiness report', { color: GREY, size: 17 }), t(`      ${r.company}`, { color: GREY, size: 17 })] })] });
const fmtFooter = (r: ReadinessReport) => new Footer({ children: [new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 0 }, children: [
  t(`CloudBuilder  |  ${r.reportId}  |  ${r.version}  |  Confidential: for management and the CPA firm  |  Page `, { color: GREY, size: 16 }),
  new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: GREY }), t(' of ', { color: GREY, size: 16 }), new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: GREY }),
] })] });

export async function renderSoc2Docx(r: ReadinessReport): Promise<Buffer> {
  const margins = { top: 1134, bottom: 1134, left: 1134, right: 1134 };
  const portrait = { page: { size: { width: 11906, height: 16838 }, margin: margins } };
  const landscape = { page: { size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE }, margin: margins } };
  const common = { headers: { default: fmtHeader(r) }, footers: { default: fmtFooter(r) } };
  const body = (children: Array<Paragraph | Table>, props: typeof portrait | typeof landscape): ISectionOptions => ({ properties: props, ...common, children });
  const doc = new Document({
    creator: 'CloudBuilder', title: `SOC 2 Type 1 readiness report: ${r.company}`, subject: `${r.system.name}, as of ${r.asOf}`, description: `Report ${r.reportId}`,
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }] },
    sections: [
      { properties: { ...portrait, titlePage: true }, children: cover(r), headers: { default: fmtHeader(r), first: new Header({ children: [] }) }, footers: { default: fmtFooter(r), first: new Footer({ children: [] }) } },
      body([...summarySection(r), ...howToRead(), ...scopeSection(r), ...domainSection(r)], portrait),
      body(controlsSection(r), landscape),
      body([...findingsSection(r), ...limitationsSection(r)], landscape),
      body(cpaSection(r), portrait),
      body(appendices(r), landscape),
      body(periodAppendix(r), portrait),
    ],
  });
  return Packer.toBuffer(doc);
}
