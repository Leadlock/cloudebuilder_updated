'use client';
import React, { createContext, useContext, useReducer, ReactNode, useEffect, useRef } from 'react';
import {
  Project, CanvasNode, CanvasEdge, CloudProvider, AppView, Environment,
  Region, ArchitectureVersion, EnvironmentState, CanvasViewMode,
  ProviderMode, ScaleProfile, providerModeToCloudProvider, cloudProviderToProviderMode,
  isNodeCompatibleWithProviderMode
} from '@/types';
import { mockProjects } from '@/lib/mockData';
import { calculateCosts } from '@/lib/analysis';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { scoreArchitecture } from '@/lib/generator';
import { v4 as uuidv4 } from 'uuid';
import { applyAutoFix } from '@/lib/engines/assessment/autofix';
import { adaptiveScaleEngine } from '@/lib/engines/capacity/AdaptiveScaleEngine';
import { apiArchitectureService } from '@/lib/services/ApiArchitectureService';
import type { IArchitectureService } from '@/lib/services/ArchitectureService';
import { setActiveProjectId as setSecurityProjectId, setActiveEnvironment as setSecurityEnvironment } from '@/lib/services/ApiSecurityService';
import { setActiveProjectId as setCostProjectId, setActiveEnvironment as setCostEnvironment, setActiveCurrency } from '@/lib/services/ApiCostService';
import { setActiveProjectId as setTerraformProjectId, setActiveEnvironment as setTerraformEnvironment } from '@/lib/services/ApiTerraformService';
import { setActiveProjectId as setAdvisorProjectId, setActiveEnvironment as setAdvisorEnvironment } from '@/lib/services/ApiAdvisorService';
import { setActiveProjectId as setWaProjectId, setActiveEnvironment as setWaEnvironment } from '@/lib/services/ApiWellArchitectedService';

import type { AuthUser } from '@/lib/api/authService';

export type AutoSaveStatus = 'saved' | 'saving' | 'unsaved' | 'error';

export interface AppState {
  projects: Project[];
  activeProjectId: string | null;
  draftProject: Project;
  autoSaveStatus: AutoSaveStatus;
  lastSavedTime: string | null;
  saveConflict: { serverRevision: number; clientRevision: number; message?: string } | null;
  activeView: AppView;
  activeCanvasMode: CanvasViewMode;
  activeEnvironment: Environment;
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  providerFilter: 'all' | 'aws' | 'azure';
  architectureVersion: number;
  lastSavedVersion: number;
  /** User-selected display currency (e.g. 'USD', 'INR', 'EUR', etc.) */
  displayCurrency: string;
  /** Incremented on RESTORE_VERSION to force InfraCanvas remount */
  canvasKey: number;
  /** Whether the initial API load has completed */
  apiLoaded: boolean;
  /** Currently logged in user with role (admin vs user) */
  currentUser: AuthUser | null;
  /** Whether the login / role switch modal is open */
  isLoginModalOpen: boolean;
  /** True once the initial /api/auth/session check has resolved (success or failure) */
  sessionChecked: boolean;
}

type Action =
  | { type: 'SET_VIEW'; view: AppView }
  | { type: 'SET_CANVAS_MODE'; mode: CanvasViewMode }
  | { type: 'SET_ACTIVE_PROJECT'; id: string | null }
  | { type: 'SET_ENVIRONMENT'; env: Environment }
  | { type: 'SET_CURRENCY'; currency: string }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_MOBILE_SIDEBAR'; open: boolean }
  | { type: 'TOGGLE_MOBILE_SIDEBAR' }
  | { type: 'CREATE_PROJECT'; name: string; provider: CloudProvider; nodes?: CanvasNode[]; edges?: CanvasEdge[] }
  | { type: 'DELETE_PROJECT'; id: string }
  | { type: 'UPDATE_CANVAS'; nodes: CanvasNode[]; edges: CanvasEdge[] }
  | { type: 'UPDATE_NODE_CONFIG'; nodeId: string; config: Record<string, unknown>; label?: string }
  | { type: 'SAVE_PROJECT'; project: Project }
  | { type: 'SET_REGION'; region: Region }
  | { type: 'SET_PROVIDER_FILTER'; filter: 'all' | 'aws' | 'azure' }
  | { type: 'CLONE_ENVIRONMENT'; from: Environment; to: Environment }
  | { type: 'PROMOTE_ENVIRONMENT'; from: Environment; to: Environment }
  | { type: 'SET_ENVIRONMENT_CANVAS'; env: Environment; nodes: CanvasNode[]; edges: CanvasEdge[]; revision?: number }
  | { type: 'RESTORE_VERSION'; versionId?: string; nodes?: CanvasNode[]; edges?: CanvasEdge[] }
  | { type: 'SAVE_VERSION'; summary: string }
  | { type: 'FIX_SECURITY_ISSUE'; nodeId: string; ruleId: string }
  | { type: 'APPLY_COST_OPTIMIZATION'; optimizationId: string; nodeId?: string }
  | { type: 'SET_USER'; user: AuthUser | null }
  | { type: 'SET_LOGIN_MODAL'; open: boolean }
  | { type: 'SET_SESSION_CHECKED' }
  | { type: 'INIT_BLANK_ARCHITECTURE'; provider?: CloudProvider; providerMode?: ProviderMode; scaleProfile?: ScaleProfile; nodes?: CanvasNode[]; edges?: CanvasEdge[] }
  | { type: 'SET_SCALE_PROFILE'; scaleProfile: ScaleProfile; adaptScale?: boolean }
  | { type: 'SET_PROVIDER_MODE'; mode: ProviderMode }
  | { type: 'CONFIRM_PROVIDER_MODE_CHANGE'; mode: ProviderMode }
  | { type: 'SET_AUTO_SAVE_STATUS'; status: AutoSaveStatus; lastSavedTime?: string; saveConflict?: { serverRevision: number; clientRevision: number; message?: string } | null }
  | { type: 'SAVE_NOW' }
  | { type: 'PROMOTE_DRAFT_TO_PROJECT'; name: string }
  | { type: 'RESOLVE_SAVE_CONFLICT'; resolution: 'reload' | 'overwrite' }
  | { type: 'UPDATE_PROJECT_REVISION'; projectId: string; revision: number }
  | { type: 'UPDATE_DRAFT_REVISION'; revision: number }
  | { type: 'LOAD_DURABLE_DRAFT'; draft: { nodes: CanvasNode[]; edges: CanvasEdge[]; providerMode?: ProviderMode; scaleProfile?: ScaleProfile; revision?: number } }
  /** Internal: replaces project list after API load */
  | { type: '_LOAD_PROJECTS'; projects: Project[] }
  /** Internal: replaces a single project returned by the API after create */
  | { type: '_REPLACE_PROJECT'; localId: string; project: Project };

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Local draft cache keys are scoped per-account so a shared browser never
// hands one user's unsaved local draft to a different user who signs in
// afterwards — each account's "brand new" first login starts empty.
function draftStorageKey(userId: string | undefined | null): string {
  return `cloudcraft_draft_project_${userId ?? 'anon'}`;
}
function draftTimestampKey(userId: string | undefined | null): string {
  return `cloudcraft_draft_timestamp_${userId ?? 'anon'}`;
}

function computeProject(p: Project, nodes: CanvasNode[], edges: CanvasEdge[]): Project {
  // Coverage-aware security score from the unified assessment engine. It is
  // null when no security check could be evaluated — surfaced as "not scored"
  // (securityScored=false) rather than a default 100.
  const security = runAssessment({ nodes, edges }).securityScore;
  const costs = calculateCosts(nodes);
  const estimatedMonthlyCost = costs.reduce((acc, c) => acc + c.monthlyCost, 0);
  const scores = scoreArchitecture(nodes, edges);
  return {
    ...p,
    nodes,
    edges,
    resourceCount: nodes.length,
    securityScore: security.score ?? 0,
    securityScored: security.score !== null,
    securityCoveragePct: security.coverage.coveragePct,
    architectureScore: scores.overall,
    estimatedMonthlyCost,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Applies a nodes/edges mutation to whichever project is active (the unsaved
 * draft, or a saved project by id), recomputing derived stats and patching
 * the current environment's stored nodes/edges in one place. Shared by the
 * reducer cases that edit the canvas (UPDATE_CANVAS, UPDATE_NODE_CONFIG,
 * SET_SCALE_PROFILE) so the draft-vs-saved-project branching only lives here.
 */
function applyCanvasUpdate(
  state: AppState,
  compute: (project: Project) => { nodes: CanvasNode[]; edges: CanvasEdge[] },
  extra?: (project: Project) => Partial<Project>,
): { draftProject: Project; projects: Project[] } {
  const isDraft = !state.activeProjectId || state.activeProjectId === 'draft-project';

  const apply = (project: Project): Project => {
    const { nodes, edges } = compute(project);
    const updated = computeProject(project, nodes, edges);
    const envs: Record<Environment, EnvironmentState> = {
      ...project.environments,
      [state.activeEnvironment]: {
        ...project.environments[state.activeEnvironment],
        nodes,
        edges,
      },
    };
    return { ...updated, environments: envs, ...(extra ? extra(project) : {}) };
  };

  if (isDraft) {
    return { draftProject: apply(state.draftProject), projects: state.projects };
  }
  return {
    draftProject: state.draftProject,
    projects: state.projects.map((p) => (p.id === state.activeProjectId ? apply(p) : p)),
  };
}

/** Downsize AWS EC2 instance types one tier */
const INSTANCE_DOWNSIZE: Record<string, string> = {
  'm5.2xlarge': 'm5.xlarge',
  'm5.xlarge':  'm5.large',
  'm5.large':   'm5.medium',
  'r5.xlarge':  'r5.large',
  'c5.xlarge':  'c5.large',
};

export function createDefaultDraftProject(
  provider: CloudProvider = 'aws',
  expectedUsers = 10000,
  initialNodes: CanvasNode[] = [],
  initialEdges: CanvasEdge[] = []
): Project {
  const providerKey = provider === 'multi' ? 'aws' : provider;
  const region: Region = providerKey === 'aws' ? 'us-east-1' : 'eastus';
  const scaleProfile: ScaleProfile = {
    expectedUsers,
    requestsPerSecond: Math.max(10, Math.round(expectedUsers * 0.1)),
    peakRequestsPerSecond: Math.max(25, Math.round(expectedUsers * 0.25)),
    availabilityTarget: 99.9,
    geographicDistribution: 'single-region',
    dataGrowth: 'moderate',
    trafficPattern: 'steady',
  };
  const emptyEnvs: Record<Environment, EnvironmentState> = {
    production:  { id: 'production',  label: 'Production',  nodes: initialNodes, edges: initialEdges, region },
    staging:     { id: 'staging',     label: 'Staging',     nodes: [], edges: [], region },
    development: { id: 'development', label: 'Development', nodes: [], edges: [], region },
  };
  const scores = initialNodes.length > 0 ? scoreArchitecture(initialNodes, initialEdges) : { overall: 0 };
  const costs = calculateCosts(initialNodes);
  const estimatedMonthlyCost = costs.reduce((acc, c) => acc + c.monthlyCost, 0);

  return {
    id: 'draft-project',
    name: 'Draft Architecture',
    provider,
    providerMode: cloudProviderToProviderMode(provider),
    scaleProfile,
    isDraft: true,
    revision: 1,
    description: 'Live interactive draft architecture',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: initialNodes,
    edges: initialEdges,
    resourceCount: initialNodes.length,
    ...(() => { const sec = runAssessment({ nodes: initialNodes, edges: initialEdges }).securityScore; return { securityScore: sec.score ?? 0, securityScored: sec.score !== null, securityCoveragePct: sec.coverage.coveragePct }; })(),
    architectureScore: scores.overall,
    estimatedMonthlyCost,
    currency: 'USD',
    environment: 'production',
    region,
    versions: [],
    environments: emptyEnvs,
    tags: ['draft'],
  };
}

// ─── Reducer ──────────────────────────────────────────────────────────────────

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, activeView: action.view, mobileSidebarOpen: false };
    case 'SET_CANVAS_MODE':
      return { ...state, activeCanvasMode: action.mode };
    case 'SET_ACTIVE_PROJECT':
      return { ...state, activeProjectId: action.id, mobileSidebarOpen: false };
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case 'SET_MOBILE_SIDEBAR':
      return { ...state, mobileSidebarOpen: action.open };
    case 'TOGGLE_MOBILE_SIDEBAR':
      return { ...state, mobileSidebarOpen: !state.mobileSidebarOpen };
    case 'SET_PROVIDER_FILTER':
      return { ...state, providerFilter: action.filter };
    case 'SET_USER': {
      const prevId = state.currentUser?.id ?? null;
      const nextId = action.user?.id ?? null;
      if (prevId === nextId) {
        return { ...state, currentUser: action.user };
      }
      // Login, logout, or switching accounts on the same tab: wipe every
      // slice of state scoped to "whoever is currently signed in" so the
      // next account starts on a genuinely brand-new CloudCraft instead of
      // inheriting the previous session's projects/canvas/draft. Real data
      // for the new account is re-fetched by the API-load effects below,
      // keyed off currentUser.
      return {
        ...state,
        currentUser: action.user,
        projects: [],
        activeProjectId: null,
        draftProject: createDefaultDraftProject('aws', 10000),
        activeView: 'dashboard',
        autoSaveStatus: 'saved',
        saveConflict: null,
        apiLoaded: false,
        canvasKey: state.canvasKey + 1,
      };
    }
    case 'SET_LOGIN_MODAL':
      return { ...state, isLoginModalOpen: action.open };
    case 'SET_SESSION_CHECKED':
      return { ...state, sessionChecked: true };

    case 'SET_CURRENCY': {
      const currency = action.currency.toUpperCase();
      if (typeof window !== 'undefined') {
        try { localStorage.setItem('cloudcraft_display_currency', currency); } catch {}
      }
      const projects = state.projects.map((p) => {
        if (p.id === state.activeProjectId) {
          return { ...p, currency };
        }
        return p;
      });
      return { ...state, displayCurrency: currency, projects };
    }

    // ── Internal: replace project list from API ────────────────────────────────
    case '_LOAD_PROJECTS': {
      const mergedProjects = action.projects.map((incoming) => {
        const existing = state.projects.find((p) => p.id === incoming.id);
        if (existing && existing.nodes.length > 0 && incoming.nodes.length === 0) {
          return {
            ...incoming,
            nodes: existing.nodes,
            edges: existing.edges,
            resourceCount: existing.resourceCount || incoming.resourceCount,
            environments: existing.environments,
            securityScore: existing.securityScore,
            architectureScore: existing.architectureScore,
            estimatedMonthlyCost: existing.estimatedMonthlyCost,
          };
        }
        return incoming;
      });
      return { ...state, projects: mergedProjects, apiLoaded: true };
    }

    // ── Internal: swap a locally-created project for the API-returned version ──
    case '_REPLACE_PROJECT': {
      const localProject = state.projects.find((p) => p.id === action.localId);
      const incomingNodes = action.project.nodes?.length ? action.project.nodes : (localProject?.nodes ?? []);
      const incomingEdges = action.project.edges?.length ? action.project.edges : (localProject?.edges ?? []);

      const replacementProject: Project = {
        ...action.project,
        nodes: incomingNodes,
        edges: incomingEdges,
        resourceCount: incomingNodes.length,
        securityScore: localProject?.securityScore ?? action.project.securityScore,
        architectureScore: localProject?.architectureScore ?? action.project.architectureScore,
        estimatedMonthlyCost: localProject?.estimatedMonthlyCost ?? action.project.estimatedMonthlyCost,
        environments: {
          ...action.project.environments,
          production: {
            ...action.project.environments?.production,
            id: 'production',
            label: 'Production',
            region: action.project.region,
            nodes: incomingNodes,
            edges: incomingEdges,
          },
        },
      };

      const projects = state.projects.map((p) =>
        p.id === action.localId ? replacementProject : p
      );
      const activeProjectId =
        state.activeProjectId === action.localId
          ? action.project.id
          : state.activeProjectId;
      return { ...state, projects, activeProjectId, canvasKey: state.canvasKey + 1 };
    }

    // ── SET_ENVIRONMENT: load that env's nodes/edges into the project ──────────
    case 'SET_ENVIRONMENT': {
      const isDraft = !state.activeProjectId || state.activeProjectId === 'draft-project';
      const loadEnv = (project: Project): Project => {
        const envState = project.environments[action.env];
        return { ...computeProject(project, envState.nodes, envState.edges), environment: action.env };
      };
      const draftProject = isDraft ? loadEnv(state.draftProject) : state.draftProject;
      const projects = isDraft
        ? state.projects
        : state.projects.map((p) => (p.id === state.activeProjectId ? loadEnv(p) : p));
      return { ...state, draftProject, projects, activeEnvironment: action.env };
    }

    // ── UPDATE_CANVAS: sync nodes/edges for the active environment only ────────
    case 'UPDATE_CANVAS': {
      const { draftProject, projects } = applyCanvasUpdate(state, () => ({
        nodes: action.nodes,
        edges: action.edges,
      }));
      return {
        ...state,
        draftProject,
        projects,
        autoSaveStatus: 'unsaved',
        architectureVersion: state.architectureVersion + 1,
      };
    }

    // ── UPDATE_NODE_CONFIG: update a single node's config and recompute ────────
    case 'UPDATE_NODE_CONFIG': {
      const { draftProject, projects } = applyCanvasUpdate(state, (project) => ({
        nodes: project.nodes.map((n) =>
          n.id === action.nodeId ? { ...n, config: action.config, label: action.label ?? n.label } : n
        ),
        edges: project.edges,
      }));
      return {
        ...state,
        draftProject,
        projects,
        autoSaveStatus: 'unsaved',
        architectureVersion: state.architectureVersion + 1,
      };
    }

    // ── INIT_BLANK_ARCHITECTURE ───────────────────────────────────────────────
    case 'INIT_BLANK_ARCHITECTURE': {
      const provider = action.provider || (action.providerMode ? providerModeToCloudProvider(action.providerMode) : 'aws');
      const providerMode = action.providerMode || cloudProviderToProviderMode(provider);
      const expectedUsers = action.scaleProfile?.expectedUsers || 10000;
      const newDraft = createDefaultDraftProject(provider, expectedUsers, action.nodes || [], action.edges || []);
      newDraft.providerMode = providerMode;
      if (action.scaleProfile) {
        newDraft.scaleProfile = action.scaleProfile;
      }
      return {
        ...state,
        activeProjectId: 'draft-project',
        draftProject: newDraft,
        activeView: 'canvas',
        canvasKey: state.canvasKey + 1,
        autoSaveStatus: 'saved',
        lastSavedTime: 'Just now',
        saveConflict: null,
      };
    }

    // ── SET_SCALE_PROFILE ─────────────────────────────────────────────────────
    case 'SET_SCALE_PROFILE': {
      const isDraft = !state.activeProjectId || state.activeProjectId === 'draft-project';
      const targetProj = isDraft
        ? state.draftProject
        : state.projects.find((p) => p.id === state.activeProjectId);
      if (!targetProj) return state;

      const { draftProject, projects } = applyCanvasUpdate(
        state,
        (project) => {
          if (action.adaptScale === false || project.nodes.length === 0) {
            return { nodes: project.nodes, edges: project.edges };
          }
          const adaptRes = adaptiveScaleEngine.adaptArchitectureScale(project.nodes, project.edges, action.scaleProfile);
          return { nodes: adaptRes.nodes, edges: adaptRes.edges };
        },
        () => ({ scaleProfile: action.scaleProfile }),
      );

      return {
        ...state,
        draftProject,
        projects,
        autoSaveStatus: 'unsaved',
        architectureVersion: state.architectureVersion + 1,
        canvasKey: state.canvasKey + 1,
      };
    }

    // ── SET_PROVIDER_MODE ─────────────────────────────────────────────────────
    case 'SET_PROVIDER_MODE': {
      const isDraft = !state.activeProjectId || state.activeProjectId === 'draft-project';
      const provider = providerModeToCloudProvider(action.mode);
      const patch = { provider, providerMode: action.mode };
      const draftProject = isDraft ? { ...state.draftProject, ...patch } : state.draftProject;
      const projects = isDraft
        ? state.projects
        : state.projects.map((p) => (p.id === state.activeProjectId ? { ...p, ...patch } : p));
      return {
        ...state,
        draftProject,
        projects,
        autoSaveStatus: 'unsaved',
        architectureVersion: state.architectureVersion + 1,
      };
    }

    // ── CONFIRM_PROVIDER_MODE_CHANGE ──────────────────────────────────────────
    case 'CONFIRM_PROVIDER_MODE_CHANGE': {
      const isDraft = !state.activeProjectId || state.activeProjectId === 'draft-project';
      const targetProj = isDraft
        ? state.draftProject
        : state.projects.find((p) => p.id === state.activeProjectId);
      if (!targetProj) return state;

      const provider = providerModeToCloudProvider(action.mode);
      const { draftProject, projects } = applyCanvasUpdate(
        state,
        (project) => {
          const filteredNodes = project.nodes.filter((n) => isNodeCompatibleWithProviderMode(n, action.mode));
          const allowedIds = new Set(filteredNodes.map((n) => n.id));
          const filteredEdges = project.edges.filter((e) => allowedIds.has(e.source) && allowedIds.has(e.target));
          return { nodes: filteredNodes, edges: filteredEdges };
        },
        () => ({ provider, providerMode: action.mode }),
      );

      return {
        ...state,
        draftProject,
        projects,
        autoSaveStatus: 'unsaved',
        architectureVersion: state.architectureVersion + 1,
        canvasKey: state.canvasKey + 1,
      };
    }

    // ── SET_AUTO_SAVE_STATUS ──────────────────────────────────────────────────
    case 'SET_AUTO_SAVE_STATUS': {
      return {
        ...state,
        autoSaveStatus: action.status,
        lastSavedTime: action.lastSavedTime ?? state.lastSavedTime,
        saveConflict: action.saveConflict !== undefined ? action.saveConflict : state.saveConflict,
      };
    }

    // ── SAVE_NOW ──────────────────────────────────────────────────────────────
    case 'SAVE_NOW': {
      return {
        ...state,
        autoSaveStatus: 'saving',
      };
    }

    // ── PROMOTE_DRAFT_TO_PROJECT ──────────────────────────────────────────────
    case 'PROMOTE_DRAFT_TO_PROJECT': {
      const draft = state.draftProject;
      const newProject: Project = {
        ...draft,
        id: `proj-${Date.now()}`,
        name: action.name || draft.name,
        isDraft: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return {
        ...state,
        projects: [...state.projects, newProject],
        activeProjectId: newProject.id,
        autoSaveStatus: 'saved',
        lastSavedTime: 'Just now',
        saveConflict: null,
      };
    }

    case 'UPDATE_PROJECT_REVISION': {
      const projects = state.projects.map((p) =>
        p.id === action.projectId ? { ...p, revision: action.revision } : p
      );
      return { ...state, projects, lastSavedVersion: state.architectureVersion };
    }

    case 'UPDATE_DRAFT_REVISION': {
      return {
        ...state,
        draftProject: { ...state.draftProject, revision: action.revision },
        lastSavedVersion: state.architectureVersion,
      };
    }

    case 'LOAD_DURABLE_DRAFT': {
      const providerMode = action.draft.providerMode || 'AWS';
      const provider = providerModeToCloudProvider(providerMode);
      const scaleProfile = action.draft.scaleProfile || state.draftProject.scaleProfile;
      const nodes = action.draft.nodes || [];
      const edges = action.draft.edges || [];
      const updatedDraft = computeProject(state.draftProject, nodes, edges);
      const envs: Record<Environment, EnvironmentState> = {
        ...state.draftProject.environments,
        production: {
          ...state.draftProject.environments.production,
          nodes,
          edges,
        },
      };
      return {
        ...state,
        draftProject: {
          ...updatedDraft,
          provider,
          providerMode,
          scaleProfile,
          revision: action.draft.revision ?? 1,
          environments: envs,
        },
        canvasKey: state.canvasKey + 1,
      };
    }

    case 'RESOLVE_SAVE_CONFLICT': {
      if (action.resolution === 'overwrite') {
        // Adopt the server's revision so the retried save carries a revision
        // the server will actually accept, instead of looping on the same conflict.
        const serverRevision = state.saveConflict?.serverRevision;
        const isDraft = !state.activeProjectId || state.activeProjectId === 'draft-project';
        const projects = serverRevision === undefined || isDraft
          ? state.projects
          : state.projects.map((p) => (p.id === state.activeProjectId ? { ...p, revision: serverRevision } : p));
        const draftProject = serverRevision !== undefined && isDraft
          ? { ...state.draftProject, revision: serverRevision }
          : state.draftProject;
        return {
          ...state,
          projects,
          draftProject,
          saveConflict: null,
          autoSaveStatus: 'unsaved',
        };
      } else {
        return {
          ...state,
          saveConflict: null,
          autoSaveStatus: 'saved',
          canvasKey: state.canvasKey + 1,
        };
      }
    }

    case 'SAVE_PROJECT': {
      const exists = state.projects.some((p) => p.id === action.project.id);
      return {
        ...state,
        projects: exists
          ? state.projects.map((p) => p.id === action.project.id ? action.project : p)
          : [...state.projects, action.project],
        lastSavedVersion: state.architectureVersion,
        autoSaveStatus: 'saved',
        lastSavedTime: 'Just now',
      };
    }

    case 'CREATE_PROJECT': {
      const nodes = action.nodes ?? [];
      const edges = action.edges ?? [];
      const providerKey = action.provider === 'multi' ? 'aws' : action.provider;
      const region: Region = providerKey === 'aws' ? 'us-east-1' : 'eastus';
      const emptyEnvs: Record<Environment, EnvironmentState> = {
        production:  { id: 'production',  label: 'Production',  nodes, edges, region },
        staging:     { id: 'staging',     label: 'Staging',     nodes: [], edges: [], region },
        development: { id: 'development', label: 'Development', nodes: [], edges: [], region },
      };
      const scores = nodes.length > 0 ? scoreArchitecture(nodes, edges) : { overall: 0 };
      const costs = calculateCosts(nodes);
      const estimatedMonthlyCost = costs.reduce((acc, c) => acc + c.monthlyCost, 0);
      const newProject: Project = {
        id: `proj-${Date.now()}`,
        name: action.name,
        provider: action.provider,
        description: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodes,
        edges,
        resourceCount: nodes.length,
        ...(() => { const sec = runAssessment({ nodes, edges }).securityScore; return { securityScore: sec.score ?? 0, securityScored: sec.score !== null, securityCoveragePct: sec.coverage.coveragePct }; })(),
        architectureScore: scores.overall,
        estimatedMonthlyCost,
        environment: 'production',
        region,
        versions: [],
        environments: emptyEnvs,
        tags: [],
      };
      return {
        ...state,
        projects: [...state.projects, newProject],
        activeProjectId: newProject.id,
        activeView: 'canvas',
        activeEnvironment: 'production',
        canvasKey: state.canvasKey + 1,
      };
    }

    case 'DELETE_PROJECT':
      return {
        ...state,
        projects: state.projects.filter((p) => p.id !== action.id),
        activeProjectId: state.activeProjectId === action.id ? null : state.activeProjectId,
        activeView: state.activeProjectId === action.id ? 'dashboard' : state.activeView,
      };

    case 'CLONE_ENVIRONMENT':
    case 'PROMOTE_ENVIRONMENT': {
      if (!state.activeProjectId) return state;
      const projects = state.projects.map((p) => {
        if (p.id !== state.activeProjectId) return p;
        const src = p.environments[action.from];
        const idMap = new Map<string, string>();
        for (const n of src.nodes) {
          idMap.set(n.id, uuidv4());
        }
        const clonedNodes: CanvasNode[] = src.nodes.map((n) => ({
          ...n,
          id: idMap.get(n.id)!,
          ...(n.groupId && idMap.has(n.groupId) ? { groupId: idMap.get(n.groupId) } : n.groupId ? { groupId: n.groupId } : {}),
          config: JSON.parse(JSON.stringify(n.config)) as Record<string, unknown>,
          position: { ...n.position },
        }));
        const clonedEdges: CanvasEdge[] = src.edges
          .filter((e) => idMap.has(e.source) && idMap.has(e.target))
          .map((e) => ({
            ...e,
            id: uuidv4(),
            source: idMap.get(e.source)!,
            target: idMap.get(e.target)!,
          }));
        return {
          ...p,
          environments: {
            ...p.environments,
            [action.to]: {
              ...src,
              id: action.to,
              label: action.to.charAt(0).toUpperCase() + action.to.slice(1),
              nodes: clonedNodes,
              edges: clonedEdges,
            },
          },
        };
      });
      return { ...state, projects };
    }

    // ── SET_REGION: update region for current environment and active project ──
    case 'SET_REGION': {
      if (!state.activeProjectId) return state;
      const projects = state.projects.map((p) => {
        if (p.id !== state.activeProjectId) return p;
        const currentEnv = p.environments[state.activeEnvironment];
        const updatedNodes = p.nodes.map((n) => ({ ...n, region: action.region }));
        const envs: Record<Environment, EnvironmentState> = {
          ...p.environments,
          [state.activeEnvironment]: {
            ...currentEnv,
            region: action.region,
            nodes: updatedNodes,
          },
        };
        const updated = computeProject(p, updatedNodes, p.edges);
        return {
          ...updated,
          region: action.region,
          environments: envs,
        };
      });
      return { ...state, projects };
    }

    // ── SET_ENVIRONMENT_CANVAS: update canvas for specific env from backend ──
    case 'SET_ENVIRONMENT_CANVAS': {
      if (!state.activeProjectId) return state;
      const projects = state.projects.map((p) => {
        if (p.id !== state.activeProjectId) return p;
        const currentEnv = p.environments[action.env];
        const envs: Record<Environment, EnvironmentState> = {
          ...p.environments,
          [action.env]: {
            ...currentEnv,
            id: action.env,
            label: currentEnv?.label ?? action.env.charAt(0).toUpperCase() + action.env.slice(1),
            region: currentEnv?.region ?? p.region,
            nodes: action.nodes,
            edges: action.edges,
          },
        };
        const revisionPatch = action.revision !== undefined ? { revision: action.revision } : {};
        if (state.activeEnvironment === action.env) {
          const updated = computeProject(p, action.nodes, action.edges);
          return { ...updated, ...revisionPatch, environments: envs };
        }
        return { ...p, ...revisionPatch, environments: envs };
      });
      const shouldBumpKey = state.activeEnvironment === action.env;
      return {
        ...state,
        projects,
        canvasKey: shouldBumpKey ? state.canvasKey + 1 : state.canvasKey,
      };
    }

    // ── RESTORE_VERSION: restore nodes/edges and bump canvasKey ───────────────
    case 'RESTORE_VERSION': {
      if (!state.activeProjectId) return state;
      const projects = state.projects.map((p) => {
        if (p.id !== state.activeProjectId) return p;
        let nodes = action.nodes;
        let edges = action.edges;
        if (!nodes || !edges) {
          const version = p.versions.find((v) => v.id === action.versionId);
          if (!version) return p;
          nodes = version.nodes;
          edges = version.edges;
        }
        const updated = computeProject(p, nodes, edges);
        const envs: Record<Environment, EnvironmentState> = {
          ...p.environments,
          [state.activeEnvironment]: {
            ...p.environments[state.activeEnvironment],
            nodes,
            edges,
          },
        };
        return { ...updated, environments: envs };
      });
      return { ...state, projects, canvasKey: state.canvasKey + 1 };
    }

    case 'SAVE_VERSION': {
      if (!state.activeProjectId) return state;
      const projects = state.projects.map((p) => {
        if (p.id !== state.activeProjectId) return p;
        const version: ArchitectureVersion = {
          id: `v-${Date.now()}`,
          version: p.versions.length + 1,
          label: action.summary,
          timestamp: new Date().toISOString(),
          author: 'Current User',
          summary: action.summary,
          nodes: p.nodes,
          edges: p.edges,
        };
        return { ...p, versions: [...p.versions, version] };
      });
      return { ...state, projects };
    }

    // ── FIX_SECURITY_ISSUE: patch node config and recompute all scores ─────────
    case 'FIX_SECURITY_ISSUE': {
      if (!state.activeProjectId) return state;
      const projects = state.projects.map((p) => {
        if (p.id !== state.activeProjectId) return p;
        // Legacy entry point: resolve the finding and run it through the verified
        // Auto-Fix pipeline. Only SAFE_AUTOFIX fixes are applied here (no
        // confirmation channel); anything else leaves the graph unchanged.
        const finding = runAssessment({ nodes: p.nodes, edges: p.edges }).findings
          .find((f) => f.resourceIds[0] === action.nodeId && (f.ruleId === action.ruleId || f.findingId === action.ruleId));
        if (!finding) return p;
        const result = applyAutoFix(p.nodes, p.edges, finding.findingId);
        if (result.status !== 'RESOLVED') return p;
        const nodes = result.nodes;
        const updated = computeProject(p, nodes, p.edges);
        const envs: Record<Environment, EnvironmentState> = {
          ...p.environments,
          [state.activeEnvironment]: {
            ...p.environments[state.activeEnvironment],
            nodes,
          },
        };
        return { ...updated, environments: envs };
      });
      return { ...state, projects };
    }

    // ── APPLY_COST_OPTIMIZATION: modify node config then recompute ─────────────
    case 'APPLY_COST_OPTIMIZATION': {
      if (!state.activeProjectId) return state;
      const { optimizationId, nodeId } = action;
      const projects = state.projects.map((p) => {
        if (p.id !== state.activeProjectId) return p;
        let nodes = [...p.nodes];

        // Right-size EC2 instance
        if (nodeId && optimizationId.startsWith('opt-') && !optimizationId.startsWith('opt-nat-') && !optimizationId.startsWith('opt-rds-') && !optimizationId.startsWith('opt-s3-')) {
          nodes = nodes.map((n) => {
            if (n.id !== nodeId) return n;
            const current = n.config.instanceType as string | undefined;
            const downsized = current ? (INSTANCE_DOWNSIZE[current] ?? current) : current;
            return { ...n, config: { ...n.config, instanceType: downsized } };
          });
        }

        // NAT consolidation: keep only one NAT gateway
        if (optimizationId.startsWith('opt-nat-')) {
          const natNodes = nodes.filter((n) => n.resourceType === 'aws_nat');
          if (natNodes.length > 1) {
            const keepId = natNodes[0].id;
            nodes = nodes.filter((n) => n.resourceType !== 'aws_nat' || n.id === keepId);
          }
        }

        const updated = computeProject(p, nodes, p.edges);
        const envs: Record<Environment, EnvironmentState> = {
          ...p.environments,
          [state.activeEnvironment]: {
            ...p.environments[state.activeEnvironment],
            nodes,
          },
        };
        return { ...updated, environments: envs };
      });
      return { ...state, projects };
    }

    default:
      return state;
  }
}

// ─── Initial state ────────────────────────────────────────────────────────────
// Starts empty, not seeded with mockProjects: the app is gated behind
// AuthGate, so nothing renders this before a real account's projects load.
// mockProjects is still used as a last-resort fallback if the API load
// itself fails after login (see the getProjects().catch() below).

const initialState: AppState = {
  projects: [],
  activeProjectId: null,
  draftProject: createDefaultDraftProject('aws', 10000),
  activeView: 'dashboard',
  activeCanvasMode: 'architecture',
  activeEnvironment: 'production',
  sidebarCollapsed: false,
  mobileSidebarOpen: false,
  providerFilter: 'all',
  architectureVersion: 0,
  lastSavedVersion: 0,
  autoSaveStatus: 'saved',
  lastSavedTime: 'Just now',
  saveConflict: null,
  displayCurrency: 'USD',
  canvasKey: 0,
  apiLoaded: false,
  currentUser: null,
  isLoginModalOpen: false,
  sessionChecked: false,
};

// ─── Context ──────────────────────────────────────────────────────────────────

const AppContext = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(null);

// ─── Service reference (injectable for testing) ───────────────────────────────
// Default: ApiArchitectureService (HTTP-backed). No in-memory fallback exists —
// see IArchitectureService in ArchitectureService.ts. Overridable below for tests.

let _activeService: IArchitectureService = apiArchitectureService;

/** Override the active architecture service (e.g. in tests). */
export function setArchitectureService(svc: IArchitectureService): void {
  _activeService = svc;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Keep a stable ref to state so side-effect callbacks can read current state
  // without needing to be recreated on every render.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // ── Sync active project ID & currency to all API-backed services ──────────
  // This is the single source-of-truth sync: whenever AppContext's activeProjectId
  // or currency changes, we notify all API services.
  useEffect(() => {
    setSecurityProjectId(state.activeProjectId);
    setSecurityEnvironment(state.activeEnvironment);
    setCostProjectId(state.activeProjectId);
    setCostEnvironment(state.activeEnvironment);
    setActiveCurrency(state.displayCurrency);
    setTerraformProjectId(state.activeProjectId);
    setTerraformEnvironment(state.activeEnvironment);
    setAdvisorProjectId(state.activeProjectId);
    setAdvisorEnvironment(state.activeEnvironment);
    setWaProjectId(state.activeProjectId);
    setWaEnvironment(state.activeEnvironment);
  }, [state.activeProjectId, state.activeEnvironment, state.displayCurrency]);

  // ── On mount: restore saved currency preference ────────────────────────────
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('cloudcraft_display_currency');
        if (saved) {
          dispatch({ type: 'SET_CURRENCY', currency: saved });
        }
      } catch {}
    }
  }, []);

  // ── On mount: restore user session ─────────────────────────────────────────
  useEffect(() => {
    fetch('/api/auth/session', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.data?.user) {
          dispatch({ type: 'SET_USER', user: data.data.user });
        }
      })
      .catch(() => {})
      .finally(() => {
        dispatch({ type: 'SET_SESSION_CHECKED' });
      });
  }, []);

  // ── After login: load this account's projects from the API ─────────────────
  // Gated on currentUser (not just mount) and keyed off their id: runs again
  // whenever someone logs in, logs out, or a different account signs in on
  // the same tab, so a fresh account never inherits a stale fetch that ran
  // before authentication resolved.
  useEffect(() => {
    if (!state.currentUser) return;
    let cancelled = false;
    _activeService.getProjects().then((projects) => {
      if (!cancelled) {
        dispatch({ type: '_LOAD_PROJECTS', projects });
      }
    }).catch(() => {
      // API unavailable — fall back to demo data so the UI isn't empty,
      // mark loaded
      if (!cancelled) {
        dispatch({ type: '_LOAD_PROJECTS', projects: mockProjects });
      }
    });
    return () => { cancelled = true; };
  }, [state.currentUser?.id]);

  // ── After login: restore this account's draft from backend or localStorage ─
  useEffect(() => {
    if (!state.currentUser) return;
    const userId = state.currentUser.id;
    let cancelled = false;
    async function initDraft() {
      let loadedFromBackend = false;
      if (_activeService.loadDraft) {
        try {
          const backendDraft = await _activeService.loadDraft();
          if (!cancelled && backendDraft && Array.isArray(backendDraft.nodes) && backendDraft.nodes.length > 0) {
            dispatch({
              type: 'LOAD_DURABLE_DRAFT',
              draft: backendDraft,
            });
            loadedFromBackend = true;
          }
        } catch {}
      }

      // If the backend has no draft for this account, fall back to this
      // account's own local cache — never another account's cached key.
      if (!loadedFromBackend && typeof window !== 'undefined') {
        try {
          const cachedDraft = localStorage.getItem(draftStorageKey(userId));
          if (cachedDraft) {
            const parsed = JSON.parse(cachedDraft);
            if (!cancelled && parsed && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
              dispatch({
                type: 'LOAD_DURABLE_DRAFT',
                draft: parsed,
              });
            }
          }
        } catch {}
      }
    }
    initDraft();
    return () => { cancelled = true; };
  }, [state.currentUser?.id]);

  // ── Mirror mutations to the API (fire-and-forget) ───────────────────────────
  // We use a ref to the previous action so we can react after state settles.
  // Queue (not a single "last action" ref): callers often dispatch several
  // actions synchronously (e.g. SET_ACTIVE_PROJECT then SET_VIEW). With a single
  // ref only the last one's side effect ran, so opening a project from the
  // sidebar or dashboard never loaded its canvas.
  const pendingActionsRef = useRef<Action[]>([]);

  const dispatchWithSideEffect = React.useCallback((action: Action) => {
    pendingActionsRef.current.push(action);
    dispatch(action);
  }, []);

  // After each render triggered by dispatchWithSideEffect, sync to API.
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const saveInFlightRef = useRef<boolean>(false);
  const pendingSaveRef = useRef<boolean>(false);
  const saveSeqRef = useRef<number>(0);

  const triggerAutoSave = React.useCallback((immediate = false) => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    const performSave = async () => {
      if (saveInFlightRef.current) {
        pendingSaveRef.current = true;
        return;
      }
      saveInFlightRef.current = true;
      pendingSaveRef.current = false;
      const seq = ++saveSeqRef.current;

      const currentState = stateRef.current;
      const isDraft = !currentState.activeProjectId || currentState.activeProjectId === 'draft-project';
      dispatch({ type: 'SET_AUTO_SAVE_STATUS', status: 'saving' });

      try {
        if (isDraft) {
          // 1. Persist draft to local storage as offline cache
          if (typeof window !== 'undefined') {
            try {
              localStorage.setItem(draftStorageKey(currentState.currentUser?.id), JSON.stringify(currentState.draftProject));
              localStorage.setItem(draftTimestampKey(currentState.currentUser?.id), Date.now().toString());
            } catch (err) {
              console.warn('LocalStorage draft save error:', err);
            }
          }
          // 2. Persist to backend draft service
          let backendRev: number | undefined;
          if (_activeService.saveDraft) {
            const res = await _activeService.saveDraft(currentState.draftProject, currentState.draftProject.revision);
            if (res && res.revision) {
              backendRev = res.revision;
            }
          }
          if (seq !== saveSeqRef.current) {
            // Drop stale response
            return;
          }
          if (backendRev) {
            dispatch({ type: 'UPDATE_DRAFT_REVISION', revision: backendRev });
          }
          const nowFormatted = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          dispatch({
            type: 'SET_AUTO_SAVE_STATUS',
            status: 'saved',
            lastSavedTime: nowFormatted,
            saveConflict: null,
          });
        } else {
          // Persist active project to backend
          const project = currentState.projects.find((p) => p.id === currentState.activeProjectId);
          if (!project) return;
          const currentRevision = project.revision ?? 1;

          const res = await _activeService.saveCanvas(
            project.id,
            project.nodes,
            project.edges,
            currentState.activeEnvironment,
            currentRevision,
            project.scaleProfile
          );
          if (seq !== saveSeqRef.current) {
            // Drop stale response
            return;
          }
          if (res && res.revision) {
            dispatch({ type: 'UPDATE_PROJECT_REVISION', projectId: project.id, revision: res.revision });
          }
          // Broadcast to other browser tabs
          if (typeof window !== 'undefined') {
            try {
              localStorage.setItem('cloudcraft_tab_sync', JSON.stringify({
                projectId: project.id,
                env: currentState.activeEnvironment,
                revision: res?.revision || currentRevision + 1,
                timestamp: Date.now(),
              }));
            } catch {}
          }
          const nowFormatted = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          dispatch({
            type: 'SET_AUTO_SAVE_STATUS',
            status: 'saved',
            lastSavedTime: nowFormatted,
            saveConflict: null,
          });
        }
      } catch (error: any) {
        if (seq !== saveSeqRef.current) return;
        console.error('AutoSave failed:', error);
        const isConflict = error?.status === 409 || error?.code === 'CONFLICT' || error?.message?.includes('conflict');
        dispatch({
          type: 'SET_AUTO_SAVE_STATUS',
          status: 'error',
          saveConflict: isConflict ? {
            serverRevision: error?.serverRevision || 0,
            clientRevision: error?.clientRevision || 0,
            message: error?.message || 'A newer version was saved elsewhere. Please reload or overwrite.',
          } : null,
        });
      } finally {
        saveInFlightRef.current = false;
        if (pendingSaveRef.current) {
          pendingSaveRef.current = false;
          triggerAutoSave(true);
        }
      }
    };

    if (immediate) {
      performSave();
    } else {
      autoSaveTimerRef.current = setTimeout(performSave, 800);
    }
  }, []);

  // ── Online listener: flush queued auto-saves when coming online ────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOnline = () => {
      triggerAutoSave(true);
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [triggerAutoSave]);

  // ── Multi-tab sync: listen for changes made in other browser tabs ──────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'cloudcraft_tab_sync' && e.newValue) {
        try {
          const syncData = JSON.parse(e.newValue);
          if (syncData.projectId === stateRef.current.activeProjectId) {
            _activeService.loadCanvas(syncData.projectId, syncData.env || stateRef.current.activeEnvironment).then((canvas) => {
              if (canvas) {
                dispatch({
                  type: 'SET_ENVIRONMENT_CANVAS',
                  env: syncData.env || stateRef.current.activeEnvironment,
                  nodes: canvas.nodes ?? [],
                  edges: canvas.edges ?? [],
                  revision: canvas.revision,
                });
              }
            }).catch(() => {});
          }
        } catch {}
      } else if (e.key === draftStorageKey(stateRef.current.currentUser?.id) && (!stateRef.current.activeProjectId || stateRef.current.activeProjectId === 'draft-project')) {
        try {
          if (e.newValue) {
            const parsed = JSON.parse(e.newValue);
            if (parsed && Array.isArray(parsed.nodes)) {
              dispatch({ type: 'LOAD_DURABLE_DRAFT', draft: parsed });
            }
          }
        } catch {}
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // ── BeforeUnload listener: warn if save is in-flight ─────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (stateRef.current.autoSaveStatus === 'saving' || stateRef.current.autoSaveStatus === 'unsaved') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    const queue = pendingActionsRef.current.splice(0);
    if (queue.length === 0) return;

    const currentState = stateRef.current;

    for (const action of queue) {
    switch (action.type) {
      case 'SAVE_NOW': {
        triggerAutoSave(true);
        break;
      }

      case 'CREATE_PROJECT': {
        // Find the optimistically created project (it was just pushed to state)
        const created = currentState.projects[currentState.projects.length - 1];
        if (!created) break;
        const localId = created.id;
        const initialNodes = action.nodes ?? created.nodes ?? [];
        const initialEdges = action.edges ?? created.edges ?? [];
        _activeService.createProject(action.name, action.provider).then(async (apiProject) => {
          // Persist the canvas to backend if initial nodes or edges exist
          if (initialNodes.length > 0 || initialEdges.length > 0) {
            await _activeService.saveCanvas(apiProject.id, initialNodes, initialEdges, 'production', 1, created.scaleProfile).catch(() => {});
          }
          const mergedProject: Project = {
            ...apiProject,
            nodes: initialNodes,
            edges: initialEdges,
            resourceCount: initialNodes.length,
            scaleProfile: created.scaleProfile,
            providerMode: created.providerMode,
            environments: {
              ...apiProject.environments,
              production: {
                ...apiProject.environments?.production,
                id: 'production',
                label: 'Production',
                region: apiProject.region,
                nodes: initialNodes,
                edges: initialEdges,
              },
            },
          };
          // Replace the local placeholder with the API-returned project merged with initial template content
          dispatch({ type: '_REPLACE_PROJECT', localId, project: mergedProject });
        }).catch(() => {
          // API unavailable — keep the optimistic local project as-is
        });
        break;
      }

      case 'SET_ACTIVE_PROJECT': {
        if (!action.id || action.id === 'draft-project') break;
        const targetProj = currentState.projects.find((p) => p.id === action.id);
        if (targetProj && targetProj.nodes.length === 0) {
          _activeService.loadCanvas(action.id, currentState.activeEnvironment).then((canvas) => {
            if (canvas && (canvas.nodes?.length > 0 || canvas.edges?.length > 0)) {
              dispatch({
                type: 'SET_ENVIRONMENT_CANVAS',
                env: currentState.activeEnvironment,
                nodes: canvas.nodes ?? [],
                edges: canvas.edges ?? [],
                revision: canvas.revision,
              });
            }
          }).catch(() => {});
        }
        break;
      }

      case 'DELETE_PROJECT': {
        _activeService.deleteProject(action.id).catch(() => {});
        break;
      }

      case 'SAVE_PROJECT': {
        _activeService.saveProject(action.project).catch(() => {});
        break;
      }

      case 'UPDATE_CANVAS':
      case 'UPDATE_NODE_CONFIG':
      case 'FIX_SECURITY_ISSUE':
      case 'APPLY_COST_OPTIMIZATION':
      case 'SET_SCALE_PROFILE':
      case 'SET_PROVIDER_MODE':
      case 'CONFIRM_PROVIDER_MODE_CHANGE': {
        triggerAutoSave(false);
        break;
      }

      case 'PROMOTE_DRAFT_TO_PROJECT': {
        if (_activeService.clearDraft) {
          _activeService.clearDraft().catch(() => {});
        }
        if (typeof window !== 'undefined') {
          try { localStorage.removeItem(draftStorageKey(currentState.currentUser?.id)); } catch {}
        }
        break;
      }

      case 'RESOLVE_SAVE_CONFLICT': {
        if (action.resolution === 'overwrite') {
          triggerAutoSave(true);
        } else {
          if (currentState.activeProjectId && currentState.activeProjectId !== 'draft-project') {
            _activeService.loadCanvas(currentState.activeProjectId, currentState.activeEnvironment).then((canvas) => {
              if (canvas) {
                dispatch({
                  type: 'SET_ENVIRONMENT_CANVAS',
                  env: currentState.activeEnvironment,
                  nodes: canvas.nodes ?? [],
                  edges: canvas.edges ?? [],
                  revision: canvas.revision,
                });
              }
            }).catch(() => {});
          } else if (_activeService.loadDraft) {
            _activeService.loadDraft().then((draft) => {
              if (draft) {
                dispatch({ type: 'LOAD_DURABLE_DRAFT', draft });
              }
            }).catch(() => {});
          }
        }
        break;
      }

      default:
        break;
    }
    }
    // Deliberately depends on `state`: this effect's job is to mirror every
    // dispatched action exactly once (drained from pendingActionsRef above) to
    // the backend API. Actions are dispatched through
    // dispatchWithSideEffect, which records the action in a ref (not state) and
    // then calls the reducer — so the only reliable render-time signal that a
    // new action may be waiting to be processed is a state change. A narrower
    // dependency (e.g. only `triggerAutoSave`) makes this effect run once on
    // mount and never again, silently disabling API persistence for every
    // action handled above (CREATE_PROJECT, DELETE_PROJECT, SET_ACTIVE_PROJECT,
    // canvas autosave triggers, etc.) — do not narrow this back down.
  }, [state, triggerAutoSave]);

  return (
    <AppContext.Provider value={{ state, dispatch: dispatchWithSideEffect }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

export function useActiveProject(): Project | null {
  const { state } = useApp();
  if (state.activeProjectId && state.activeProjectId !== 'draft-project') {
    const found = state.projects.find((p) => p.id === state.activeProjectId);
    if (found) return found;
  }
  return state.draftProject;
}
