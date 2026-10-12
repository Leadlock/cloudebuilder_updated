/**
 * ApiArchitectureService — HTTP-backed implementation of IArchitectureService.
 *
 * This replaces MockArchitectureService in production builds.
 * The interface is IDENTICAL to IArchitectureService — no frontend changes required.
 *
 * Endpoints used:
 *   GET    /api/projects              — list projects
 *   GET    /api/projects/:id          — get single project
 *   POST   /api/projects              — create project
 *   PUT    /api/projects/:id          — update project
 *   DELETE /api/projects/:id          — delete project
 *   GET    /api/projects/:id/canvas   — load canvas
 *   PUT    /api/projects/:id/canvas   — save canvas
 */
import type { IArchitectureService } from './ArchitectureService';
import type { Project, CanvasNode, CanvasEdge, CloudProvider, Environment, Region, ArchitectureVersion, ScaleProfile, ProviderMode } from '@/types';

// ─── Client config ────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  if (typeof window !== 'undefined') {
    // Browser: same origin
    return '';
  }
  // Server-side rendering: use absolute URL
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

interface ApiSuccess<T> { ok: true; data: T }
interface ApiError { ok: false; error: { code: string; message: string; serverRevision?: number; clientRevision?: number } }
type ApiEnvelope<T> = ApiSuccess<T> | ApiError;

export interface ApiFetchError extends Error {
  status?: number;
  code?: string;
  serverRevision?: number;
  clientRevision?: number;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // Dev header — replaced by real auth token in Phase 3
      ...(init?.headers ?? {}),
    },
  });
  const envelope = (await res.json()) as ApiEnvelope<T>;
  if (!envelope.ok) {
    const err: ApiFetchError = new Error(`API ${path} → ${envelope.error.code}: ${envelope.error.message}`);
    err.status = res.status;
    err.code = envelope.error.code;
    if (envelope.error.serverRevision !== undefined) {
      err.serverRevision = envelope.error.serverRevision;
    }
    if (envelope.error.clientRevision !== undefined) {
      err.clientRevision = envelope.error.clientRevision;
    }
    throw err;
  }
  return envelope.data;
}

// ─── Type mapping (API response → Project) ───────────────────────────────────

interface ApiProject {
  id: string;
  name: string;
  provider: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  region: string;
  tags: string[];
  orgId: string;
  ownerId: string;
  environments?: Array<{
    id: string;
    envKey: string;
    label: string;
    region: string;
    createdAt: string;
    updatedAt: string;
    projectId: string;
  }>;
}

function mapApiProject(p: ApiProject, nodes: CanvasNode[] = [], edges: CanvasEdge[] = []): Project {
  const envs = p.environments ?? [];
  const buildEnvState = (key: Environment, region: Region) => {
    const match = envs.find((e) => e.envKey === key);
    return {
      id: key,
      label: match?.label ?? key.charAt(0).toUpperCase() + key.slice(1),
      nodes: key === 'production' ? nodes : [],
      edges: key === 'production' ? edges : [],
      region: (match?.region ?? region) as Region,
    };
  };

  const region = p.region as Region;
  return {
    id: p.id,
    name: p.name,
    provider: p.provider as CloudProvider,
    description: p.description,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    nodes,
    edges,
    resourceCount: nodes.length,
    // Not assessed until the canvas is loaded and evaluated — never a default 100.
    securityScore: 0,
    securityScored: false,
    securityCoveragePct: null,
    architectureScore: 0,
    estimatedMonthlyCost: 0,
    environment: 'production',
    region,
    versions: [],
    tags: p.tags ?? [],
    environments: {
      production:  buildEnvState('production',  region),
      staging:     buildEnvState('staging',     region),
      development: buildEnvState('development', region),
    },
  };
}

// ─── Implementation ───────────────────────────────────────────────────────────

class ApiArchitectureServiceImpl implements IArchitectureService {

  async getProjects(): Promise<Project[]> {
    const raw = await apiFetch<ApiProject[]>('/api/projects');
    return raw.map((p) => mapApiProject(p));
  }

  async getProject(id: string): Promise<Project | null> {
    try {
      const raw = await apiFetch<ApiProject>(`/api/projects/${id}`);
      // Load the production canvas alongside project metadata
      const canvas = await this.loadCanvas(id).catch(() => ({ nodes: [] as CanvasNode[], edges: [] as CanvasEdge[] }));
      return mapApiProject(raw, canvas.nodes, canvas.edges);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('NOT_FOUND')) return null;
      throw err;
    }
  }

  async saveProject(project: Project): Promise<Project> {
    const raw = await apiFetch<ApiProject>(`/api/projects/${project.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: project.name,
        description: project.description,
        tags: project.tags,
        region: project.region,
      }),
    });
    return mapApiProject(raw, project.nodes, project.edges);
  }

  async deleteProject(id: string): Promise<void> {
    await apiFetch(`/api/projects/${id}`, { method: 'DELETE' });
  }

  async saveCanvas(
    projectId: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    env = 'production',
    revision?: number,
    scaleProfile?: ScaleProfile
  ): Promise<{ revision?: number } | void> {
    return apiFetch<{ revision?: number }>(`/api/projects/${projectId}/canvas`, {
      method: 'PUT',
      body: JSON.stringify({ nodes, edges, env, revision, scaleProfile }),
    });
  }

  async loadCanvas(projectId: string, env = 'production'): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[]; revision?: number }> {
    return apiFetch<{ nodes: CanvasNode[]; edges: CanvasEdge[]; revision?: number }>(
      `/api/projects/${projectId}/canvas?env=${env}`,
    );
  }

  async createProject(name: string, provider: CloudProvider): Promise<Project> {
    const region: Region = provider === 'azure' ? 'eastus' : 'us-east-1';
    const raw = await apiFetch<ApiProject>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, provider, region }),
    });
    return mapApiProject(raw);
  }

  async listVersions(projectId: string, env = 'production'): Promise<ArchitectureVersion[]> {
    const raw = await apiFetch<Array<{
      id: string;
      version: number;
      label: string;
      summary: string;
      author: string;
      timestamp: string;
      nodeCount?: number;
    }>>(`/api/projects/${projectId}/versions?env=${env}`);
    return raw.map((v) => ({
      id: v.id,
      version: v.version,
      label: v.label,
      summary: v.summary,
      author: v.author,
      timestamp: v.timestamp,
      nodeCount: v.nodeCount ?? 0,
      nodes: [],
      edges: [],
    }));
  }

  async saveVersion(projectId: string, summary: string, env = 'production', label?: string): Promise<ArchitectureVersion> {
    // The API caps label at 120 and summary at 500 characters.
    const safeLabel = (label ?? summary).slice(0, 120);
    const safeSummary = summary.slice(0, 500);
    const raw = await apiFetch<{
      id: string;
      version: number;
      label: string;
      summary: string;
      author: string;
      timestamp: string;
      nodeCount?: number;
    }>(`/api/projects/${projectId}/versions`, {
      method: 'POST',
      body: JSON.stringify({ label: safeLabel, summary: safeSummary, env }),
    });
    return {
      id: raw.id,
      version: raw.version,
      label: raw.label,
      summary: raw.summary,
      author: raw.author,
      timestamp: raw.timestamp,
      nodeCount: raw.nodeCount ?? 0,
      nodes: [],
      edges: [],
    };
  }

  async restoreVersion(projectId: string, versionId: string, env = 'production'): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }> {
    const raw = await apiFetch<{
      restored: boolean;
      nodes: CanvasNode[];
      edges: CanvasEdge[];
    }>(`/api/projects/${projectId}/versions/${versionId}/restore`, {
      method: 'POST',
      body: JSON.stringify({ env }),
    });
    return { nodes: raw.nodes, edges: raw.edges };
  }

  async cloneEnvironment(projectId: string, from: string, to: string): Promise<{ cloned: boolean; from: string; to: string; nodeCount: number }> {
    return apiFetch<{ cloned: boolean; from: string; to: string; nodeCount: number }>(
      `/api/projects/${projectId}/environments/clone`,
      {
        method: 'POST',
        body: JSON.stringify({ from, to }),
      },
    );
  }

  async promoteEnvironment(projectId: string, from: string, to: string): Promise<{ promoted: boolean; from: string; to: string; nodeCount: number }> {
    return apiFetch<{ promoted: boolean; from: string; to: string; nodeCount: number }>(
      `/api/projects/${projectId}/environments/promote`,
      {
        method: 'POST',
        body: JSON.stringify({ from, to }),
      },
    );
  }

  async saveDraft(
    draftProject: Project,
    revision?: number
  ): Promise<{ revision?: number; hash?: string } | void> {
    return apiFetch<{ revision: number; hash: string }>('/api/architecture/draft', {
      method: 'PUT',
      body: JSON.stringify({
        nodes: draftProject.nodes,
        edges: draftProject.edges,
        providerMode: draftProject.providerMode,
        scaleProfile: draftProject.scaleProfile,
        revision,
      }),
    });
  }

  async loadDraft(): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[]; providerMode?: ProviderMode; scaleProfile?: ScaleProfile; revision?: number; hash?: string } | null> {
    const raw = await apiFetch<{ nodes: CanvasNode[]; edges: CanvasEdge[]; providerMode?: ProviderMode; scaleProfile?: ScaleProfile; revision?: number; hash?: string } | null>('/api/architecture/draft');
    if (!raw) return null;
    return raw;
  }

  async clearDraft(): Promise<void> {
    await apiFetch('/api/architecture/draft', { method: 'DELETE' });
  }
}

export const apiArchitectureService: IArchitectureService = new ApiArchitectureServiceImpl();
