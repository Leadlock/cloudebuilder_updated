/**
 * ApiWellArchitectedService — HTTP-backed Well-Architected intelligence client.
 *
 * Mirrors the pattern of ApiAdvisorService, ApiSecurityService, etc.
 * Falls back gracefully when API fails — never throws to the UI.
 */
import type { WaAssessment, WaFinding } from '@/lib/engines/wellArchitected/types';
import { WellArchitectedFrameworkService } from '@/lib/engines/wellArchitected/WellArchitectedFrameworkService';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';
import type { CanvasNode, CanvasEdge } from '@/types';

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
   * Trigger a fresh analysis for the active project or in-memory live draft.
   * Returns the new assessment.
   */
  async analyze(nodes?: CanvasNode[], edges?: CanvasEdge[]): Promise<WaAssessment | null> {
    const projectId = _activeProjectId;

    if (projectId && projectId !== 'draft-project') {
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
        console.warn('[WA Service] analyze API failed, falling back to live design-time engine:', err);
      }
    }

    // Live draft or API fallback using design-time rule engine
    if (nodes && nodes.length > 0) {
      return this.analyzeNodes(nodes, edges || []);
    }
    return null;
  }

  async analyzeNodes(nodes: CanvasNode[], edges: CanvasEdge[]): Promise<WaAssessment> {
    const waService = new WellArchitectedFrameworkService();
    const resources: DbArchitectureResource[] = nodes.map((n) => ({
      id: n.id,
      architectureId: 'live-draft',
      resourceType: n.resourceType,
      provider: n.provider || (n.resourceType?.startsWith('azure_') ? 'azure' : 'aws'),
      label: n.label || n.resourceType,
      positionX: n.position?.x ?? 0,
      positionY: n.position?.y ?? 0,
      configJson: JSON.stringify(n.config || {}),
      region: (n.config?.region as string) ?? null,
      groupId: n.groupId || null,
      locked: Boolean(n.locked),
    }));
    const connections: DbArchitectureConnection[] = (edges || []).map((e) => ({
      id: e.id,
      architectureId: 'live-draft',
      sourceId: e.source,
      targetId: e.target,
      label: e.label || null,
      edgeType: e.relationshipType || e.edgeType || 'network',
    }));
    return waService.analyzeDesignTime({
      architectureId: 'live-draft',
      projectId: _activeProjectId || 'draft-project',
      resources,
      connections,
    });
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

  /**
   * Downloads the dedicated Well-Architected report (pdf / html / json) generated from the saved architecture.
   * `aiCommentary` is the AI Well-Architected review the user is looking at; the server validates it against the report.
   */
  async downloadReport(
    format: 'pdf' | 'html' | 'json',
    aiCommentary?: { summary: string; pillars: { pillar: string; assessment?: string; topFixes: { ruleId: string; fix?: string }[] }[]; plan: { ruleId: string; action?: string }[]; suggestions: string[] },
  ): Promise<{ blob: Blob; filename: string }> {
    const projectId = _activeProjectId;
    if (!projectId || projectId === 'draft-project') throw new Error('Save the project before exporting a report.');
    const res = await fetch(`${getBaseUrl()}/api/projects/${projectId}/well-architected-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.NODE_ENV === 'development' ? { 'x-user-id': 'dev-user-id' } : {}) },
      body: JSON.stringify({ env: _activeEnvironment, format, ...(aiCommentary ? { aiCommentary } : {}) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null) as ApiError | null;
      throw new Error(err?.error?.message ?? `Report generation failed (${res.status})`);
    }
    const cd = res.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? `cloudcraft-well-architected.${format}`;
    const blob = format === 'json' ? new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' }) : await res.blob();
    return { blob, filename };
  }
}

export const apiWellArchitectedService = new ApiWellArchitectedServiceImpl();
