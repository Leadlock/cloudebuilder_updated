import type { CanvasNode, CanvasEdge } from '@/types';
import type { ArchitectureReview, DeploymentRecord } from './ArchitectureReviewService';

export class ApiReviewService {
  static async getReviews(projectId: string, environment?: string): Promise<{ reviews: ArchitectureReview[]; latest: ArchitectureReview | null }> {
    const url = `/api/projects/${projectId}/reviews${environment ? `?env=${environment}` : ''}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Failed to fetch reviews: ${res.statusText}`);
    const data = await res.json();
    return data.data;
  }

  static async submitReview(
    projectId: string,
    environment: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    summary: { nodeCount: number; edgeCount: number; criticalIssuesCount: number; estimatedMonthlyCost: number }
  ): Promise<ArchitectureReview> {
    const res = await fetch(`/api/projects/${projectId}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ environment, nodes, edges, summary }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `Failed to submit review (${res.status})`);
    }
    const data = await res.json();
    return data.data;
  }

  static async approveReview(projectId: string, reviewId: string, comments?: string): Promise<ArchitectureReview> {
    const res = await fetch(`/api/projects/${projectId}/reviews/${reviewId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ comments }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `Failed to approve review (${res.status})`);
    }
    const data = await res.json();
    return data.data;
  }

  static async rejectReview(projectId: string, reviewId: string, comments: string): Promise<ArchitectureReview> {
    const res = await fetch(`/api/projects/${projectId}/reviews/${reviewId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ comments }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `Failed to reject review (${res.status})`);
    }
    const data = await res.json();
    return data.data;
  }

  static async requestChanges(projectId: string, reviewId: string, comments: string): Promise<ArchitectureReview> {
    const res = await fetch(`/api/projects/${projectId}/reviews/${reviewId}/request-changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ comments }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `Failed to request changes (${res.status})`);
    }
    const data = await res.json();
    return data.data;
  }

  static async deploy(
    projectId: string,
    environment: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[]
  ): Promise<DeploymentRecord> {
    const res = await fetch(`/api/projects/${projectId}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ environment, nodes, edges }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `Deployment failed (${res.status})`);
    }
    const data = await res.json();
    return data.data;
  }

  static async getDeployments(projectId: string, environment?: string): Promise<DeploymentRecord[]> {
    const url = `/api/projects/${projectId}/deployments${environment ? `?env=${environment}` : ''}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Failed to fetch deployments: ${res.statusText}`);
    const data = await res.json();
    return data.data?.deployments || [];
  }
}
