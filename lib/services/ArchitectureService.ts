import { Project, CanvasNode, CanvasEdge, CloudProvider, ArchitectureVersion, Environment, ScaleProfile } from '@/types';

// ─── Interface ────────────────────────────────────────────────────────────────
export interface IArchitectureService {
  getProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  saveProject(project: Project): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  saveCanvas(projectId: string, nodes: CanvasNode[], edges: CanvasEdge[], env?: string, revision?: number, scaleProfile?: ScaleProfile): Promise<{ revision?: number } | void>;
  loadCanvas(projectId: string, env?: string): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[]; revision?: number }>;
  createProject(name: string, provider: CloudProvider): Promise<Project>;
  listVersions(projectId: string, env?: string): Promise<ArchitectureVersion[]>;
  saveVersion(projectId: string, summary: string, env?: string): Promise<ArchitectureVersion>;
  restoreVersion(projectId: string, versionId: string, env?: string): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>;
  cloneEnvironment(projectId: string, from: string, to: string): Promise<{ cloned: boolean; from: string; to: string; nodeCount: number }>;
  promoteEnvironment(projectId: string, from: string, to: string): Promise<{ promoted: boolean; from: string; to: string; nodeCount: number }>;
  saveDraft?(draftProject: Project, revision?: number): Promise<{ revision?: number; hash?: string } | void>;
  loadDraft?(): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[]; providerMode?: any; scaleProfile?: any; revision?: number; hash?: string } | null>;
  clearDraft?(): Promise<void>;
}

// ─── Mock Implementation ──────────────────────────────────────────────────────
class MockArchitectureService implements IArchitectureService {
  private store = new Map<string, Project>();

  async getProjects(): Promise<Project[]> {
    return Array.from(this.store.values());
  }

  async getProject(id: string): Promise<Project | null> {
    return this.store.get(id) ?? null;
  }

  async saveProject(project: Project): Promise<Project> {
    this.store.set(project.id, project);
    return project;
  }

  async deleteProject(id: string): Promise<void> {
    this.store.delete(id);
  }

  async saveCanvas(
    projectId: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    env = 'production',
  ): Promise<void> {
    const project = this.store.get(projectId);
    if (project) {
      const e = env as Environment;
      const envs = { ...project.environments };
      if (envs[e]) {
        envs[e] = { ...envs[e], nodes, edges };
      }
      this.store.set(projectId, { ...project, nodes, edges, environments: envs });
    }
  }

  async loadCanvas(
    projectId: string,
    env = 'production',
  ): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }> {
    const project = this.store.get(projectId);
    if (!project) return { nodes: [], edges: [] };
    const e = env as Environment;
    const envState = project.environments[e];
    return { nodes: envState?.nodes ?? project.nodes ?? [], edges: envState?.edges ?? project.edges ?? [] };
  }

  async createProject(name: string, provider: CloudProvider): Promise<Project> {
    const now = new Date().toISOString();
    const region = provider === 'azure' ? 'eastus' : 'us-east-1';
    const envRegion = region as import('@/types').Region;
    const project: Project = {
      id: `proj-${Date.now()}`,
      name,
      provider,
      description: '',
      createdAt: now,
      updatedAt: now,
      nodes: [],
      edges: [],
      resourceCount: 0,
      securityScore: 100,
      architectureScore: 0,
      estimatedMonthlyCost: 0,
      environment: 'production',
      region: envRegion,
      versions: [],
      tags: [],
      environments: {
        production:  { id: 'production',  label: 'Production',  nodes: [], edges: [], region: envRegion },
        staging:     { id: 'staging',     label: 'Staging',     nodes: [], edges: [], region: envRegion },
        development: { id: 'development', label: 'Development', nodes: [], edges: [], region: envRegion },
      },
    };
    this.store.set(project.id, project);
    return project;
  }

  async listVersions(projectId: string, _env = 'production'): Promise<ArchitectureVersion[]> {
    const project = this.store.get(projectId);
    return project?.versions ?? [];
  }

  async saveVersion(projectId: string, summary: string, _env = 'production'): Promise<ArchitectureVersion> {
    const project = this.store.get(projectId);
    const nodes = project?.nodes ?? [];
    const version: ArchitectureVersion = {
      id: `v-${Date.now()}`,
      version: (project?.versions.length ?? 0) + 1,
      label: summary,
      timestamp: new Date().toISOString(),
      author: 'Current User',
      summary,
      nodes,
      edges: project?.edges ?? [],
      nodeCount: nodes.length,
    };
    if (project) {
      project.versions.push(version);
    }
    return version;
  }

  async restoreVersion(projectId: string, versionId: string, env = 'production'): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }> {
    const project = this.store.get(projectId);
    if (!project) throw new Error('Project not found');
    const version = project.versions.find((v) => v.id === versionId);
    if (!version) throw new Error('Version not found');
    await this.saveCanvas(projectId, version.nodes, version.edges, env);
    return { nodes: version.nodes, edges: version.edges };
  }

  async cloneEnvironment(projectId: string, from: string, to: string): Promise<{ cloned: boolean; from: string; to: string; nodeCount: number }> {
    const project = this.store.get(projectId);
    if (!project) throw new Error('Project not found');
    const src = project.environments[from as Environment];
    const nodeCount = src?.nodes.length ?? 0;
    if (src) {
      project.environments[to as Environment] = {
        ...src,
        id: to as Environment,
        label: to.charAt(0).toUpperCase() + to.slice(1),
        nodes: JSON.parse(JSON.stringify(src.nodes)),
        edges: JSON.parse(JSON.stringify(src.edges)),
      };
    }
    return { cloned: true, from, to, nodeCount };
  }

  async promoteEnvironment(projectId: string, from: string, to: string): Promise<{ promoted: boolean; from: string; to: string; nodeCount: number }> {
    const res = await this.cloneEnvironment(projectId, from, to);
    return { promoted: true, from: res.from, to: res.to, nodeCount: res.nodeCount };
  }
}

export const architectureService: IArchitectureService = new MockArchitectureService();
