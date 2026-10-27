/**
 * The SOC 2 Type 1 readiness report as a PDF (server only), for reading and review. The Word version (renderSoc2Docx) is the one to edit and hand to the CPA firm;
 * this one carries the same content in the same order, so what is reviewed here is what is edited there. It shares its layout with the control reports.
 */
import { Page, K, P, CW, s, plural, longDate, glance, controls, addFooters, type Doc } from './renderControlPdf';
import { summarize } from './model';
import { SOC2_CATEGORY_LABEL, SOC2_CATEGORY_RANGE, SOC2_CRITERIA_BY_ID } from './soc2/criteria';
import { SCORE_LABEL, SCORE_MEANING, type Score } from './types';
import { EVIDENCE_WINDOW_DAYS } from './scoring';
import { periodRows, periodSentence } from './snapshots';
import type { ReadinessReport } from './report';

const TBD = '[to be completed by management]';
const STATUS = { open: 'Open', in_progress: 'In progress', closed: 'Closed', risk_accepted: 'Risk accepted' } as const;

function cover(p: Page, r: ReadinessReport) {
  const d = p.doc;
  d.rect(0, 0, P.w, 330).fillColor(K.navy).fill(); d.rect(0, 330, P.w, 5).fillColor(K.teal).fill();
  d.font('Helvetica-Bold').fontSize(9).fillColor('#9FC5E8').text('SOC 2 TYPE 1 READINESS', P.m, 120, { characterSpacing: 2 });
  d.font('Helvetica-Bold').fontSize(31).fillColor(K.white).text('SOC 2 Type 1 readiness report', P.m, 142, { width: CW });
  d.font('Helvetica').fontSize(15).fillColor('#D7E3F1').text(s(`${r.company}  |  ${r.system.name}`), P.m, d.y + 8, { width: CW });
  const facts: Array<[string, string]> = [['Control status as of', longDate(r.asOf)], ['Trust services categories', r.categories.map((c) => SOC2_CATEGORY_LABEL[c]).join(', ')], ['Version', `${r.version}  (draft for management and CPA review)`], ['Report ID', r.reportId], ['Prepared by', r.preparedBy || TBD], ['Generated', `${longDate(r.generatedAt)} with CloudBuilder`]];
  facts.forEach(([k, v], i) => {
    const x = P.m + (i % 2) * (CW / 2); const y = 372 + Math.floor(i / 2) * 50;
    d.font('Helvetica').fontSize(8).fillColor(K.muted).text(s(k.toUpperCase()), x, y, { characterSpacing: 1 });
    d.font('Helvetica-Bold').fontSize(12).fillColor(K.text).text(s(v), x, y + 13, { width: CW / 2 - 16 });
  });
  d.y = 560;
  p.box('This is a readiness report that the company prepared with CloudBuilder. It is not a SOC 2 report, it gives no opinion on the company, and it does not say the company meets any standard. A SOC 2 report can only be issued by an independent CPA firm after its own examination. Use this report to find and fix gaps first, and to give the CPA firm a clear starting point.', '#CA8A04', '#FFF7E0');
}

function scope(p: Page, r: ReadinessReport) {
  const sys = r.system; const providers = sys.providers.map((x) => (x === 'aws' ? 'Amazon Web Services' : 'Microsoft Azure'));
  p.h1('Scope and limits');
  p.h2('The system', 60);
  p.table([{ h: '', w: 2 }, { h: '', w: 6 }], [
    ['System', `${sys.name}${sys.description ? `: ${sys.description}` : ''}`], ['Environment', sys.environment || TBD], ['Cloud providers', providers.join(' and ') || TBD], ['Regions', sys.regions.join(', ') || TBD],
    ['Main components', sys.services.join('; ') || TBD], ['Third-party services', sys.thirdParties.length ? sys.thirdParties.map((x) => `${x.vendor} (${x.use})`).join('; ') : 'None drawn in the design'],
  ], { size: 9 });
  p.h2('What is assessed', 80);
  p.table([{ h: 'Category', w: 3 }, { h: 'Criteria', w: 2.5 }, { h: 'Controls', w: 1.5, align: 'right' }], r.categories.map((c) => [SOC2_CATEGORY_LABEL[c], SOC2_CATEGORY_RANGE[c], String(r.defs.filter((d) => SOC2_CRITERIA_BY_ID.get(d.group)?.category === c).length)]));
  if (r.exclusions.length) { p.h2('Not in scope', 60); p.table([{ h: 'Category', w: 2 }, { h: 'Why', w: 6 }], r.exclusions.map((e) => [e.category, e.reason || TBD])); }
  p.text('The criteria are the AICPA trust services criteria. The names and one-line meanings used here are written in plain words and are not the AICPA\'s text; the CPA firm works from the official criteria, so confirm every reference against them.', { size: 8.5, color: K.muted, after: 6 });
  p.h2('Limits of this report', 90);
  for (const l of ['It is about one date. It describes whether controls were designed and in place on that date. It does not say they worked over a period (that is a SOC 2 Type 2 report).', 'It rests on three kinds of information: checks CloudBuilder ran on the architecture design, checks that read the cloud account, and what the team answered and attached. It says which one stands behind each score.', 'Anything not provided is listed under Limitations. It is never assumed to exist.', 'It is not an audit and gives no opinion. Nothing in it should be described as certification or compliance.']) p.text(`- ${l}`, { after: 3 });
}

function findings(p: Page, r: ReadinessReport) {
  p.h1('Findings and management response');
  p.text('A finding is raised for every control that is missing, informal, only partly implemented, or has a failing check. A finding closes when the fix is retested, or when management accepts the risk in writing.', { color: K.muted, after: 8 });
  if (r.findings.length === 0) { p.text('No findings.', { color: K.muted }); return; }
  const d = p.doc;
  for (const f of r.findings) {
    p.ensure(120); const y = d.y;
    p.pill(f.severity.toUpperCase(), P.m, y, K.white, K.sev[f.severity]!);
    d.font('Helvetica-Bold').fontSize(8.5).fillColor(K.muted).text(s(`${f.id}   ${f.group}   |   ${STATUS[f.status]}`), P.m + 62, y + 3, { lineBreak: false });
    d.y = y + 17; p.text(f.title, { bold: true, size: 10, color: K.navy, after: 1 });
    p.text(`What we found: ${f.condition}`, { size: 9, after: 1 }); p.text(`Why: ${f.cause}  Effect: ${f.effect}`, { size: 9, color: K.muted, after: 1 });
    p.text(`What to do: ${f.recommendation}`, { size: 9, bold: true, after: 1 });
    p.text(`Owner: ${f.owner || 'none named'}   |   Target date: ${f.targetDate ?? 'none set'}`, { size: 8.5, color: K.muted, after: 1 });
    p.text(`Management response: ${f.managementResponse || TBD}${f.status === 'risk_accepted' && f.acceptedBy ? ` (risk accepted by ${f.acceptedBy})` : ''}`, { size: 9, after: 9 });
  }
}

function cpa(p: Page, r: ReadinessReport) {
  p.h1('Ready for the CPA firm?');
  p.text('The CPA firm decides what it relies on and does its own testing. This checklist shows what it will usually ask for first.', { color: K.muted, after: 6 });
  p.table([{ h: 'Check', w: 3.6 }, { h: 'State', w: 1 }, { h: 'Detail', w: 4 }], r.cpaChecks.map((c) => [c.label, c.done ? 'Done' : 'Open', c.detail]), { color: (row, i) => (i === 1 ? (row[1] === 'Done' ? K.score[3] : K.score[1]) : undefined) });
  p.h2('Questions to settle with the CPA firm', 100);
  for (const q of ['Which categories will the report cover, and is the cloud provider carved out or included as a subservice organization?', 'What date should the Type 1 report be as of, and is evidence dated within a year of it acceptable?', 'How will controls that rest on a statement alone be treated, and what evidence would you rather see?', 'How should findings that are still open on the report date be described?']) p.text(`- ${q}`, { after: 3 });
  p.h2('Sign-off', 120);
  p.text('Signing records a role. None of these signatures is an opinion. The independent reviewer must not operate any control in scope.', { color: K.muted, after: 4 });
  const sign = (k: 'preparer' | 'reviewer' | 'management', label: string) => { const x = r.signoffs.find((y) => y.role === k); return [label, x ? x.name : 'Not signed', x ? longDate(x.signedAt) : '']; };
  p.table([{ h: 'Role', w: 3 }, { h: 'Name', w: 3 }, { h: 'Date', w: 2 }], [sign('preparer', `Prepared by (${r.preparedBy || 'company'})`), sign('reviewer', 'Independent reviewer'), sign('management', 'Management acknowledgement (CEO or CISO)'), ['Received by the CPA firm', '', '']]);
  p.h2('Document control', 80);
  p.table([{ h: 'Version', w: 1 }, { h: 'Date', w: 1.5 }, { h: 'By', w: 2 }, { h: 'Change', w: 4 }], r.history.map((h) => [h.version, h.date, h.by, h.change]));
}

function appendices(p: Page, r: ReadinessReport) {
  const sys = r.system; const cats = r.categories.map((c) => SOC2_CATEGORY_LABEL[c]).join(', ');
  const providers = sys.providers.map((x) => (x === 'aws' ? 'Amazon Web Services' : 'Microsoft Azure'));
  p.h1('Appendix A. Control matrix');
  p.text('One row for each control. This is the list the CPA firm tests against. Edit the activity so that it matches what the company really does.', { color: K.muted, after: 6 });
  p.table([{ h: 'Control', w: 1 }, { h: 'Criterion', w: 1 }, { h: 'What is done', w: 5 }, { h: 'Owner role', w: 1.5 }, { h: 'How often', w: 1.4 }, { h: 'Evidence to show', w: 3 }], r.defs.map((d) => [d.id, d.group, `${d.title}. ${d.activity ?? ''}`, d.ownerRole, d.frequency ?? '', d.evidence.join('; ')]), { size: 7.2 });
  p.h1('Appendix B. Evidence index');
  p.text('Every piece of evidence attached to a control. The fingerprint (SHA-256) lets the CPA firm confirm a file is the one that was attached.', { color: K.muted, after: 6 });
  p.table([{ h: 'Ref', w: 0.8 }, { h: 'Title', w: 3.6 }, { h: 'Source', w: 1.3 }, { h: 'Dated', w: 1.2 }, { h: 'Used for', w: 2.4 }, { h: 'Fingerprint', w: 2 }], r.evidenceIndex.map((e) => [e.ref, `${e.title}${e.fileName ? ` (${e.fileName})` : ''}`, e.origin === 'system' ? 'System export' : 'By hand', e.collectedAt, e.controls.join(', '), e.sha256 ? e.sha256.slice(0, 16) : e.kind === 'link' ? 'Link' : '']), { size: 7.5, empty: 'No evidence has been attached yet.' });
  p.h1('Appendix C. Draft system description');
  p.text('The CPA firm needs a description of the system, written by management. This outline fills in what CloudBuilder knows and marks the rest. It follows the usual headings; confirm them with the CPA firm.', { color: K.muted, after: 6 });
  p.table([{ h: 'Heading', w: 2.4 }, { h: 'Draft', w: 6 }], [
    ['Services provided', sys.description ? `${sys.name}: ${sys.description}` : `${TBD}: what the system does for customers.`],
    ['Commitments and requirements', `${TBD}: the service commitments made to customers (availability, security, confidentiality) and the requirements that follow.`],
    ['Infrastructure', providers.length ? `Hosted on ${providers.join(' and ')}${sys.regions.length ? ` in ${sys.regions.join(', ')}` : ''}. Components: ${sys.services.join('; ') || 'none listed'}.` : TBD],
    ['Software', TBD], ['People', `${TBD}: the teams that operate the system and their roles (see the owners in Appendix A).`], ['Procedures', `${TBD}: the policies and procedures behind the controls in Appendix A.`],
    ['Data', `${TBD}: the kinds of customer and company data the system holds.`], ['System boundary', `${sys.environment ? `The ${sys.environment} environment. ` : ''}${TBD}: what is inside and outside the boundary.`],
    ['Criteria and controls', `${cats}. The controls are in Appendix A.`], ['Subservice organizations', [...providers.map((x) => `${x} (cloud hosting)`), ...sys.thirdParties.map((x) => `${x.vendor} (${x.use})`)].join('; ') || TBD],
    ['Complementary controls', 'See Appendix E.'], ['Significant changes and incidents', `${TBD}: changes to the system and any incidents up to ${longDate(r.asOf)}.`],
  ], { size: 8.5 });
  p.h1('Appendix D. Draft management assertion');
  p.text('Management writes and signs this. CloudBuilder does not sign it and does not say it is true. The wording below is a starting point; the CPA firm confirms the final text.', { color: K.muted, after: 6 });
  p.box(`We, the management of ${r.company}, are responsible for designing, implementing and operating controls over ${sys.name}. We confirm, to the best of our knowledge and belief, that as of ${longDate(r.asOf)}: (1) the description of ${sys.name} fairly presents the system as it was designed and implemented on that date; and (2) the controls described were suitably designed to meet the applicable trust services criteria (${cats}), if they operated as described. [The CPA firm confirms the final wording.]`);
  p.text(`Signed: ${TBD}.   Name and title: ${TBD}.   Date: ${TBD}.`, { after: 6 });
  p.h1('Appendix E. Complementary controls and subservice organizations');
  p.h2('Subservice organizations', 80);
  p.table([{ h: 'Organization', w: 2.4 }, { h: 'What it provides', w: 4 }, { h: 'Treatment', w: 2.4 }, { h: 'Report reviewed', w: 2.6 }], [
    ...providers.map((x) => [x, 'Cloud hosting: physical security, environment, network and host infrastructure', 'Usually carved out: the CPA firm confirms', `${TBD}: the latest SOC 2 report and its date`]),
    ...sys.thirdParties.map((x) => [x.vendor, `${x.use}. Data held: ${x.dataHeld || 'not stated'}`, TBD, TBD]),
  ], { size: 8.5, empty: 'None.' });
  p.h2('Controls the company relies on from its providers', 80);
  for (const l of ['Physical access to data centres is controlled by the cloud provider.', 'Power, cooling and network connectivity of the data centres are the cloud provider\'s responsibility.', 'The underlying host and virtualization layer is secured and patched by the cloud provider.']) p.text(`- ${l}`, { after: 2 });
  p.h2('Controls customers are expected to operate', 80);
  for (const l of ['Customers keep their own sign-in credentials secure and use a second factor where offered.', 'Customers review the access given to their own users and remove it when it is no longer needed.', 'Customers tell the company promptly about suspected security incidents affecting their data.', 'Customers configure the service as the documentation describes.']) p.text(`- ${l}`, { after: 2 });
  p.text('These are suggestions: management confirms what applies and states it in the system description.', { color: K.muted, size: 8.5, after: 4 });
  p.h1('Appendix F. How scores are decided');
  p.table([{ h: 'Score', w: 1.6 }, { h: 'Meaning', w: 6 }], ([0, 1, 2, 3, 4] as Score[]).map((n) => [`${n}  ${SCORE_LABEL[n]}`, SCORE_MEANING[n]]), { size: 8.5, color: (row, i) => (i === 0 ? K.score[Number(row[0]![0])] : undefined) });
  p.text(`Evidence counts as current if it is dated within ${EVIDENCE_WINDOW_DAYS} days before the report date and has not expired. A failing check keeps a control at 2 or below, whatever the owner says. A control reaches 4 only when someone other than its owner has reviewed it inside the window. A control nobody has answered for is not scored; it is listed as a limitation and keeps the report from being called ready.`, { size: 9, color: K.muted, after: 6 });
}


function periodAppendix(p: Page, r: ReadinessReport) {
  p.h1('Appendix G. Operating over time (Type 2 preparation)');
  p.text('A Type 1 report is about one date. A Type 2 report asks whether controls kept operating across a period. CloudBuilder takes dated snapshots of every control on a schedule, and this section shows what they say. It is preparation, not a Type 2 result: the CPA firm does its own testing of the period.', { color: K.muted, after: 6 });
  if (!r.period) { p.text('No snapshots are available.', { color: K.muted }); return; }
  const a = r.period;
  p.box(periodSentence(a));
  if (a.gaps.length) { p.h2('Gaps in the record', 70); p.table([{ h: 'From', w: 2 }, { h: 'To', w: 2 }, { h: 'Days', w: 1, align: 'right' }], a.gaps.slice(0, 20).map((g) => [g.from, g.to, String(g.days)])); }
  const { rows, more } = periodRows(a, (id) => r.defs.find((d) => d.id === id)?.title ?? id);
  p.h2('Controls that did not operate in every snapshot', 90);
  p.table([{ h: 'Control', w: 0.9 }, { h: 'Title', w: 4 }, { h: 'Operating', w: 1.3 }, { h: 'Failing', w: 1, align: 'right' }, { h: 'Lowest', w: 1, align: 'right' }, { h: 'Latest', w: 1, align: 'right' }], rows, { size: 8, empty: 'Every assessed control operated in every snapshot.' });
  if (more) p.text(`${more} more are not shown.`, { color: K.muted, size: 8.5 });
}

export async function renderSoc2Pdf(r: ReadinessReport): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc: Doc = new PDFDocument({ size: 'A4', margins: { top: P.top, bottom: P.bottom - 20, left: P.m, right: P.m }, bufferPages: true, info: { Title: `SOC 2 Type 1 readiness report: ${r.company}`, Author: 'CloudBuilder', Subject: `${r.system.name} as of ${r.asOf}`, Keywords: r.reportId } });
  const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const p = new Page(doc);
  // The summary groups the controls by trust services category rather than listing every criterion.
  const byCategory = summarize(r.results.map((x) => ({ ...x, group: SOC2_CATEGORY_LABEL[SOC2_CRITERIA_BY_ID.get(x.group)?.category ?? 'security'] })));
  cover(p, r); glance(p, r, { groupLabel: 'Category', summary: { ...r.summary, groups: byCategory.groups }, bars: false });
  const open = r.cpaChecks.filter((c) => !c.done).slice(0, 6);
  if (open.length) { p.h2('Before asking the CPA firm to start', 100); open.forEach((c) => p.text(`- ${c.label}. ${c.detail}`, { size: 9, after: 3 })); }
  scope(p, r);
  p.h1('Controls, one by one');
  p.text(`${plural(r.results.length, 'control')}${r.summary.notApplicable ? ` (${r.summary.notApplicable} marked not applicable)` : ''}, grouped by criterion. The coloured bar and label show the score; the lines under it show what the score rests on.`, { color: K.muted, after: 4 });
  controls(p, r, { heading: false });
  findings(p, r);
  p.h1('Limitations');
  p.text('Everything that was not provided, could not be checked, or limits a conclusion. A limitation stays open until the missing information is provided.', { color: K.muted, after: 6 });
  p.table([{ h: 'ID', w: 0.8 }, { h: 'What is missing or limited', w: 5 }, { h: 'Effect on the report', w: 4 }], r.limitations.map((l) => [l.id, l.item, l.effect]), { size: 8, empty: 'No limitations recorded.' });
  cpa(p, r); appendices(p, r); periodAppendix(p, r);
  addFooters(doc, r);
  doc.end();
  return done;
}
