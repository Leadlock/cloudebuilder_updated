import type { CanvasNode, CanvasEdge } from '@/types';
import type { ArchitectureReview, DeploymentRecord } from './ArchitectureReviewService';

function parseErrorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== 'object') return fallback;
  const e = err as Record<string, unknown>;
  if (typeof e.error === 'string') return e.error;
  if (typeof e.error === 'object' && e.error !== null) {
    const errorObj = e.error as Record<string, unknown>;
    return String(errorObj.message || errorObj.code || JSON.stringify(e.error));
  }
  if (typeof e.message === 'string') return e.message;
  return fallback;
}

export class ApiReviewService {
  static async getReviews(
    projectId: string,
    environment?: string,
    _user?: { id: string; role?: string }
  ): Promise<{ reviews: ArchitectureReview[]; latest: ArchitectureReview | null }> {
    const url = `/api/projects/${projectId}/reviews${environment ? `?env=${environment}` : ''}`;
    const headers: Record<string, string> = {};

    const res = await fetch(url, {
      headers,
      credentials: 'include',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseErrorMessage(err, `Failed to fetch reviews: ${res.statusText} (${res.status})`));
    }
    const data = await res.json();
    return data.data || { reviews: [], latest: null };
  }

  static async submitReview(
    projectId: string,
    environment: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    summary: { nodeCount: number; edgeCount: number; criticalIssuesCount: number; estimatedMonthlyCost: number },
    _user?: { id: string; role?: string }
  ): Promise<ArchitectureReview> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const res = await fetch(`/api/projects/${projectId}/reviews`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ environment, nodes, edges, summary }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseErrorMessage(err, `Failed to submit review (${res.status})`));
    }
    const data = await res.json();
    return data.data;
  }

  static async approveReview(
    projectId: string,
    reviewId: string,
    comments?: string,
    _user?: { id: string; role?: string }
  ): Promise<ArchitectureReview> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const res = await fetch(`/api/projects/${projectId}/reviews/${reviewId}/approve`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ comments }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseErrorMessage(err, `Failed to approve review (${res.status})`));
    }
    const data = await res.json();
    return data.data;
  }

  static async rejectReview(
    projectId: string,
    reviewId: string,
    comments: string,
    _user?: { id: string; role?: string }
  ): Promise<ArchitectureReview> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const res = await fetch(`/api/projects/${projectId}/reviews/${reviewId}/reject`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ comments }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseErrorMessage(err, `Failed to reject review (${res.status})`));
    }
    const data = await res.json();
    return data.data;
  }

  static async requestChanges(
    projectId: string,
    reviewId: string,
    comments: string,
    _user?: { id: string; role?: string }
  ): Promise<ArchitectureReview> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const res = await fetch(`/api/projects/${projectId}/reviews/${reviewId}/request-changes`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ comments }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseErrorMessage(err, `Failed to request changes (${res.status})`));
    }
    const data = await res.json();
    return data.data;
  }

  static async deploy(
    projectId: string,
    environment: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    _user?: { id: string; role?: string }
  ): Promise<DeploymentRecord> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const res = await fetch(`/api/projects/${projectId}/deploy`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ environment, nodes, edges }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseErrorMessage(err, `Deployment failed (${res.status})`));
    }
    const data = await res.json();
    return data.data;
  }

  static async getDeployments(
    projectId: string,
    environment?: string,
    _user?: { id: string; role?: string }
  ): Promise<DeploymentRecord[]> {
    const url = `/api/projects/${projectId}/deployments${environment ? `?env=${environment}` : ''}`;
    const headers: Record<string, string> = {};

    const res = await fetch(url, { headers, credentials: 'include' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(parseErrorMessage(err, `Failed to fetch deployments: ${res.statusText} (${res.status})`));
    }
    const data = await res.json();
    return data.data?.deployments || [];
  }
}
