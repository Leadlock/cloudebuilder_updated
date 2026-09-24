import { Project, CanvasNode, CanvasEdge, CloudProvider, ArchitectureVersion, ProviderMode, ScaleProfile } from '@/types';

// ─── Interface ────────────────────────────────────────────────────────────────
// The single architecture-persistence contract. ApiArchitectureService (HTTP-backed,
// see @/lib/services/ApiArchitectureService) is the only implementation in use —
// there is deliberately no in-memory mock implementation to fall back to.
export interface IArchitectureService {
  getProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  saveProject(project: Project): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  saveCanvas(projectId: string, nodes: CanvasNode[], edges: CanvasEdge[], env?: string, revision?: number, scaleProfile?: ScaleProfile): Promise<{ revision?: number } | void>;
  loadCanvas(projectId: string, env?: string): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[]; revision?: number }>;
  createProject(name: string, provider: CloudProvider): Promise<Project>;
  listVersions(projectId: string, env?: string): Promise<ArchitectureVersion[]>;
  saveVersion(projectId: string, summary: string, env?: string, label?: string): Promise<ArchitectureVersion>;
  restoreVersion(projectId: string, versionId: string, env?: string): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>;
  cloneEnvironment(projectId: string, from: string, to: string): Promise<{ cloned: boolean; from: string; to: string; nodeCount: number }>;
  promoteEnvironment(projectId: string, from: string, to: string): Promise<{ promoted: boolean; from: string; to: string; nodeCount: number }>;
  saveDraft?(draftProject: Project, revision?: number): Promise<{ revision?: number; hash?: string } | void>;
  loadDraft?(): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[]; providerMode?: ProviderMode; scaleProfile?: ScaleProfile; revision?: number; hash?: string } | null>;
  clearDraft?(): Promise<void>;
}
