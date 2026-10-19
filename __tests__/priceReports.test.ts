/**
 * "This price looks wrong" reports: stored one per line in a file that survives a restart, newest first, with a clean short note.
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { addPriceReport, listPriceReports, cleanNote, type NewPriceReport } from '@/lib/cost/quality/priceReports';

const base: NewPriceReport = {
  orgId: 'org-1', projectId: 'p-1', userId: 'u-1', resourceId: 'r-1', resourceType: 'azure_redis', provider: 'azure', region: 'eastus',
  monthlyUsd: 328.5, pricingTier: 'LIVE', pricingSource: 'azure-retail-api-ai-matched', assumptions: ['meter A', 'meter A'], note: 'double',
};

describe('price reports', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'price-reports-'));
    file = path.join(dir, 'reports.jsonl');
    process.env['CLOUDBUILDER_PRICE_REPORTS_FILE'] = file;
  });
  afterEach(() => {
    delete process.env['CLOUDBUILDER_PRICE_REPORTS_FILE'];
    rmSync(dir, { recursive: true, force: true });
  });

  test('a report is kept with an id and time, and read back newest first', async () => {
    const first = await addPriceReport({ ...base, note: 'first' });
    const second = await addPriceReport({ ...base, note: 'second' });
    expect(first.id).not.toBe(second.id);
    const all = await listPriceReports();
    expect(all.map((r) => r.note)).toEqual(['second', 'first']);
    expect(all[0]).toMatchObject({ orgId: 'org-1', projectId: 'p-1', resourceType: 'azure_redis', monthlyUsd: 328.5 });
    expect(Number.isFinite(Date.parse(all[0]!.at))).toBe(true);
  });

  test('a note is one short line of plain text', () => {
    expect(cleanNote('  too\n\nmuch\t\tspace  ')).toBe('too much space');
    expect(cleanNote('x'.repeat(900))).toHaveLength(500);
  });

  test('assumptions are limited in number and length', async () => {
    const r = await addPriceReport({ ...base, assumptions: Array.from({ length: 30 }, () => 'y'.repeat(900)) });
    expect(r.assumptions).toHaveLength(12);
    expect(r.assumptions[0]).toHaveLength(300);
  });

  test('no reports yet is an empty list, and a damaged line is skipped', async () => {
    expect(await listPriceReports()).toEqual([]);
    writeFileSync(file, 'not json\n');
    await addPriceReport({ ...base, note: 'ok' });
    appendFileSync(file, '{broken\n');
    expect((await listPriceReports()).map((r) => r.note)).toEqual(['ok']);
  });
});
