/** No report or readiness text may say a result is certified, attested, "SOC 2 compliant" or approved by a CPA: CloudBuilder is not an auditor. */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { FORBIDDEN_CLAIMS } from '@/lib/compliance/report';

const roots = ['lib/compliance', 'lib/services/report', 'lib/engines/assessment/report', 'components/panels/readiness', 'components/panels/ReadinessPanel.tsx'];
const files = (p: string): string[] => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => files(join(p, f))) : /\.(ts|tsx)$/.test(p) ? [p] : []);

describe('what the reports may claim', () => {
  const all = roots.flatMap((r) => files(join(process.cwd(), r)));
  it('scans a meaningful set of files', () => { expect(all.length).toBeGreaterThan(15); });
  it.each(all.map((f) => [f.replace(process.cwd() + '/', ''), f]))('%s makes no certification claim', (_n, f) => {
    // The definition of the pattern itself, and the negations ("is not certified"), are the only places these words may appear.
    const text = readFileSync(f as string, 'utf8').split('\n').filter((l) => !/FORBIDDEN_CLAIMS\s*=/.test(l) && !/\b(not|never|nor|no)\b[^.]{0,40}(certified|attested|compliant)/i.test(l));
    const hits = text.filter((l) => FORBIDDEN_CLAIMS.test(l));
    expect(hits).toEqual([]);
  });
});
