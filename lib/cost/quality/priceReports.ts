/**
 * "This price looks wrong" reports.
 *
 * A person who sees a number that does not fit can send the line with a note. Each report keeps what is needed to reproduce the problem (the
 * service, region, price, where the price came from, and the assumptions behind it) and nothing about the account: no credentials, no email.
 * Reports are appended to a file under .cloudcraft-data (override with CLOUDCRAFT_PRICE_REPORTS_FILE), one JSON object per line, so a report
 * can be turned into a reference test and survives a restart.
 */
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

export interface PriceReport {
  id: string;
  at: string;
  orgId: string;
  projectId: string;
  userId: string;
  resourceId: string;
  resourceType: string;
  provider: string;
  region: string;
  monthlyUsd: number;
  pricingTier: string | null;
  pricingSource: string | null;
  assumptions: string[];
  note: string;
}

export type NewPriceReport = Omit<PriceReport, 'id' | 'at'>;

const reportsFile = (): string => process.env['CLOUDCRAFT_PRICE_REPORTS_FILE'] || path.join(process.cwd(), '.cloudcraft-data', 'price-reports.jsonl');

/** Keeps a free-text note short and on one line of plain text. */
export function cleanNote(note: string): string {
  return note.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function addPriceReport(input: NewPriceReport): Promise<PriceReport> {
  const report: PriceReport = { ...input, note: cleanNote(input.note), assumptions: input.assumptions.slice(0, 12).map((a) => a.slice(0, 300)), id: randomUUID(), at: new Date().toISOString() };
  const file = reportsFile();
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(report)}\n`, 'utf8');
  return report;
}

/** Newest first. A damaged line is skipped, never fatal. */
export async function listPriceReports(limit = 100): Promise<PriceReport[]> {
  let text = '';
  try {
    text = await readFile(reportsFile(), 'utf8');
  } catch {
    return [];
  }
  const out: PriceReport[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as PriceReport); } catch { /* skip a damaged line */ }
  }
  return out.reverse().slice(0, limit);
}
