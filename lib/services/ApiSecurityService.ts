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
import { isRuleFixable, applyRuleRemediation } from '@/lib/engines/security/remediation';

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

// ─── Response types from the API ─────────────────────────────────────────────

interface ApiFinding {
  id: string;
  ruleId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  resourceId: string;
  provider: string;
  resourceType: string;
  remediation: string;
  meta: Record<string, unknown>;
}

interface ScanResponse {
  scanId: string | null;
  architectureId: string;
  score: number;
  findingCount: number;
  findings: ApiFinding[];
  createdAt: string;
  message?: string;
}

// ─── Mapper: API finding → SecurityIssue ─────────────────────────────────────

function mapFinding(f: ApiFinding, nodes: CanvasNode[]): SecurityIssue {
  // Find the node label from the in-memory canvas to populate nodeLabel
  const node = nodes.find((n) => n.id === f.resourceId);
  const nodeLabel = node?.label ?? f.resourceId;

  // Map severity: API supports 'info' but SecurityIssue type does not
  const severity = f.severity === 'info' ? 'low' : f.severity as SecurityIssue['severity'];

  return {
    id: f.id,
    nodeId: f.resourceId,
    nodeLabel,
    severity,
    message: f.title,
    recommendation: f.remediation,
    fixable: isFixable(f.ruleId),
    ruleId: f.ruleId,
  };
}

function isFixable(ruleId: string): boolean {
  return isRuleFixable(ruleId);
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

  async scan(nodes: CanvasNode[]): Promise<SecurityIssue[]> {
    const projectId = _activeProjectId;
    if (!projectId) {
      throw new Error('No active project context');
    }

    const data = await apiFetch<ScanResponse>(
      `/api/projects/${projectId}/security-scans`,
      {
        method: 'POST',
        body: JSON.stringify({ env: _activeEnvironment }),
      },
    );

    return (data.findings ?? []).map((f) => mapFinding(f, nodes));
  }

  score(issues: SecurityIssue[]): number {
    if (issues.length === 0) return 100;
    const weights: Record<string, number> = { critical: 25, high: 15, medium: 8, low: 3 };
    const deduction = issues.reduce((acc, i) => acc + (weights[i.severity] ?? 0), 0);
    return Math.max(0, 100 - deduction);
  }

  applyFix(nodes: CanvasNode[], nodeId: string, ruleId: string): CanvasNode[] {
    // Client-side only: modifies local node config state
    // The user can then save the canvas to persist the fix
    return nodes.map((n) => {
      if (n.id !== nodeId) return n;
      return { ...n, config: applyRuleRemediation(n.config, ruleId) };
    });
  }

}

export const apiSecurityService: ISecurityService = new ApiSecurityServiceImpl();
