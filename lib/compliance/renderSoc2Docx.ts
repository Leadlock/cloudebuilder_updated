/**
 * The SOC 2 Type 1 readiness report as a Word document (server only). It is written to be read by a manager first and an auditor second: a one-page answer,
 * then the detail, then the appendices an auditor asks for. It is a readiness report prepared by the company: it gives no opinion and is never called a SOC 2 report.
 */
import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, LevelFormat, PageNumber, PageOrientation, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
  type ISectionOptions,
} from 'docx';
import { SCORE_LABEL, SCORE_MEANING, type ControlResult, type Score } from './types';
import { SOC2_CATEGORY_LABEL, SOC2_CATEGORY_RANGE, SOC2_CRITERIA_BY_ID } from './soc2/criteria';
import { periodRows, periodSentence } from './snapshots';
import { configSummary } from './configuration';
import { bridgeLetter, representationLetter } from './soc2Letters';
import { categoryRows, changeRows, conclusion, consistencyChecks, controlLibrary, cpaItems, criterionRows, csocRows, cuecRows, findingPlan, gapRegister, independence, limitationRegister, priorFindingRows, providerRows, remediationTracker, walkthroughOf, worksheetRows, TO_RECORD } from './soc2Extras';
import type { ReadinessReport } from './report';
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

type Block = Array<Paragraph | Table>;
const CHECK_FILL: Record<string, string> = { Pass: 'D8EFDD', Fail: 'F8D7DA', Note: 'FFF1B8', 'Not applicable': 'E7EAEE' };
const providersOf = (r: ReadinessReport) => r.system.providers.map((x) => (x === 'aws' ? 'Amazon Web Services' : 'Microsoft Azure'));
const openOf = (r: ReadinessReport) => r.findings.filter((f) => f.status === 'open' || f.status === 'in_progress');
const MEANING: Record<string, string> = {
  Ready: 'Every control in scope operates and no serious finding is open. Ask the CPA firm to begin.',
  'Ready with conditions': 'Every control is at least implemented, but some are not yet shown to operate, or findings are still open. Close the findings below before the CPA firm starts.',
  'Not ready': 'At least one control is missing, only informal, or has a serious open finding. Fix these first.',
  Incomplete: 'Some controls have not been assessed, so no conclusion can be drawn yet. Assign owners and answer for every control.',
};

// ── 1. Executive summary ──────────────────────────────────────────────────
function summarySection(r: ReadinessReport): Block {
  const s = r.summary; const top = openOf(r).slice(0, 5);
  return [
    h1('1. Executive Summary'),
    new Table({ width: { size: W_PORTRAIT, type: WidthType.DXA }, columnWidths: [2400, 7238], rows: [new TableRow({ children: [
      new TableCell({ width: { size: 2400, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: READY_FILL[r.readiness], color: 'auto' }, margins: { top: 140, bottom: 140, left: 140, right: 140 }, borders: { top: NONE, bottom: NONE, left: NONE, right: NONE }, children: [p('Overall design readiness', { size: 17, color: GREY, after: 20 }), p(r.readiness, { bold: true, size: 26, after: 0 })] }),
      new TableCell({ width: { size: 7238, type: WidthType.DXA }, margins: { top: 100, bottom: 100, left: 200, right: 100 }, borders: { top: NONE, bottom: NONE, left: NONE, right: NONE }, children: [p(`As of ${dateLong(r.asOf)}.`, { bold: true, after: 60 }), p(conclusion(r), { after: 0 })] }),
    ] })] }),
    spacer(120),
    h2('Results at a glance'),
    ...table(W_PORTRAIT, [{ header: 'Result', width: 2.2 }, { header: 'Meaning (readiness score)', width: 6 }, { header: 'Controls', width: 1.1 }], [
      ...([4, 3, 2, 1, 0] as Score[]).map((n) => [{ text: `${n}  ${SCORE_LABEL[n]}`, fill: SCORE_FILL[String(n)], bold: true }, SCORE_MEANING[n], String(s.byScore[n])]),
      [{ text: 'Not assessed', fill: SCORE_FILL.n, bold: true }, 'Nobody has assessed the control, so it is not scored. It keeps the report from being called ready.', String(s.notAssessed)],
      [{ text: 'Not applicable', fill: SCORE_FILL.n, bold: true }, 'Out of scope with a written reason.', String(s.notApplicable)],
      [{ text: 'Total', bold: true }, '', { text: String(s.total), bold: true }],
    ]),
    h2('Principal findings'),
    ...table(W_PORTRAIT, [{ header: 'Finding', width: 1 }, { header: 'Severity', width: 1 }, { header: 'Summary', width: 5 }, { header: 'Owner', width: 1.6 }, { header: 'Target date', width: 1.4 }],
      top.map((f) => [f.id, { text: f.severity, fill: SEV_FILL[f.severity], bold: true }, f.title, f.owner || 'No owner', f.targetDate ?? 'No date']), { empty: 'No open findings.' }),
    ...(openOf(r).length > 5 ? [p(`${openOf(r).length - 5} more are listed in section 6.`, { color: GREY, size: 19 })] : []),
    h2('Recommendation'),
    p(MEANING[r.readiness]!),
    ...cpaItems(r).filter((c) => c.state !== 'Done').slice(0, 6).map((c) => bullet([t(`${c.label}. `, { bold: true }), t(c.detail, { color: GREY })])),
  ];
}

// ── 2. Scope, objectives and limitations ──────────────────────────────────
function scopeSection(r: ReadinessReport): Block {
  const s = r.system; const cs = configSummary(r.configuration);
  const excluded = (['security', 'availability', 'confidentiality'] as const).filter((c) => !r.categories.includes(c));
  const catRows = (['security', 'availability', 'confidentiality'] as const).map((c) => {
    const inScope = r.categories.includes(c);
    const n = r.defs.filter((d) => SOC2_CRITERIA_BY_ID.get(d.group)?.category === c).length;
    return [SOC2_CATEGORY_LABEL[c] + (c === 'security' ? ' (Common Criteria)' : ''), SOC2_CATEGORY_RANGE[c], inScope ? `Yes (${n} controls)` : `No: ${r.exclusions.find((e) => e.category === SOC2_CATEGORY_LABEL[c])?.reason || TBD}`];
  });
  return [
    h1('2. Scope, Objectives and Limitations'),
    h2('2.1 Objective'),
    p(`To assess, as of ${dateLong(r.asOf)}, whether the controls of ${r.company} for ${s.name} are designed and in place, so that gaps can be fixed before an independent CPA firm begins a SOC 2 Type 1 examination, and so that the firm has a clear starting point. Type 1 is about the design of controls at one date. It does not say the controls worked over a period.`),
    h2('2.2 System boundary'),
    ...table(W_PORTRAIT, [{ header: '', width: 2 }, { header: '', width: 6 }], [
      [{ text: 'System', bold: true }, `${s.name}${s.description ? `: ${s.description}` : ''}`], [{ text: 'Environment', bold: true }, s.environment || TBD],
      [{ text: 'Cloud providers', bold: true }, providersOf(r).join(' and ') || TBD], [{ text: 'Regions', bold: true }, s.regions.join(', ') || TBD],
      [{ text: 'Main components', bold: true }, s.services.join('; ') || TBD],
      [{ text: 'Third-party services', bold: true }, s.thirdParties.length ? s.thirdParties.map((x) => `${x.vendor} (${x.use})`).join('; ') : 'None drawn in the design'],
      [{ text: 'Configuration examined', bold: true }, cs.settings ? `${cs.settings} settings on ${cs.resources} resources, ${cs.fromAccount} read from the cloud account. See Appendix G.` : 'No resource settings were examined.'],
    ]),
    h2('2.3 Criteria assessed'),
    ...table(W_PORTRAIT, [{ header: 'Category', width: 3 }, { header: 'Criteria', width: 2 }, { header: 'Included', width: 4 }], [
      ...catRows,
      ['Processing Integrity', 'PI1.1 to PI1.5', 'No: not assessed by CloudBuilder. The company and the CPA firm decide whether it is needed.'],
      ['Privacy', 'P1.0 to P8.1', 'No: not assessed by CloudBuilder. The company and the CPA firm decide whether it is needed.'],
    ]),
    ...(excluded.length ? [p('A category left out of scope is left out everywhere, with the same reason, and none of its controls is tested.', { color: GREY, size: 19 })] : []),
    p("The criteria are the AICPA trust services criteria. The names and one-line meanings used here are written in plain words and are not the AICPA's text; the CPA firm works from the official criteria, so confirm every reference against them.", { color: GREY, size: 19, before: 80 }),
    h2('2.4 Limitations'),
    bullet('This report is an internal readiness assessment. It is not an assurance report and it gives no opinion on the system.'),
    bullet('The external opinion is issued by an independent CPA firm after its own examination.'),
    bullet('Evidence was reviewed as provided by control owners. Items not provided are reported as limitations (section 2.6), never assumed to exist.'),
    bullet('Design conclusions relate only to the date stated. Later changes are outside this assessment.'),
    h2('2.5 Significant changes during the period'),
    p('Record every change to the system, its services, its providers, its people or its controls up to the assessment date, including changes the company did not treat as significant, so the CPA firm can judge that. Rows that begin "Architecture saved" come from the saved version history and have not been reviewed: confirm each one, or remove it from the log if it was not a change to the system.'),
    ...table(W_PORTRAIT, [{ header: 'Date', width: 1 }, { header: 'Change', width: 3 }, { header: 'Systems or processes affected', width: 2 }, { header: 'Criteria affected', width: 1.4 }, { header: 'Control impact', width: 1.6 }, { header: 'Reviewed by', width: 1.2 }], (() => { const rows = changeRows(r).map((c) => [c.date, c.change, c.systems, c.criteria, c.impact, c.reviewedBy]); return rows.length ? rows : [[TO_RECORD, '', '', '', '', '']]; })(), { size: 16 }),
    h2('2.6 Limitations register'),
    p('Every item that was not provided, could not be tested, or limits a conclusion. A limitation stays open until the evidence is provided or the conclusion is revised.'),
    ...table(W_PORTRAIT, [{ header: 'ID', width: 0.8 }, { header: 'Item not provided or not testable', width: 3 }, { header: 'Control', width: 1.2 }, { header: 'Effect on conclusion', width: 3 }, { header: 'Owner', width: 1.2 }, { header: 'Resolved', width: 1 }],
      limitationRegister(r).map((l) => [l.id, l.item, l.control, l.effect, l.owner, l.resolved]), { size: 16, empty: 'No limitations recorded.' }),
  ];
}

// ── 3. Methodology and scoring ────────────────────────────────────────────
function methodSection(r: ReadinessReport): Block {
  const ind = independence(r);
  return [
    h1('3. Methodology and Scoring'),
    h2('3.1 Steps performed for each control'),
    p('Confirm the control objective, owner, frequency and criteria mapping. Document the control activity well enough that someone else could repeat it. Inspect design and implementation: run the checks CloudBuilder can run on the architecture and on the cloud account, review the evidence attached, and record a walkthrough with the owner. Record the score, the confidence and what would raise the score. Have someone other than the owner review it.'),
    h2('3.2 Scoring scale'),
    ...table(W_PORTRAIT, [{ header: 'Score', width: 1.8 }, { header: 'Status', width: 1.4 }, { header: 'Required condition', width: 6 }], [
      ...([0, 1, 2, 3, 4] as Score[]).map((n) => [{ text: String(n), fill: SCORE_FILL[String(n)], bold: true }, SCORE_LABEL[n], SCORE_MEANING[n]]),
      [{ text: 'N/A', fill: SCORE_FILL.n, bold: true }, 'Not applicable', 'Out of scope with a written reason (at least 10 characters). Review it with the CPA firm.'],
    ]),
    spacer(60),
    p([t('Not assessed. ', { bold: true }), t('A control nobody has answered for is recorded as Not assessed. It is never shown as 0, 3 or 4. An in-scope control that is not assessed prevents an overall readiness conclusion.')]),
    p([t('Scoring caps. ', { bold: true }), t('A control whose check fails is capped at 2 until the check passes. A control resting only on the owner\'s statement is capped at 1. A score of 4 needs a live check or a system export and a review by someone who does not own the control.')]),
    h2('3.3 Evidence confidence'),
    ...table(W_PORTRAIT, [{ header: 'Level', width: 1.4 }, { header: 'Meaning', width: 7 }], [
      [{ text: 'High', bold: true }, 'A check read the setting from the cloud account, or a system export backs it, and an independent person reviewed it.'],
      [{ text: 'Medium', bold: true }, 'Evidence is credible but includes manual preparation, a check on the design only, or a single item.'],
      [{ text: 'Low', bold: true }, "Rests on the owner's word alone, or is incomplete, undated, or not reproducible."],
    ]),
    p(`Evidence date rule: evidence counts as current if it is dated no more than ${EVIDENCE_WINDOW_DAYS} days before the assessment date, is not expired, and shows the control as it stood. Older evidence is listed as a limitation and does not support a score.`, { before: 80 }),
    h2('3.4 Independence'),
    p('The reviewer of a control must not be its owner. CloudBuilder refuses a review by the owner, and the reviewer of the whole report cannot be the person who prepared it. A company that has CloudBuilder-assisted preparation does not sign off its own control design: the independent reviewer named in section 9 signs.'),
    ...table(W_PORTRAIT, [{ header: 'Assessed controls', width: 1.4 }, { header: 'Reviewed by someone else', width: 1.8 }, { header: 'Not yet reviewed', width: 1.4 }, { header: 'Reviewer is the owner', width: 1.6 }], [[String(ind.assessed), String(ind.independentlyReviewed), String(ind.notYetReviewed), ind.sameAsOwner.length ? ind.sameAsOwner.join(', ') : '0']]),
  ];
}

// ── 4. Results by control domain ──────────────────────────────────────────
function resultsSection(r: ReadinessReport): Block {
  const num = (v: number | null) => (v === null ? { text: 'n/a', fill: SCORE_FILL.n } : { text: String(v), fill: SCORE_FILL[String(Math.min(4, Math.round(v)))] });
  return [
    h1('4. Results by Control Domain'),
    p('Summary by trust services category, the grouping the CPA firm reads. Counts and averages exclude not-assessed and not-applicable controls.'),
    ...table(W_PORTRAIT, [{ header: 'Category', width: 2.2 }, { header: 'Criteria in scope', width: 1.3 }, { header: 'Controls', width: 1 }, { header: 'Average score', width: 1.2 }, { header: 'Not assessed', width: 1.2 }, { header: 'Open findings', width: 1.2 }],
      categoryRows(r).map((c) => [c.category, String(c.criteria), String(c.controls), num(c.average), String(c.notAssessed), String(c.openFindings)])),
    h3('Summary by criterion, for management use'),
    ...table(W_PORTRAIT, [{ header: 'Criterion', width: 3.4 }, { header: 'Controls', width: 0.9 }, { header: 'Average', width: 0.9 }, { header: 'Confidence', width: 1.1 }, { header: 'Key observation', width: 3.4 }],
      criterionRows(r).map((c) => [c.criterion, String(c.controls), num(c.average), c.confidence, c.observation]), { size: 16 }),
  ];
}

// ── 5. Control-level design assessment ────────────────────────────────────
function controlsSection(r: ReadinessReport): Block {
  const out: Block = [h1('5. Control-Level Design Assessment'), p('For each control: who owns it, how it scores, what supports the score, and what would raise it. Each control belongs to one criterion.')];
  for (const g of [...new Set(r.results.map((x) => x.group))]) {
    const c = SOC2_CRITERIA_BY_ID.get(g);
    out.push(h3(`${g}  ${c?.name ?? ''}`), p(c?.asks ?? '', { color: GREY, size: 19, after: 60 }));
    const rows = r.results.filter((x) => x.group === g).map((x) => {
      const d = r.defs.find((y) => y.id === x.id)!;
      const finding = r.findings.find((f) => f.controlId === x.id);
      return [`${x.id}\n${x.title}`, `${x.owner || 'No owner'}\n${d.ownerRole} role\n${d.frequency ?? ''}`, scoreCell(x), x.confidence, basisText(x), x.nextStep, finding ? finding.id : '—'];
    });
    out.push(...table(W_LANDSCAPE, [{ header: 'Control', width: 3.2 }, { header: 'Owner and frequency', width: 2 }, { header: 'Score', width: 1.4 }, { header: 'Confidence', width: 1 }, { header: 'What supports it', width: 4 }, { header: 'To raise the score', width: 3.6 }, { header: 'Finding', width: 1 }], rows, { size: 16 }));
  }
  out.push(h2('5.2 Privacy criteria control detail'), p('Privacy is not in scope of this report: CloudBuilder does not assess the privacy criteria. If the company and the CPA firm decide to include Privacy, record each criterion and its controls here, and confirm the references against the official criteria.', { color: GREY }));
  return out;
}

// ── 6. Findings and remediation, 7. Management response ───────────────────
function findingsSection(r: ReadinessReport): Block {
  const rows = r.findings.map((f) => [f.id, `${f.controlId}\n${f.group}`, { text: f.severity, fill: SEV_FILL[f.severity], bold: true }, f.condition, f.cause, f.effect, f.recommendation, ({ open: 'Open', in_progress: 'In progress', closed: 'Closed', risk_accepted: 'Risk accepted' })[f.status]]);
  return [
    h1('6. Findings and Remediation'),
    p('A finding is raised for every control that is missing, informal, only partly implemented, or has a failing check. Each records the condition, the criterion affected, the cause and effect, and a recommendation.'),
    ...table(W_LANDSCAPE, [{ header: 'Finding', width: 1 }, { header: 'Control and criterion', width: 1.4 }, { header: 'Severity', width: 1 }, { header: 'Condition', width: 3.4 }, { header: 'Cause', width: 2.2 }, { header: 'Effect', width: 2.6 }, { header: 'Recommendation', width: 2.6 }, { header: 'Status', width: 1 }], rows, { size: 15, empty: 'No findings.' }),
    h2('6.2 Prior-period findings follow-up'),
    p('List every finding from the previous internal or external report. Each one shows whether the fix was made, with evidence, and whether it was retested in the current period. A finding that recurs is raised again above. CloudBuilder does not hold earlier reports, so the team records them.'),
    ...table(W_LANDSCAPE, [{ header: 'Prior finding', width: 1.2 }, { header: 'Prior report and date', width: 1.6 }, { header: 'Original condition', width: 3 }, { header: 'Remediation action', width: 2.4 }, { header: 'Evidence of closure', width: 2 }, { header: 'Status this period', width: 1.4 }, { header: 'Retested by and date', width: 1.6 }], (() => { const rows = priorFindingRows(r); return rows.length ? rows : [[TO_RECORD, '', '', '', '', '', '']]; })(), { size: 16 }),
  ];
}

function responseSection(r: ReadinessReport): Block {
  const rows = r.findings.map((f) => { const plan = findingPlan(r, f.controlId); return [f.id, f.managementResponse || TBD, f.owner || 'No owner', plan.milestones, plan.acceptance, f.retestedAt ? `${f.retestedAt.slice(0, 10)}: ${f.status === 'closed' ? 'passed' : 'not closed'}` : 'Not retested']; });
  return [
    h1('7. Management Response and Remediation Plan'),
    p('Management responds to each finding. A finding is closed only after the corrective action is retested and the evidence is filed. Closing needs someone other than the finding\'s owner.'),
    ...table(W_LANDSCAPE, [{ header: 'Finding', width: 1 }, { header: 'Management response', width: 4 }, { header: 'Action owner', width: 1.6 }, { header: 'Milestones', width: 1.8 }, { header: 'Acceptance criteria', width: 2 }, { header: 'Retest date and result', width: 1.8 }], rows, { size: 16, empty: 'No findings to respond to.' }),
  ];
}

// ── 8. Readiness for CPA review, 9. Sign-off ──────────────────────────────
function cpaSection(r: ReadinessReport): Block {
  const checks = consistencyChecks(r);
  const tick = (s: string) => ({ text: s === 'Done' ? 'Done' : s === 'Open' ? 'Open' : 'Confirm', fill: s === 'Done' ? SCORE_FILL[3] : s === 'Open' ? SCORE_FILL[1] : SCORE_FILL[2], bold: true });
  return [
    h1('8. Readiness for CPA Review'),
    p('CloudBuilder prepares this report to help the CPA firm plan its own examination. The CPA firm decides what it relies on and performs its own testing. A check is marked Done only when the data shows it.'),
    h2('8.1 Consistency checks before the CPA firm begins'),
    ...table(W_PORTRAIT, [{ header: 'Check', width: 1.8 }, { header: 'What is compared', width: 2.8 }, { header: 'Result', width: 1 }, { header: 'Detail', width: 3.2 }], checks.map((c) => [{ text: c.check, bold: true }, c.compared, { text: c.result, fill: CHECK_FILL[c.result], bold: true }, c.detail]), { size: 16 }),
    h2('8.2 Items the CPA firm will request'),
    ...table(W_PORTRAIT, [{ header: 'Item', width: 4 }, { header: 'Where', width: 1.2 }, { header: 'State', width: 0.9 }, { header: 'Detail', width: 3.4 }], cpaItems(r).map((c) => [c.label, c.where, tick(c.state), c.detail]), { size: 16 }),
    h2('8.3 Questions for the CPA firm'),
    bullet('Which categories will the report cover, and is the cloud provider carved out or included as a subservice organisation?'),
    bullet('What date should the Type 1 report be as of, and is evidence dated within a year of it acceptable?'),
    bullet('How will controls that rest on a statement alone be treated, and what evidence would you rather see?'),
    bullet('How should findings that are still open on the report date be described?'),
    h1('9. Sign-off'),
    p('By signing, each person confirms the role stated. None of these signatures is an opinion of the CPA firm. The independent reviewer must not operate any control in scope.'),
    ...table(W_PORTRAIT, [{ header: 'Role', width: 3 }, { header: 'Name', width: 2.4 }, { header: 'Signature', width: 2 }, { header: 'Date', width: 1.4 }], (() => {
      const s = (k: 'preparer' | 'reviewer' | 'management') => r.signoffs.find((x) => x.role === k);
      const row = (k: 'preparer' | 'reviewer' | 'management', label: string) => [label, s(k)?.name ?? 'Not signed', s(k) ? 'Recorded in CloudBuilder' : '', s(k) ? dateLong(s(k)!.signedAt) : ''];
      return [row('preparer', `Prepared by (${r.preparedBy || 'company'})`), row('reviewer', 'Independent reviewer'), row('management', 'Management acknowledgement (CEO or CISO)'), ['Received by the CPA firm', '', '', '']];
    })()),
    h3('Document control'),
    ...table(W_PORTRAIT, [{ header: 'Version', width: 1 }, { header: 'Date', width: 1.5 }, { header: 'By', width: 2 }, { header: 'Change', width: 4 }], r.history.map((h) => [h.version, h.date, h.by, h.change])),
  ];
}

// ── Appendices ────────────────────────────────────────────────────────────
function appendixAtoJ(r: ReadinessReport): Block {
  const s = r.system; const providers = providersOf(r); const cats = r.categories.map((c) => SOC2_CATEGORY_LABEL[c]).join(', ');
  const cs = configSummary(r.configuration);
  const matrix = r.defs.map((d) => [d.id, d.group, `${d.title}\n${d.activity ?? ''}`, d.ownerRole, d.frequency ?? '', d.evidence.join('\n'), r.results.find((x) => x.id === d.id)?.scoreLabel === 'Not applicable' ? 'Not applicable' : 'In scope']);
  const gaps = gapRegister(r);
  const orgs = [...providers.map((x) => ({ name: x, what: 'Cloud hosting: physical security, environment, network and host infrastructure', kind: 'cloud' })), ...s.thirdParties.map((x) => ({ name: x.vendor, what: `${x.use}. Data held: ${x.dataHeld || 'not stated'}`, kind: 'third' }))];
  return [
    h1('Appendix A. Control Matrix'),
    p('One row for each control. This is the list the CPA firm tests against. Edit the activity so that it matches what the company really does.'),
    ...table(W_LANDSCAPE, [{ header: 'Control', width: 0.9 }, { header: 'Criterion', width: 0.9 }, { header: 'What is done', width: 5 }, { header: 'Owner role', width: 1.4 }, { header: 'How often', width: 1.4 }, { header: 'Evidence to show', width: 3.4 }, { header: 'In scope', width: 1 }], matrix, { size: 15 }),

    h1('Appendix B. Control Assessment Worksheet'),
    p('One row for each control, filled in with what CloudBuilder knows. The population source and the walkthrough are recorded by the team. Keep the worksheet with the control\'s evidence.'),
    ...table(W_LANDSCAPE, [{ header: 'Control and criterion', width: 2.2 }, { header: 'Objective and activity', width: 3.8 }, { header: 'Owner and frequency', width: 1.5 }, { header: 'Population source and walkthrough', width: 1.8 }, { header: 'Evidence', width: 1.2 }, { header: 'Score and confidence', width: 1.3 }, { header: 'Basis of score', width: 1.6 }, { header: 'Next step', width: 2.6 }, { header: 'Reviewer', width: 1.2 }],
      worksheetRows(r).map((w) => [w.control, `${w.objective}\n${w.activity}`, w.ownerFrequency, `${w.population}\n${w.walkthrough}`, w.evidence, w.score, w.basis, w.nextStep, w.reviewer]), { size: 14 }),

    h1('Appendix C. Walkthrough Workpaper'),
    p('One walkthrough per control: who was interviewed, what was observed, and which documents were inspected. A design conclusion needs the walkthrough and at least one design document. Walkthroughs are recorded in CloudBuilder by the team; a blank row has no walkthrough yet.'),
    ...table(W_LANDSCAPE, [{ header: 'Control', width: 1 }, { header: 'Walkthrough participant', width: 2 }, { header: 'Date', width: 1 }, { header: 'Documents inspected', width: 3 }, { header: 'What was observed', width: 3 }, { header: 'Design conclusion', width: 2.2 }, { header: 'Preparer and reviewer', width: 1.6 }],
      r.results.map((x) => { const w = walkthroughOf(r, x.id); return [x.id, w?.['participant'] ?? (x.owner || ''), w?.['date'] ?? '', w?.['documents'] ?? '', w?.['observed'] ?? '', w?.['conclusion'] ?? '', w ? `${w['preparer'] ?? ''}${w['reviewer'] ? ` / ${w['reviewer']}` : ''}` : '']; }), { size: 15 }),

    h1('Appendix D. Evidence Index'),
    p('Every piece of evidence attached to a control, with who added it, when it was produced, the period it covers and its full SHA-256 fingerprint. The CPA firm uses the fingerprint to confirm a file has not changed; two files never share one.'),
    ...table(W_LANDSCAPE, [{ header: 'Evidence', width: 0.8 }, { header: 'Control', width: 1.2 }, { header: 'Description', width: 3 }, { header: 'Source', width: 1.3 }, { header: 'Date generated', width: 1 }, { header: 'Period covered', width: 1.2 }, { header: 'Prepared by', width: 1.4 }, { header: 'Reviewed by', width: 1.1 }, { header: 'SHA-256 of the file as filed', width: 3.6 }],
      r.evidenceIndex.map((e) => [e.ref, e.controls.join(', '), `${e.title}${e.fileName ? `\n${e.fileName}` : ''}`, e.origin === 'system' ? 'System export' : 'By hand', e.collectedAt, e.validUntil ? `to ${e.validUntil}` : 'Point in time', e.uploadedBy ?? '', TO_RECORD, e.sha256 ?? (e.kind === 'link' ? 'Link, no file' : e.kind === 'note' ? 'Written note, no file' : 'none')]), { size: 13, empty: 'No evidence has been attached yet.' }),

    h1('Appendix E. Finding Template'),
    p('The fields recorded for every finding (section 6). Use this when a finding is raised outside CloudBuilder.'),
    ...table(W_PORTRAIT, [{ header: 'Field', width: 2.4 }, { header: 'Entry', width: 6 }], [['Finding ID', '[F-xxx]'], ['Control and criterion', '[CTL-xx, CCx.x]'], ['Severity', '[High / Medium / Low]'], ['Condition', '[What was found]'], ['Cause', '[Why it happened]'], ['Effect', '[What it weakens]'], ['Recommendation', '[What to do]'], ['Management response', '[What was done, or why the risk is accepted]'], ['Action owner and target date', '[Name; date]'], ['Milestones and acceptance criteria', '[Steps; what shows it is fixed]'], ['Retest evidence', '[Evidence ID; retested by; date; result]'], ['Status', '[Open / In progress / Closed / Risk accepted]']]),

    h1('Appendix F. Gap Register and Remediation Tracker'),
    p('Gaps found during readiness work and the remediation of each one. A gap closes only after retest evidence is filed. Keep closed items for the whole engagement.'),
    h2('F.1 Gap register'),
    ...table(W_LANDSCAPE, [{ header: 'Gap', width: 1.3 }, { header: 'Control', width: 0.9 }, { header: 'Criterion', width: 0.9 }, { header: 'Gap description', width: 5 }, { header: 'Owner', width: 1.5 }, { header: 'Target date', width: 1.1 }, { header: 'Status', width: 1.1 }], gaps.map((g) => [g.id, g.control, g.criterion, g.description, g.owner, g.target, g.status]), { size: 15, empty: 'No gaps.' }),
    h2('F.2 Remediation tracker'),
    ...table(W_LANDSCAPE, [{ header: 'Finding', width: 1 }, { header: 'Action', width: 4 }, { header: 'Owner', width: 1.5 }, { header: 'Evidence of closure', width: 2.4 }, { header: 'Retest date', width: 1.1 }, { header: 'Retest result', width: 1.4 }, { header: 'Closed by and date', width: 1.6 }], remediationTracker(r).map((x) => [x.id, x.action, x.owner, x.closure, x.retestDate, x.retestResult, x.closedBy]), { size: 15, empty: 'No findings.' }),

    h1('Appendix G. System Configuration'),
    p(cs.settings === 0 ? 'No resource settings were examined.' : `The settings of every resource that the assessment examined: ${cs.settings} settings on ${cs.resources} resources. "Design" means the value was set in CloudBuilder; "Discovered" was read from the cloud account; "Live" was verified through the provider. ${cs.failing} fail their check, ${cs.unclear} could not be decided, and ${cs.differing} differ between the design and the cloud account. Values that could hold a secret are never shown.`),
    ...table(W_LANDSCAPE, [{ header: 'Resource', width: 2 }, { header: 'Type', width: 1.6 }, { header: 'Region', width: 1.2 }, { header: 'Setting', width: 2.2 }, { header: 'Observed', width: 1.8 }, { header: 'Expected', width: 1.8 }, { header: 'Result', width: 0.9 }, { header: 'Source', width: 1.2 }, { header: 'Account holds', width: 1.4 }],
      r.configuration.map((c) => [`${c.resource}\n${c.provider}`, c.type, c.region, c.setting, c.observed, c.expected || '—', { text: c.result, fill: c.result === 'Pass' ? SCORE_FILL[3] : c.result === 'Fail' ? SCORE_FILL[0] : SCORE_FILL[2], bold: true }, `${c.source}${c.readAt ? `\n${c.readAt.slice(0, 10)}` : ''}`, c.accountValue ?? '']), { size: 14, empty: 'No resource settings were examined.' }),

    h1('Appendix H. Draft System Description Outline and Draft Management Assertion'),
    p('Drafts for management to write, review and sign. CloudBuilder does not author management\'s assertion or sign the system description. The CPA firm assesses both, and the final wording is agreed with the CPA firm.'),
    h2('H.1 System description outline'),
    ...table(W_LANDSCAPE, [{ header: 'Heading', width: 3 }, { header: 'Draft', width: 8 }], [
      ['Services provided', s.description ? `${s.name}: ${s.description}` : `${TBD}: what the system does for customers.`],
      ['Commitments and requirements', `${TBD}: the service commitments made to customers (availability, security, confidentiality) and the requirements that follow.`],
      ['Infrastructure', providers.length ? `Hosted on ${providers.join(' and ')}${s.regions.length ? ` in ${s.regions.join(', ')}` : ''}. Components: ${s.services.join('; ') || 'none listed'}. Settings are in Appendix G.` : TBD],
      ['Software', TBD], ['People', `${TBD}: the teams that operate the system and their roles (see the owners in Appendix A).`], ['Procedures', `${TBD}: the policies and procedures behind the controls in Appendix A.`],
      ['Data', `${TBD}: the kinds of customer and company data the system holds.`], ['System boundary', `${s.environment ? `The ${s.environment} environment. ` : ''}${TBD}: what is inside and outside the boundary.`],
      ['Criteria and controls', `${cats}. The controls are in Appendix A.`], ['Subservice organisations', orgs.map((o) => o.name).join('; ') || TBD],
      ['Complementary controls', 'See Appendix I.'], ['Significant changes and incidents', `${TBD}: changes to the system and any incidents up to ${dateLong(r.asOf)}.`],
    ], { size: 17 }),
    h2('H.2 Draft management assertion'),
    p('Management writes and signs this. CloudBuilder does not sign it and does not say it is true. The wording below is a starting point; the CPA firm confirms the final text.'),
    note(`We, the management of ${r.company}, are responsible for designing, implementing and operating controls over ${s.name}. We confirm, to the best of our knowledge and belief, that as of ${dateLong(r.asOf)}: (1) the description of ${s.name} fairly presents the system as it was designed and implemented on that date; and (2) the controls described were suitably designed to meet the applicable trust services criteria (${cats}), if they operated as described. [The CPA firm confirms the final wording.]`),
    p(`Signed: ${TBD}.   Name and title: ${TBD}.   Date: ${TBD}.`, { before: 160 }),

    h1('Appendix I. Complementary Controls Register'),
    p('Every control that the description assumes customers operate (CUECs), and every control that a provider must operate (CSOCs). The CPA firm checks each one against customer contracts and provider reports. Each needs a status of Confirmed or Gap; a gap closes only with evidence. The entries below are suggestions: management confirms what applies.'),
    h2('I.1 Complementary user entity controls (CUECs)'),
    ...table(W_LANDSCAPE, [{ header: 'ID', width: 0.8 }, { header: 'CUEC as stated in the description', width: 4.6 }, { header: 'Criteria', width: 1.1 }, { header: 'Where it appears in customer contracts', width: 2.2 }, { header: 'How it is communicated', width: 1.8 }, { header: 'Status', width: 1.2 }],
      cuecRows(r).map((x) => [x.id, x.statement, x.criteria, x.a, x.b, { text: `${x.status}${x.note ? `\n${x.note}` : ''}`, fill: x.status === 'Confirmed' ? SCORE_FILL[3] : x.status === 'Gap' ? SCORE_FILL[0] : SCORE_FILL[2], bold: true }]), { size: 16 }),
    h2('I.2 Complementary subservice organisation controls (CSOCs)'),
    ...table(W_LANDSCAPE, [{ header: 'ID', width: 0.8 }, { header: 'Provider and CSOC', width: 4.6 }, { header: 'Criteria', width: 1.1 }, { header: 'Provider report that covers it (period)', width: 2.2 }, { header: 'Our complementary control', width: 1.8 }, { header: 'Status', width: 1.2 }],
      csocRows(r).map((x) => [x.id, x.statement, x.criteria, x.a, x.b, { text: `${x.status}${x.note ? `\n${x.note}` : ''}`, fill: x.status === 'Confirmed' ? SCORE_FILL[3] : x.status === 'Gap' ? SCORE_FILL[0] : SCORE_FILL[2], bold: true }]), { size: 16, empty: 'No cloud provider in the design.' }),
    p('Confirm each criterion reference against the official criteria before use.', { color: GREY, size: 19 }),

    h1('Appendix J. Subservice Organisation Review'),
    p('The review of each subservice organisation that supports in-scope services. It supports vendor and business partner risk (CC9.2). Complete it for every provider, whether carved out or included.'),
    h2('J.1 Provider summary'),
    ...table(W_LANDSCAPE, [{ header: 'Provider and service', width: 3 }, { header: 'Carve-out or inclusive', width: 1.6 }, { header: 'Report type and period', width: 1.8 }, { header: 'Covers the audit period?', width: 1.4 }, { header: 'Bridge letter needed (dates)', width: 1.6 }, { header: 'Opinion and exceptions noted', width: 2 }, { header: 'Reviewed by and date', width: 1.5 }],
      providerRows(r).map((o) => [`${o.name}\n${o.what}`, o.treatment, o.report, o.covers, o.bridge, o.opinion, o.reviewed]), { size: 15, empty: 'No provider in the design.' }),
    h2('J.2 Complementary controls relied on, and gaps'),
    ...table(W_LANDSCAPE, [{ header: 'Provider', width: 2 }, { header: 'Control relied on', width: 3 }, { header: 'Our evidence it operates', width: 2.4 }, { header: 'Gap in the provider report', width: 2 }, { header: 'Compensating action', width: 2 }, { header: 'Status', width: 1 }],
      providerRows(r).map((o) => [o.name, o.relied, o.evidence, o.gap, o.compensating, o.recorded ? 'Reviewed' : 'Not reviewed']), { size: 15, empty: 'No provider in the design.' }),
    h2('J.3 Review conclusion'),
    p(r.team.conclusion ? `${r.team.conclusion.data['conclusion'] ?? ''}${r.team.conclusion.data['acceptedBy'] ? ` Residual risk accepted by ${r.team.conclusion.data['acceptedBy']}.` : ''}` : `[State whether the providers' controls are adequately covered for the criteria in scope, the gaps that remain, and who accepted the residual risk.] ${TBD}.`, { color: r.team.conclusion ? undefined : GREY }),
  ];
}

const letterBlock = (title: string, lines: string[]): Block => [h1(title), ...lines.map((ln) => (ln === '' ? spacer(60) : p(ln, { size: 21, after: 80 })))];
const lettersKL = (r: ReadinessReport): Block => [
  ...letterBlock('Appendix K. Bridge Letter Template', bridgeLetter(r)),
  ...letterBlock('Appendix L. Management Representation Letter Template', representationLetter(r)),
];

function appendixM(): Block {
  return [
    h1('Appendix M. Control Library (Type 1 starting set)'),
    p('A starting set of controls mapped to the criteria. Use it to build Appendix A. Adapt each activity to the company, record any criterion with no control as a gap, and do not add a control to Appendix A without an evidence source. This list is a starting point and does not replace the CPA firm\'s own review.'),
    ...table(W_LANDSCAPE, [{ header: 'Criterion', width: 2.6 }, { header: 'Control activity (starting point)', width: 6 }, { header: 'Typical owner', width: 1.6 }, { header: 'Typical evidence', width: 4 }], controlLibrary().map((x) => [x.criterion, x.activity, x.owner, x.evidence]), { size: 15 }),
  ];
}

function periodAppendix(r: ReadinessReport): Block {
  const a = r.period;
  const out: Block = [
    h1('Appendix N. Operating over time (Type 2 preparation)'),
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
      body([...summarySection(r), ...scopeSection(r), ...methodSection(r), ...resultsSection(r)], portrait),
      body([...controlsSection(r), ...findingsSection(r), ...responseSection(r)], landscape),
      body(cpaSection(r), portrait),
      body(appendixAtoJ(r), landscape),
      body(lettersKL(r), portrait),
      body(appendixM(), landscape),
      body(periodAppendix(r), portrait),
    ],
  });
  return Packer.toBuffer(doc);
}
