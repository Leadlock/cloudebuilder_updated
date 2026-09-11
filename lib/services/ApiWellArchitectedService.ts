/**
 * ApiWellArchitectedService — HTTP-backed Well-Architected intelligence client.
 *
 * Mirrors the pattern of ApiAdvisorService, ApiSecurityService, etc.
 * Falls back gracefully when API fails — never throws to the UI.
 */
import type { WaAssessment, WaFinding } from '@/lib/engines/wellArchitected/types';

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
      ...(process.env.NODE_ENV === 'development' ? { 'x-user-id': 'dev-user-id' } : {}),
    },
    ...init,
  });
  const envelope = (await res.json()) as ApiEnvelope<T>;
  if (!envelope.ok) {
    throw new Error(`API ${path} → ${envelope.error.code}: ${envelope.error.message}`);
  }
  return envelope.data;
}

// ─── Active project registry ─────────────────────────────────────────────────

let _activeProjectId: string | null = null;
let _activeEnvironment = 'production';

export function setActiveProjectId(id: string | null): void {
  _activeProjectId = id;
}

export function setActiveEnvironment(env: string): void {
  _activeEnvironment = env;
}

// ─── Response types ───────────────────────────────────────────────────────────

interface GetAssessmentResponse {
  assessment: WaAssessment | null;
  message?: string;
}

interface AnalyzeResponse {
  assessmentId: string;
  assessment: WaAssessment;
  findingCount: number;
  criticalCount: number;
  highCount: number;
}

interface ResourceFindingsResponse {
  resourceId: string;
  findings: WaFinding[];
  findingCount: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

class ApiWellArchitectedServiceImpl {

  /**
   * Get the latest cached assessment for the active project.
   * Returns null if no assessment exists yet.
   */
  async getAssessment(): Promise<WaAssessment | null> {
    const projectId = _activeProjectId;
    if (!projectId) return null;

    try {
      const data = await apiFetch<GetAssessmentResponse>(
        `/api/projects/${projectId}/well-architected?env=${_activeEnvironment}`,
      );
      return data.assessment;
    } catch (err) {
      console.warn('[WA Service] getAssessment failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Trigger a fresh analysis for the active project.
   * Returns the new assessment.
   */
  async analyze(): Promise<WaAssessment | null> {
    const projectId = _activeProjectId;
    if (!projectId) return null;

    try {
      const data = await apiFetch<AnalyzeResponse>(
        `/api/projects/${projectId}/well-architected/analyze`,
        {
          method: 'POST',
          body: JSON.stringify({ env: _activeEnvironment }),
        },
      );
      return data.assessment;
    } catch (err) {
      console.warn('[WA Service] analyze failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Get Well-Architected findings for a specific resource.
   * Used by PropertiesPanel > Well-Architected tab.
   */
  async getResourceFindings(resourceId: string, architectureId: string): Promise<WaFinding[]> {
    try {
      const data = await apiFetch<ResourceFindingsResponse>(
        `/api/resources/${resourceId}/findings?architectureId=${architectureId}`,
      );
      return data.findings ?? [];
    } catch {
      return [];
    }
  }
}

export const apiWellArchitectedService = new ApiWellArchitectedServiceImpl();
