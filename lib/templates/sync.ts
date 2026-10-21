/** Writes the built-in templates (the code) to the database: new ones added, changed ones updated, ones no longer in the code removed. Safe to run any number of times. */
import { architectureTemplates } from '@/lib/templates';
import type { ArchitectureTemplate } from '@/types';
import { builtInRow } from './stored';
import type { PgTemplateStore } from './templateStore';

export interface SyncResult { added: number; updated: number; removed: number; unchanged: number }

export async function syncBuiltInTemplates(store: Pick<PgTemplateStore, 'builtInHashes' | 'upsertBuiltIn' | 'deleteBuiltInExcept'>, templates: ArchitectureTemplate[] = architectureTemplates): Promise<SyncResult> {
  const existing = await store.builtInHashes();
  const result: SyncResult = { added: 0, updated: 0, removed: 0, unchanged: 0 };
  const ids: string[] = [];
  for (const t of templates) {
    const row = builtInRow(t);
    ids.push(row.id);
    const had = existing.get(row.id);
    if (had === row.contentHash) { result.unchanged++; continue; }
    await store.upsertBuiltIn(row);
    if (had === undefined) result.added++; else result.updated++;
  }
  result.removed = await store.deleteBuiltInExcept(ids);
  return result;
}
