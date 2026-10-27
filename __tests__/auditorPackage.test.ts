import JSZip from 'jszip';
import { createHash } from 'crypto';
import { buildAuditorPackage, csv } from '@/lib/compliance/auditorPackage';
import { fixtureReport } from './helpers/complianceFixture';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('csv', () => {
  it('quotes, doubles quotes, and neutralises formulas', () => {
    expect(csv([['a,b', 'say "hi"', '=SUM(A1)', '+1', '-1', '@x', 'plain', null, 3]])).toBe('"a,b","say ""hi""",\'=SUM(A1),\'+1,\'-1,\'@x,plain,,3\r\n');
    expect(csv([['line\nbreak']])).toBe('"line\nbreak"\r\n');
  });
});

describe('the auditor package', () => {
  const report = fixtureReport('soc2');
  const files = report.evidenceIndex.filter((e) => e.kind === 'file');
  const content = (id: string) => Buffer.from(`content of ${id}`);
  // Make the recorded fingerprints honest for all but one file, so the check has something to find.
  files.forEach((e, n) => { e.sha256 = n === 0 ? 'f'.repeat(64) : sha(content(e.id)); });
  const input = () => ({
    report, files: [{ name: 'report.docx', bytes: Buffer.from('PKdocx') }, { name: 'report.pdf', bytes: Buffer.from('%PDF-x') }],
    evidence: files.map((e, n) => ({ id: e.id, bytes: n === 1 ? null : content(e.id) })),
    evidenceDetail: { [report.evidenceIndex.find((e) => e.kind === 'link')?.id ?? 'x']: { description: 'd', url: 'https://example.com/policy' } },
    snapshots: [{ id: 's1', takenAt: '2026-10-19T06:00:00.000Z', trigger: 'scheduled' as const, readiness: 'Not ready', controls: [{ id: 'CTL-01', score: 3, confidence: 'High', failing: [], evidence: 1 }, { id: 'CTL-02', score: 1, confidence: 'Low', failing: ['AWS-X-1'], evidence: 0 }] }],
    generatedAt: new Date('2026-10-27T10:00:00Z'),
  });

  it('holds the report, the matrices, the evidence, the history and a manifest', async () => {
    const { bytes } = await buildAuditorPackage(input());
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);
    for (const n of ['README.txt', 'manifest.json', 'controls.csv', 'findings.csv', 'evidence-index.csv', 'signoffs.csv', 'snapshots.csv', 'report/report.docx', 'report/report.pdf']) expect(names).toContain(n);
    expect(names.filter((n) => n.startsWith('evidence/')).length).toBeGreaterThan(3);
    const controls = (await zip.file('controls.csv')!.async('string')).trim().split('\r\n');
    expect(controls).toHaveLength(report.results.length + 1);
    expect(await zip.file('snapshots.csv')!.async('string')).toContain('2026-10-19T06:00:00.000Z,scheduled,Not ready,2,1,1');
  });

  it('re-checks every evidence file against the fingerprint on record and says so when one does not match or is missing', async () => {
    const { bytes, mismatches } = await buildAuditorPackage(input());
    expect(mismatches.length).toBe(2);
    expect(mismatches.join(' ')).toMatch(/does not match/);
    expect(mismatches.join(' ')).toMatch(/could not be read/);
    const zip = await JSZip.loadAsync(bytes);
    const idx = await zip.file('evidence-index.csv')!.async('string');
    expect(idx).toContain('MISMATCH'); expect(idx).toContain('FILE MISSING'); expect(idx).toContain('Matches');
    expect(await zip.file('README.txt')!.async('string')).toMatch(/ATTENTION: 2 evidence items have a problem/);
  });

  it('the manifest lists the SHA-256 of every other file, and they are right', async () => {
    const { bytes } = await buildAuditorPackage(input());
    const zip = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { files: Array<{ path: string; sha256: string; bytes: number }> };
    expect(manifest.files.length).toBe(Object.values(zip.files).filter((f) => !f.dir).length - 1);
    for (const f of manifest.files) { const data = await zip.file(f.path)!.async('nodebuffer'); expect(sha(data)).toBe(f.sha256); expect(data.length).toBe(f.bytes); }
  });

  it('never calls itself a SOC 2 report', async () => {
    const { bytes } = await buildAuditorPackage(input());
    const readme = await (await JSZip.loadAsync(bytes)).file('README.txt')!.async('string');
    expect(readme).toMatch(/not a SOC 2 report, an audit or an opinion/);
  });
});
