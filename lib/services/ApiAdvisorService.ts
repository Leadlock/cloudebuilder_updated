/**
 * ApiAdvisorService — HTTP-backed architecture advisor.
 *
 * Calls:
 *   POST /api/projects/:id/optimizations  — runs advisor from persisted arch
 *
 * The interface mirrors what AdvisorPanel already consumes from scoreArchitecture()
 * and generateRecommendations() so the panel only needs minimal changes.
 */
import type { ArchitectureScore, ArchitectureRecommendation } from '@/lib/engines/advisor/ArchitectureAdvisor';
import type { CanvasNode } from '@/types';

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

// ─── Response types ───────────────────────────────────────────────────────────

interface OptimizationResponse {
  optimizationId: string | null;
  architectureId: string;
  recommendations: ArchitectureRecommendation[];
  score: ArchitectureScore;
  createdAt: string;
  message?: string;
}

// ─── Advisor result (used by AdvisorPanel) ────────────────────────────────────

export interface AdvisorResult {
  score: ArchitectureScore;
  recommendations: ArchitectureRecommendation[];
  /** true = came from real API, false = local fallback */
  fromApi: boolean;
}

// ─── Active project registry ─────────────────────────────────────────────────

/** Module-level active project ID — set by AppContext when active project changes */
let _activeProjectId: string | null = null;
let _activeEnvironment = 'production';

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

// ─── IAdvisorService interface ────────────────────────────────────────────────

export interface IAdvisorService {
  analyze(nodes: CanvasNode[], expectedUsers?: number): Promise<AdvisorResult>;
}

// ─── ApiAdvisorService ────────────────────────────────────────────────────────

class ApiAdvisorServiceImpl implements IAdvisorService {

  async analyze(nodes: CanvasNode[], expectedUsers?: number): Promise<AdvisorResult> {
    const projectId = _activeProjectId;
    if (!projectId) {
      throw new Error('No active project context');
    }

    const data = await apiFetch<OptimizationResponse>(
      `/api/projects/${projectId}/optimizations`,
      {
        method: 'POST',
        body: JSON.stringify({ env: _activeEnvironment, expectedUsers }),
      },
    );

    return {
      score: data.score,
      recommendations: data.recommendations ?? [],
      fromApi: true,
    };
  }
}

export const apiAdvisorService: IAdvisorService = new ApiAdvisorServiceImpl();
