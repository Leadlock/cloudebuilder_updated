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
  it('follows the structure of the CPA-ready template: nine sections, then Appendices A to N, each in order', () => {
    const at = (s: string) => out.text.indexOf(s);
    const order = ['1. Executive Summary', 'Results at a glance', 'Principal findings', '2. Scope, Objectives and Limitations', '2.1 Objective', '2.2 System boundary', '2.3 Criteria assessed', '2.4 Limitations', '2.5 Significant changes during the period', '2.6 Limitations register',
      '3. Methodology and Scoring', '3.1 Steps performed for each control', '3.2 Scoring scale', '3.3 Evidence confidence', '3.4 Independence', '4. Results by Control Domain', '5. Control-Level Design Assessment', '5.2 Privacy criteria control detail',
      '6. Findings and Remediation', '6.2 Prior-period findings follow-up', '7. Management Response and Remediation Plan', '8. Readiness for CPA Review', '8.1 Consistency checks before the CPA firm begins', '8.2 Items the CPA firm will request', '8.3 Questions for the CPA firm', '9. Sign-off',
      'Appendix A. Control Matrix', 'Appendix B. Control Assessment Worksheet', 'Appendix C. Walkthrough Workpaper', 'Appendix D. Evidence Index', 'Appendix E. Finding Template', 'Appendix F. Gap Register and Remediation Tracker', 'F.1 Gap register', 'F.2 Remediation tracker', 'Appendix G. System Configuration',
      'Appendix H. Draft System Description Outline and Draft Management Assertion', 'H.1 System description outline', 'H.2 Draft management assertion', 'Appendix I. Complementary Controls Register', 'I.1 Complementary user entity controls (CUECs)', 'I.2 Complementary subservice organisation controls (CSOCs)',
      'Appendix J. Subservice Organisation Review', 'J.1 Provider summary', 'J.2 Complementary controls relied on, and gaps', 'J.3 Review conclusion', 'Appendix K. Bridge Letter Template', 'Appendix L. Management Representation Letter Template', 'Appendix M. Control Library (Type 1 starting set)', 'Appendix N. Operating over time (Type 2 preparation)'];
    const missing = order.filter((s) => at(s) < 0);
    expect(missing).toEqual([]);
    const positions = order.map(at);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
  it('states the verdict and the counts the data holds', () => {
    expect(out.text).toContain(report.readiness);
    expect(out.text).toContain(`${report.summary.coveragePct}% of the ${report.summary.total - report.summary.notApplicable} controls in scope have been assessed`);
    expect(out.text).toMatch(/Overall design readiness/);
    expect(out.text).toMatch(/Not assessed/);
  });
  it('shows results by category with the average, the not-assessed count and the open findings', () => {
    expect(out.text).toMatch(/Criteria in scope/);
    expect(out.text).toMatch(/Open findings/);
    expect(out.text).toMatch(/Security \(Common Criteria\)/);
  });
  it('runs the consistency checks and shows a result for each', () => {
    for (const c of ['Criteria agree', 'Architecture agrees', 'Counts agree', 'Evidence fingerprints', 'Terminology', 'Tests fit controls']) expect(out.text).toContain(c);
    expect(out.text).toMatch(/Not applicable/);
  });
  it('lists the configuration of the resources, with the source of each value and where the account differs', () => {
    expect(out.text).toContain('Storage encryption');
    expect(out.text).toContain('orders-db');
    expect(out.text).toMatch(/Discovered/);
    expect(out.text).toContain('1 day');
    expect(out.text).toMatch(/Values that could hold a secret are never shown/);
  });
  it('gives each evidence file its own full SHA-256', () => {
    const hashes = out.text.match(/\b[0-9a-f]{64}\b/g) ?? [];
    expect(hashes.length).toBeGreaterThan(5);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
  it('includes the letter templates, unsigned and marked for management', () => {
    expect(out.text).toMatch(/Bridge letter for \[gap start date\]/);
    expect(out.text).toMatch(/In connection with your examination of the description of Northwind Analytics Platform/);
    expect(out.text).toMatch(/CloudBuilder does not\./);
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
    expect(out.text).toMatch(/The report is reviewed by someone independent of the controls/);
  });
  it('never claims assurance: no "certified", "attested" or "SOC 2 compliant" anywhere', () => {
    expect(out.text).not.toMatch(FORBIDDEN_CLAIMS);
  });
  it('is the same file for the same input', async () => {
    const again = await textOf(await renderSoc2Docx(fixtureReport('soc2')));
    expect(again.text).toBe(out.text);
  });
  it('shows how the controls operated over time, as preparation and not as a Type 2 result', () => {
    expect(out.text).toContain('Appendix N. Operating over time (Type 2 preparation)');
    expect(out.text).toMatch(/snapshots were taken between 2026-07-28 and 2026-10-26/);
    expect(out.text).toMatch(/It is preparation, not a Type 2 result/);
    expect(out.text).toContain('Gaps in the record');
    expect(out.text).toContain('Controls that did not operate in every snapshot');
  });
});
