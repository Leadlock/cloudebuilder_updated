/**
 * ApiReadinessService: the browser's client for the readiness reports (SOC 2 Type 1 readiness, AWS and Azure control reports).
 * Every call names the project and framework; it throws an Error whose message is meant to be shown to the person.
 */
import type { ReadinessReport } from '@/lib/compliance/report';
import type { ControlStatus, FindingStatus, FrameworkId, Signoff } from '@/lib/compliance/types';
import type { Soc2Category } from '@/lib/compliance/soc2/criteria';

export interface ReadinessView {
  report: ReadinessReport;
  scope: { categories: Soc2Category[]; exclusions: Partial<Record<Soc2Category, string>> } | null;
  versions: Array<{ version: number; reportId: string; readiness: string; asOf: string; generatedBy: string; generatedAt: string }>;
  canAdminister: boolean;
}

export interface EvidenceItem {
  id: string; title: string; description: string; kind: 'file' | 'link' | 'note'; origin: 'system' | 'manual'; collectedAt: string; validUntil: string | null;
  url: string | null; fileName: string | null; sizeBytes: number | null; sha256: string | null; uploadedBy: string; createdAt: string; controls: string[];
}

export interface NewEvidence { kind: 'file' | 'link' | 'note'; title: string; description: string; origin: 'system' | 'manual'; collectedAt: string; validUntil?: string; url?: string; controls: string[]; file?: File }

const base = (projectId: string, framework: FrameworkId) => `/api/projects/${projectId}/readiness/${framework}`;
const q = (env: string) => `?env=${encodeURIComponent(env)}`;

async function send<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, { credentials: 'include', ...rest, headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...rest.headers }, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  const body = await res.json().catch(() => null) as { ok?: boolean; data?: T; error?: { message?: string } } | null;
  if (!res.ok || !body || body.ok === false) throw new Error(body?.error?.message ?? `The request failed (${res.status}).`);
  return body.data as T;
}

async function fileOf(res: Response, fallback: string): Promise<{ blob: Blob; filename: string }> {
  if (!res.ok) { const j = await res.json().catch(() => ({})) as { error?: { message?: string } }; throw new Error(j.error?.message ?? 'The file could not be made.'); }
  return { blob: await res.blob(), filename: /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallback };
}

export const apiReadinessService = {
  view: (projectId: string, framework: FrameworkId, env = 'production') => send<ReadinessView>(`${base(projectId, framework)}${q(env)}`),

  saveControl: (projectId: string, framework: FrameworkId, controlId: string, change: { status?: ControlStatus | null; owner?: string; note?: string; naReason?: string; markReviewed?: boolean }) =>
    send<{ saved: boolean }>(`${base(projectId, framework)}/controls/${encodeURIComponent(controlId)}`, { method: 'PUT', json: change }),

  saveFinding: (projectId: string, framework: FrameworkId, controlId: string, change: { owner?: string; targetDate?: string | null; status?: FindingStatus; managementResponse?: string }) =>
    send<{ saved: boolean }>(`${base(projectId, framework)}/findings/${encodeURIComponent(controlId)}`, { method: 'PUT', json: change }),

  saveScope: (projectId: string, categories: Soc2Category[], exclusions: Partial<Record<Soc2Category, string>>) =>
    send<{ categories: Soc2Category[] }>(`${base(projectId, 'soc2')}/scope`, { method: 'PUT', json: { categories, exclusions } }),

  sign: (projectId: string, framework: FrameworkId, role: Signoff['role']) => send<{ signoff: Signoff }>(`${base(projectId, framework)}/signoff`, { method: 'POST', json: { role } }),

  evidence: (projectId: string, framework: FrameworkId) => send<{ evidence: EvidenceItem[] }>(`${base(projectId, framework)}/evidence`).then((r) => r.evidence),

  addEvidence(projectId: string, framework: FrameworkId, e: NewEvidence) {
    const common = { title: e.title, description: e.description, origin: e.origin, collectedAt: e.collectedAt, ...(e.validUntil ? { validUntil: e.validUntil } : {}) };
    if (e.kind === 'file' && e.file) {
      const fd = new FormData();
      fd.set('file', e.file);
      for (const [k, v] of Object.entries(common)) fd.set(k, v);
      fd.set('controls', JSON.stringify(e.controls));
      return send<{ evidence: EvidenceItem }>(`${base(projectId, framework)}/evidence`, { method: 'POST', body: fd });
    }
    return send<{ evidence: EvidenceItem }>(`${base(projectId, framework)}/evidence`, { method: 'POST', json: { ...common, kind: e.kind, ...(e.url ? { url: e.url } : {}), controls: e.controls } });
  },

  linkEvidence: (projectId: string, framework: FrameworkId, id: string, controls: string[]) => send<{ saved: boolean }>(`${base(projectId, framework)}/evidence/${id}`, { method: 'PUT', json: { controls } }),
  removeEvidence: (projectId: string, framework: FrameworkId, id: string) => send<{ removed: boolean }>(`${base(projectId, framework)}/evidence/${id}`, { method: 'DELETE' }),
  downloadEvidence: async (projectId: string, framework: FrameworkId, id: string) => fileOf(await fetch(`${base(projectId, framework)}/evidence/${id}`, { credentials: 'include' }), 'evidence'),

  /** A draft of the report as it stands (not recorded as a version). */
  draft: async (projectId: string, framework: FrameworkId, env = 'production') => fileOf(await fetch(`${base(projectId, framework)}/report${q(env)}`, { credentials: 'include' }), 'report'),
  /** Issues the report: takes the next version number, records it, and returns the file. */
  issue: async (projectId: string, framework: FrameworkId, env = 'production') =>
    fileOf(await fetch(`${base(projectId, framework)}/report${q(env)}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' }), 'report'),
};

export function saveBlob(file: { blob: Blob; filename: string }): void {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a'); a.href = url; a.download = file.filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
