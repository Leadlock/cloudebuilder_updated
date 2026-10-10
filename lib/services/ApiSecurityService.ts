/**
 * ApiSecurityService — HTTP-backed implementation of ISecurityService.
 *
 * This replaces MockSecurityService for real API-backed security scanning.
 * The interface is IDENTICAL to ISecurityService — no frontend changes required.
 *
 * The service calls:
 *   POST /api/projects/:id/security-scans  — triggers a real scan from persisted arch
 *   GET  /api/projects/:id/security-scans/:scanId — retrieves a scan
 *
 * NOTE: The ISecurityService interface operates on CanvasNode[] (React Flow model)
 * for compatibility with the existing UI. The API bridges to the persisted model.
 * The `applyFix` method remains client-side only — it modifies local node state
 * which is then saved to the server via the architecture save flow.
 */
import type { ISecurityService } from './SecurityService';
import type { CanvasNode, SecurityIssue } from '@/types';
import { applyRuleRemediation } from '@/lib/engines/security/remediation';
import type { AssessmentResult } from '@/lib/engines/assessment/types';

// ─── API helpers ─────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  if (typeof window !== 'undefined') return '';
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

interface ApiSuccess<T> { ok: true; data: T }
interface ApiError { ok: false; error: { code: string; message: string } }
type ApiEnvelope<T> = ApiSuccess<T> | ApiError;

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...init,
  });
  const envelope = (await res.json()) as ApiEnvelope<T>;
  if (!envelope.ok) {
    throw new Error(`API ${path} → ${envelope.error.code}: ${envelope.error.message}`);
  }
  return envelope.data;
}

// ─── Response types from the API ─────────────────────────────────────────────

export interface PersistedScan {
  scanId: string | null;
  persisted: boolean;
  architectureId: string;
  architectureRevision: number;
  graphHash: string;
  rulesetVersion: string;
  score: number | null;
  findings: SecurityIssue[];
  assessment: AssessmentResult | null;
  createdAt: string;
  message?: string;
}

export interface ScanHistoryEntry {
  scanId: string;
  createdAt: string;
  architectureRevision: number | null;
  graphHash: string | null;
  rulesetVersion: string | null;
  securityScore: number | null;
  coveragePct: number | null;
  findingCount: number;
  legacy: boolean;
}

export interface ReviewRecord {
  id: string;
  findingId: string;
  ruleId: string;
  status: 'ACCEPTED_RISK' | 'FALSE_POSITIVE' | 'NOT_APPLICABLE';
  reason: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

// ─── Active project registry ─────────────────────────────────────────────────

/** Module-level active project ID — set by AppContext when active project changes */
let _activeProjectId: string | null = null;
let _activeEnvironment: string = 'production';

/**
 * Set the active project ID so the API service can scope its requests correctly.
 * Called by AppContext whenever the active project changes — no localStorage needed.
 */
export function setActiveProjectId(id: string | null): void {
  _activeProjectId = id;
}

export function setActiveEnvironment(env: string): void {
  _activeEnvironment = env;
}

// ─── ApiSecurityService ───────────────────────────────────────────────────────

class ApiSecurityServiceImpl implements ISecurityService {

  /** Runs a persisted scan and returns the flat SECURITY finding list (legacy interface). */
  async scan(_nodes?: CanvasNode[]): Promise<SecurityIssue[]> {
    return (await this.runPersistedScan()).findings;
  }

  /** Assess the SAVED architecture on the server and store an immutable snapshot. */
  async runPersistedScan(): Promise<PersistedScan> {
    const projectId = _activeProjectId;
    if (!projectId || projectId === 'draft-project') throw new Error('No active project context');
    return apiFetch<PersistedScan>(`/api/projects/${projectId}/security-scans`, {
      method: 'POST',
      body: JSON.stringify({ env: _activeEnvironment }),
    });
  }

  async listScans(): Promise<{ scans: ScanHistoryEntry[]; currentRevision?: number }> {
    const projectId = _activeProjectId;
    if (!projectId || projectId === 'draft-project') return { scans: [] };
    return apiFetch(`/api/projects/${projectId}/security-scans?env=${encodeURIComponent(_activeEnvironment)}`);
  }

  async listReviews(): Promise<ReviewRecord[]> {
    const projectId = _activeProjectId;
    if (!projectId || projectId === 'draft-project') return [];
    const data = await apiFetch<{ reviews: ReviewRecord[] }>(`/api/projects/${projectId}/finding-reviews?env=${encodeURIComponent(_activeEnvironment)}`);
    return data.reviews;
  }

  async createReview(input: { findingId: string; status: ReviewRecord['status']; reason: string; expiresAt?: string }): Promise<ReviewRecord> {
    const projectId = _activeProjectId;
    if (!projectId || projectId === 'draft-project') throw new Error('Save the project before recording review decisions.');
    const data = await apiFetch<{ review: ReviewRecord }>(`/api/projects/${projectId}/finding-reviews`, {
      method: 'POST',
      body: JSON.stringify({ ...input, env: _activeEnvironment }),
    });
    return data.review;
  }

  async revokeReview(reviewId: string): Promise<void> {
    const projectId = _activeProjectId;
    if (!projectId) return;
    await apiFetch(`/api/projects/${projectId}/finding-reviews/${reviewId}`, { method: 'DELETE' });
  }

  /** Download the assessment report generated server-side from a persisted snapshot. */
  async downloadReport(format: 'pdf' | 'html' | 'json', scanId?: string, aiCommentary?: { summary: string; priorities: { ruleId: string; problem?: string; fix?: string }[]; suggestions: string[] }): Promise<{ blob: Blob; filename: string; scanId: string | null }> {
    const projectId = _activeProjectId;
    if (!projectId || projectId === 'draft-project') throw new Error('Save the project before exporting a report.');
    const res = await fetch(`${getBaseUrl()}/api/projects/${projectId}/assessment-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: _activeEnvironment, format, ...(scanId ? { scanId } : {}), ...(aiCommentary ? { aiCommentary } : {}) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null) as ApiError | null;
      throw new Error(err?.error?.message ?? `Report generation failed (${res.status})`);
    }
    const cd = res.headers.get('Content-Disposition') ?? '';
    const ext = format === 'json' ? 'json' : format;
    const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? `cloudcraft-assessment.${ext}`;
    const blob = format === 'json' ? new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' }) : await res.blob();
    return { blob, filename, scanId: res.headers.get('X-Assessment-Scan-Id') };
  }

  score(issues: SecurityIssue[]): number {
    if (issues.length === 0) return 100;
    const weights: Record<string, number> = { critical: 25, high: 15, medium: 8, low: 3 };
    const deduction = issues.reduce((acc, i) => acc + (weights[i.severity] ?? 0), 0);
    return Math.max(0, 100 - deduction);
  }

  applyFix(nodes: CanvasNode[], nodeId: string, ruleId: string): CanvasNode[] {
    // Compatibility helper (unverified patch). The Security view uses
    // lib/engines/assessment/autofix.applyAutoFix, which verifies the result.
    return nodes.map((n) => {
      if (n.id !== nodeId) return n;
      return { ...n, config: applyRuleRemediation(n.config, ruleId, { id: n.id, label: n.label, resourceType: n.resourceType }) };
    });
  }
}

export const apiSecurityService = new ApiSecurityServiceImpl();
