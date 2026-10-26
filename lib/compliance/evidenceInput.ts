/** What an evidence request says, and how an evidence row is shown. Kept out of the route file (a Next.js route may only export its handlers). */
import { z } from 'zod';
import { defsFor } from './frameworks';
import { isFramework } from './rules';
import type { EvidenceRow } from '@/lib/repositories/readinessRepository';
import type { FrameworkId } from './types';

/** Which controls an evidence item is attached to, as "framework:controlId". */
export const controlKey = (framework: FrameworkId, controlId: string) => `${framework}:${controlId}`;
export function evidenceControls(row: Pick<EvidenceRow, 'controlsJson'>, framework?: FrameworkId): string[] {
  let all: string[] = [];
  try { const v = JSON.parse(row.controlsJson); if (Array.isArray(v)) all = v.filter((x): x is string => typeof x === 'string'); } catch { /* treated as none */ }
  return framework ? all.filter((k) => k.startsWith(`${framework}:`)).map((k) => k.slice(framework.length + 1)) : all;
}

export const EvidenceMetaSchema = z.object({
  kind: z.enum(['file', 'link', 'note']),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(2000).default(''),
  origin: z.enum(['system', 'manual']).default('manual'),
  collectedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date the evidence was produced, as YYYY-MM-DD'),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  url: z.string().trim().url().max(500).optional(),
  /** "soc2:CTL-01" style keys. */
  controls: z.array(z.string().max(40)).max(60).default([]),
});

/** Controls must exist; the link is refused (not silently dropped) otherwise. */
export function checkControlKeys(keys: string[]): string | null {
  for (const k of keys) {
    const [fw, id] = k.split(':');
    if (!fw || !id || !isFramework(fw) || !defsFor(fw).some((d) => d.id === id)) return `"${k}" is not a control of a known framework.`;
  }
  return null;
}

export function present(r: EvidenceRow) {
  const { controlsJson: _c, ...rest } = r;
  return { ...rest, controls: evidenceControls(r) };
}

