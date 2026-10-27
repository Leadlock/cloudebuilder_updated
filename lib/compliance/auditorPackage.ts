/**
 * The package for the auditor: one zip holding the report, the control matrix, the findings, every evidence file with its fingerprint checked again, the
 * sign-offs and the snapshot history, and a manifest of SHA-256 fingerprints so the auditor can confirm nothing changed after it left CloudBuilder.
 * Pure given its inputs (the caller reads evidence bytes), so it is tested without a database.
 */
import { createHash } from 'crypto';
import JSZip from 'jszip';
import type { ReadinessReport } from './report';
import type { SnapshotRecord } from './snapshots';
import { periodSentence } from './snapshots';

export interface PackageEvidenceFile { id: string; bytes: Buffer | null }
export interface PackageInput {
  report: ReadinessReport;
  /** The report in the formats it comes in, already rendered. */
  files: Array<{ name: string; bytes: Buffer }>;
  evidence: PackageEvidenceFile[];
  /** Full descriptions of note-type evidence and links, by evidence id. */
  evidenceDetail: Record<string, { description: string; url: string | null }>;
  snapshots: SnapshotRecord[];
  generatedAt: Date;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const safe = (s: string) => s.replace(/[^\w.\- ()]/g, '_').slice(0, 100) || 'file';

/** CSV that opens safely in a spreadsheet: quotes doubled, and a leading = + - @ neutralised so a cell cannot run as a formula. */
export function csv(rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

export async function buildAuditorPackage(i: PackageInput): Promise<{ bytes: Buffer; manifest: Array<{ path: string; sha256: string; bytes: number }>; mismatches: string[] }> {
  const r = i.report;
  const entries: Array<{ path: string; data: Buffer }> = [];
  const add = (path: string, data: Buffer | string) => entries.push({ path, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') });
  const mismatches: string[] = [];

  for (const f of i.files) add(`report/${safe(f.name)}`, f.bytes);

  add('controls.csv', csv([
    ['Control', 'Criterion or group', 'Title', 'What is done', 'Owner role', 'How often', 'Owner', 'Owner says', 'Score', 'Result', 'Confidence', 'Reviewed by', 'Reviewed on', 'Evidence', 'Failing checks', 'To raise the score'],
    ...r.results.map((x) => {
      const d = r.defs.find((y) => y.id === x.id);
      return [x.id, x.group, x.title, d?.activity ?? '', d?.ownerRole ?? '', d?.frequency ?? '', x.owner, x.status ?? 'not answered', x.score ?? '', x.scoreLabel, x.confidence, x.reviewer, x.reviewedAt?.slice(0, 10) ?? '', x.evidence.map((e) => e.id).join(' '), x.signals.filter((s) => s.result === 'fail').map((s) => `${s.ref}: ${s.text}`).join(' | '), x.nextStep];
    }),
  ]));

  add('findings.csv', csv([
    ['Finding', 'Control', 'Severity', 'Title', 'What we found', 'Why', 'Effect', 'Recommendation', 'Owner', 'Target date', 'Status', "Management's response", 'Risk accepted by', 'Re-tested by', 'Re-tested on'],
    ...r.findings.map((f) => [f.id, f.controlId, f.severity, f.title, f.condition, f.cause, f.effect, f.recommendation, f.owner, f.targetDate ?? '', f.status, f.managementResponse, f.acceptedBy, f.retestedBy, f.retestedAt?.slice(0, 10) ?? '']),
  ]));

  const evRows: Array<Array<string | number>> = [['Ref', 'Title', 'Kind', 'Source', 'Dated', 'Valid until', 'File', 'Fingerprint on record', 'Fingerprint of the file in this package', 'Check', 'Link', 'Controls', 'Added by']];
  for (const e of r.evidenceIndex) {
    const f = i.evidence.find((x) => x.id === e.id); const detail = i.evidenceDetail[e.id];
    let fileInPkg = ''; let check = 'Not a file';
    if (e.kind === 'file') {
      if (!f?.bytes) { check = 'FILE MISSING'; mismatches.push(`${e.ref}: the stored file could not be read`); }
      else {
        const actual = sha(f.bytes); fileInPkg = actual;
        check = e.sha256 && e.sha256 === actual ? 'Matches' : 'MISMATCH';
        if (check === 'MISMATCH') mismatches.push(`${e.ref}: the file does not match the fingerprint recorded when it was added`);
        add(`evidence/${e.ref}_${safe(e.fileName ?? e.title)}`, f.bytes);
      }
    } else if (e.kind === 'note') add(`evidence/${e.ref}_${safe(e.title)}.txt`, `${e.title}\nDated ${e.collectedAt}${e.validUntil ? `, valid until ${e.validUntil}` : ''}\nAdded by ${e.uploadedBy ?? 'unknown'}\n\n${detail?.description ?? ''}\n`);
    evRows.push([e.ref, e.title, e.kind, e.origin === 'system' ? 'Exported from a system' : 'Collected or written by hand', e.collectedAt, e.validUntil ?? '', e.fileName ?? '', e.sha256 ?? '', fileInPkg, check, detail?.url ?? '', e.controls.join(' '), e.uploadedBy ?? '']);
  }
  add('evidence-index.csv', csv(evRows));

  add('signoffs.csv', csv([['Role', 'Name', 'Email', 'Signed at', 'Report id signed'], ...r.signoffs.map((s) => [s.role, s.name, s.email, s.signedAt, s.reportHash ?? ''])]));

  add('snapshots.csv', csv([
    ['Taken at', 'Taken by', 'Readiness', 'Controls scored', 'Operating (3 or more)', 'Controls with a failing check'],
    ...i.snapshots.map((s) => [s.takenAt, s.trigger, s.readiness, s.controls.filter((c) => c.score !== null).length, s.controls.filter((c) => (c.score ?? 0) >= 3).length, s.controls.filter((c) => c.failing.length > 0).length]),
  ]));

  add('README.txt', [
    `${r.title}: ${r.company}`, `${r.system.name}, control status as of ${r.asOf}. Report ${r.reportId} (${r.version}), package built ${i.generatedAt.toISOString()}.`, '',
    'This package was prepared with CloudBuilder. It supports an examination; it is not a SOC 2 report, an audit or an opinion.', '',
    'What is in it', '  report/             the readiness report', '  controls.csv        every control: owner, score, evidence, failing checks', '  findings.csv        findings with management\'s response',
    '  evidence/           every evidence file (and written notes), named by reference', '  evidence-index.csv  each item with its dated source and its fingerprint, re-checked when this package was built',
    '  signoffs.csv        who signed which role, and when', '  snapshots.csv       dated snapshots of the controls (evidence over time)', '  manifest.json       the SHA-256 of every file here', '',
    r.period ? `Over time: ${periodSentence(r.period)}` : 'Over time: no snapshots are available.', '',
    mismatches.length ? `ATTENTION: ${mismatches.length} evidence ${mismatches.length === 1 ? 'item has' : 'items have'} a problem:\n${mismatches.map((m) => `  - ${m}`).join('\n')}` : 'Every evidence file matches the fingerprint recorded when it was added.',
  ].join('\n'));

  const manifest = entries.map((e) => ({ path: e.path, sha256: sha(e.data), bytes: e.data.length }));
  add('manifest.json', JSON.stringify({ report: r.reportId, version: r.version, asOf: r.asOf, builtAt: i.generatedAt.toISOString(), files: manifest }, null, 2));

  const zip = new JSZip();
  // A fixed date makes the zip itself reproducible for the same contents.
  for (const e of entries) zip.file(e.path, e.data, { date: new Date(i.generatedAt) });
  return { bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }), manifest, mismatches };
}
