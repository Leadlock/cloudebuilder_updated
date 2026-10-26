import { renderControlPdf } from '@/lib/compliance/renderControlPdf';
import { fixtureReport } from './helpers/complianceFixture';

describe.each(['aws-waf', 'azure-waf'] as const)('control PDF (%s)', (fw) => {
  it('is a real multi-page PDF', async () => {
    const buf = await renderControlPdf(fixtureReport(fw));
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(10_000);
    expect((buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(3);
  });
});
