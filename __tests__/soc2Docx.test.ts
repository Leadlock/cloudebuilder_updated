/** The SOC 2 Word report: a valid .docx whose text says what the data says, in the order a reader needs it, with no claim of assurance. */
import JSZip from 'jszip';
import { renderSoc2Docx } from '@/lib/compliance/renderSoc2Docx';
import { FORBIDDEN_CLAIMS } from '@/lib/compliance/report';
import { fixtureReport } from './helpers/complianceFixture';

async function textOf(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const doc = await zip.file('word/document.xml')!.async('string');
  const paras = [...doc.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join(''));
  return { zip, doc, text: paras.join('\n').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'), tables: (doc.match(/<w:tbl>/g) ?? []).length };
}

describe('the SOC 2 Word report', () => {
  const report = fixtureReport('soc2');
  let out: Awaited<ReturnType<typeof textOf>>; let size = 0;
  beforeAll(async () => { const buf = await renderSoc2Docx(report); size = buf.length; out = await textOf(buf); });

  it('is a real .docx package with the document, styles and numbering parts', () => {
    expect(size).toBeGreaterThan(20_000);
    for (const f of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'docProps/core.xml']) expect(out.zip.file(f)).not.toBeNull();
    expect(out.tables).toBeGreaterThan(20);
  });
  it('opens with the title, the company, the date and what kind of report it is', () => {
    expect(out.text).toMatch(/SOC 2 Type 1 readiness report/);
    expect(out.text).toContain('Northwind Data Ltd');
    expect(out.text).toContain('26 October 2026');
    expect(out.text).toContain(report.reportId);
    expect(out.text).toMatch(/It is not a SOC 2 report, it gives no opinion/);
    expect(out.text).toMatch(/Security, Availability/);
  });
  it('has the sections in a reader\'s order: summary, scope, areas, controls, findings, limitations, CPA checklist, sign-off, then the appendices', () => {
    const at = (s: string) => out.text.indexOf(s);
    const order = ['1. Summary', 'How to read this report', '2. Scope and limits', '3. Results by area', '4. Controls, one by one', '5. Findings and management response', '6. Limitations', '7. Ready for the CPA firm?', '8. Sign-off', 'Appendix A. Control matrix', 'Appendix B. Evidence index', 'Appendix C. Draft system description', 'Appendix D. Draft management assertion', 'Appendix E. Complementary controls and subservice organizations', 'Appendix F. How scores are decided'];
    const positions = order.map(at);
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
  it('states the verdict and the counts the data holds', () => {
    expect(out.text).toContain(report.readiness);
    expect(out.text).toContain(`${report.summary.coveragePct}% of the controls in scope have been assessed`);
    expect(out.text).toMatch(/Not assessed/);
  });
  it('lists every control in scope, with its owner role, and names the sources behind a score', () => {
    for (const d of report.defs) expect(out.text).toContain(d.id);
    expect(out.text).toMatch(/Problem found: RDS storage encryption is disabled on orders-db/);
    expect(out.text).toMatch(/EV-\d{3}: Evidence for CTL-/);
    expect(out.text).toContain('Priya Nair');
  });
  it('carries the management response the team wrote, and leaves what only management can say marked', () => {
    expect(out.text).toContain('Encryption will be switched on during the November maintenance window.');
    expect(out.text).toContain('To be completed by management');
  });
  it('lists the scope exclusion with its reason, the third-party services and the providers', () => {
    expect(out.text).toContain('The service holds no data its customers classify as confidential.');
    expect(out.text).toMatch(/Datadog \(Monitoring\)/);
    expect(out.text).toMatch(/Amazon Web Services and Microsoft Azure/);
    expect(out.text).toContain('Auth0');
  });
  it('shows who signed and who has not', () => {
    expect(out.text).toMatch(/Prepared by \(Priya Nair \(Security lead\)\)/);
    expect(out.text).toContain('Not signed');
    expect(out.text).toMatch(/Reviewed by someone independent of the controls/);
  });
  it('never claims assurance: no "certified", "attested" or "SOC 2 compliant" anywhere', () => {
    expect(out.text).not.toMatch(FORBIDDEN_CLAIMS);
  });
  it('is the same file for the same input', async () => {
    const again = await textOf(await renderSoc2Docx(fixtureReport('soc2')));
    expect(again.text).toBe(out.text);
  });
});
