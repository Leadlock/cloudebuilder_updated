'use client';
import React, { createContext, useContext, useReducer, ReactNode, useEffect, useRef } from 'react';
import {
  Project, CanvasNode, CanvasEdge, CloudProvider, AppView, Environment,
  Region, ArchitectureVersion, EnvironmentState, CanvasViewMode
} from '@/types';
import { mockProjects } from '@/lib/mockData';
import { runSecurityScan, calculateSecurityScore, calculateCosts } from '@/lib/analysis';
import { scoreArchitecture } from '@/lib/generator';
import { v4 as uuidv4 } from 'uuid';
import { applyRuleRemediation } from '@/lib/engines/security/remediation';
import { apiArchitectureService } from '@/lib/services/ApiArchitectureService';
import type { IArchitectureService } from '@/lib/services/ArchitectureService';
import { setActiveProjectId as setSecurityProjectId, setActiveEnvironment as setSecurityEnvironment } from '@/lib/services/ApiSecurityService';
import { setActiveProjectId as setCostProjectId, setActiveEnvironment as setCostEnvironment, setActiveCurrency } from '@/lib/services/ApiCostService';
import { setActiveProjectId as setTerraformProjectId, setActiveEnvironment as setTerraformEnvironment } from '@/lib/services/ApiTerraformService';
import { setActiveProjectId as setAdvisorProjectId, setActiveEnvironment as setAdvisorEnvironment } from '@/lib/services/ApiAdvisorService';
import { setActiveProjectId as setWaProjectId, setActiveEnvironment as setWaEnvironment } from '@/lib/services/ApiWellArchitectedService';
// MockArchitectureService remains available via @/lib/services (architectureService export)

import type { AuthUser } from '@/lib/api/authService';

export interface AppState {
  projects: Project[];
  activeProjectId: string | null;
  activeView: AppView;
  activeCanvasMode: CanvasViewMode;
  activeEnvironment: Environment;
  sidebarCollapsed: boolean;
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
}

type Action =
  | { type: 'SET_VIEW'; view: AppView }
  | { type: 'SET_CANVAS_MODE'; mode: CanvasViewMode }
  | { type: 'SET_ACTIVE_PROJECT'; id: string | null }
  | { type: 'SET_CURRENCY'; currency: string }
  | { type: 'UPDATE_CANVAS'; nodes: CanvasNode[]; edges: CanvasEdge[] }
  | { type: 'UPDATE_NODE_CONFIG'; nodeId: string; config: Record<string, unknown>; label: string }
  | { type: 'SAVE_PROJECT'; project: Project }
  | { type: 'CREATE_PROJECT'; provider: CloudProvider; name: string; nodes?: CanvasNode[]; edges?: CanvasEdge[] }
  | { type: 'DELETE_PROJECT'; id: string }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_ENVIRONMENT'; env: Environment }
  | { type: 'SET_REGION'; region: Region }
  | { type: 'SET_PROVIDER_FILTER'; filter: 'all' | 'aws' | 'azure' }
  | { type: 'CLONE_ENVIRONMENT'; from: Environment; to: Environment }
  | { type: 'PROMOTE_ENVIRONMENT'; from: Environment; to: Environment }
  | { type: 'SET_ENVIRONMENT_CANVAS'; env: Environment; nodes: CanvasNode[]; edges: CanvasEdge[] }
  | { type: 'RESTORE_VERSION'; versionId?: string; nodes?: CanvasNode[]; edges?: CanvasEdge[] }
  | { type: 'SAVE_VERSION'; summary: string }
  | { type: 'FIX_SECURITY_ISSUE'; nodeId: string; ruleId: string }
  | { type: 'APPLY_COST_OPTIMIZATION'; optimizationId: string; nodeId?: string }
  | { type: 'SET_USER'; user: AuthUser | null }
  | { type: 'SET_LOGIN_MODAL'; open: boolean }
  /** Internal: replaces project list after API load */
  | { type: '_LOAD_PROJECTS'; projects: Project[] }
  /** Internal: replaces a single project returned by the API after create */
  | { type: '_REPLACE_PROJECT'; localId: string; project: Project };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeProject(p: Project, nodes: CanvasNode[], edges: CanvasEdge[]): Project {
  const issues = runSecurityScan(nodes);
  const securityScore = calculateSecurityScore(issues);
  const costs = calculateCosts(nodes);
  const estimatedMonthlyCost = costs.reduce((acc, c) => acc + c.monthlyCost, 0);
  const scores = scoreArchitecture(nodes, edges);
  return {
    ...p,
    nodes,
    edges,
    resourceCount: nodes.length,
    securityScore: Math.min(securityScore, scores.security),
    architectureScore: scores.overall,
    estimatedMonthlyCost,
    updatedAt: new Date().toISOString(),
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

// ─── Reducer ──────────────────────────────────────────────────────────────────

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, activeView: action.view };
    case 'SET_CANVAS_MODE':
      return { ...state, activeCanvasMode: action.mode };
    case 'SET_ACTIVE_PROJECT':
      return { ...state, activeProjectId: action.id };
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case 'SET_PROVIDER_FILTER':
      return { ...state, providerFilter: action.filter };
    case 'SET_USER':
      return { ...state, currentUser: action.user };
    case 'SET_LOGIN_MODAL':
      return { ...state, isLoginModalOpen: action.open };

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
      if (!state.activeProjectId) return { ...state, activeEnvironment: action.env };
      const projects = state.projects.map((p) => {
        if (p.id !== state.activeProjectId) return p;
        const envState = p.environments[action.env];
        const updated = computeProject(p, envState.nodes, envState.edges);
        return { ...updated, environment: action.env };
      });
      return { ...state, projects, activeEnvironment: action.env };
    }

    // ── UPDATE_CANVAS: sync nodes/edges for the active environment only ────────
    case 'UPDATE_CANVAS': {
      const projects = state.projects.map((p) => {
        if (p.id !== state.activeProjectId) return p;
        const updated = computeProject(p, action.nodes, action.edges);
        const envs: Record<Environment, EnvironmentState> = {
          ...p.environments,
          [state.activeEnvironment]: {
            ...p.environments[state.activeEnvironment],
            nodes: action.nodes,
            edges: action.edges,
          },
        };
        return { ...updated, environments: envs };
      });
      return { ...state, projects, architectureVersion: state.architectureVersion + 1 };
    }

    // ── UPDATE_NODE_CONFIG: update a single node's config and recompute ────────
    case 'UPDATE_NODE_CONFIG': {
      if (!state.activeProjectId) return state;
      const projects = state.projects.map((p) => {
        if (p.id !== state.activeProjectId) return p;
        const nodes = p.nodes.map((n) =>
          n.id === action.nodeId ? { ...n, config: action.config, label: action.label } : n
        );
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
      return { ...state, projects, architectureVersion: state.architectureVersion + 1 };
    }

    case 'SAVE_PROJECT': {
      const exists = state.projects.some((p) => p.id === action.project.id);
      return {
        ...state,
        projects: exists
          ? state.projects.map((p) => p.id === action.project.id ? action.project : p)
          : [...state.projects, action.project],
        lastSavedVersion: state.architectureVersion,
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
        securityScore: 100,
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
        if (state.activeEnvironment === action.env) {
          const updated = computeProject(p, action.nodes, action.edges);
          return { ...updated, environments: envs };
        }
        return { ...p, environments: envs };
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
        const nodes = p.nodes.map((n) => {
          if (n.id !== action.nodeId) return n;
          return { ...n, config: applyRuleRemediation(n.config, action.ruleId) };
        });
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
// mockProjects seed the UI immediately; they are replaced by API data on mount.

const initialState: AppState = {
  projects: mockProjects,
  activeProjectId: null,
  activeView: 'dashboard',
  activeCanvasMode: 'architecture',
  activeEnvironment: 'production',
  sidebarCollapsed: false,
  providerFilter: 'all',
  architectureVersion: 0,
  lastSavedVersion: 0,
  displayCurrency: 'USD',
  canvasKey: 0,
  apiLoaded: false,
  currentUser: {
    id: 'usr-admin-1',
    email: 'admin@cloudcraft.io',
    name: 'Cloud Administrator',
    role: 'admin',
    orgId: 'org-cloudcraft-prod',
  },
  isLoginModalOpen: false,
};

// ─── Context ──────────────────────────────────────────────────────────────────

const AppContext = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(null);

// ─── Service reference (injectable for testing) ───────────────────────────────
// Default: ApiArchitectureService (HTTP-backed). Falls back to mock on error.
// The mock service (architectureService from ArchitectureService.ts) remains
// available for fallback and testing.

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
        if (data?.user) {
          dispatch({ type: 'SET_USER', user: data.user });
        }
      })
      .catch(() => {});
  }, []);

  // ── On mount: load projects from the API ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    _activeService.getProjects().then((projects) => {
      if (!cancelled) {
        dispatch({ type: '_LOAD_PROJECTS', projects });
      }
    }).catch(() => {
      // API unavailable — keep mockProjects already in state, mark loaded
      if (!cancelled) {
        dispatch({ type: '_LOAD_PROJECTS', projects: mockProjects });
      }
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mirror mutations to the API (fire-and-forget) ───────────────────────────
  // We use a ref to the previous action so we can react after state settles.
  const lastActionRef = useRef<Action | null>(null);

  const dispatchWithSideEffect = React.useCallback((action: Action) => {
    lastActionRef.current = action;
    dispatch(action);
  }, []);

  // After each render triggered by dispatchWithSideEffect, sync to API.
  // We track the last processed action to avoid re-running.
  const processedActionRef = useRef<Action | null>(null);
  const canvasSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const action = lastActionRef.current;
    if (!action || action === processedActionRef.current) return;
    processedActionRef.current = action;

    const currentState = stateRef.current;

    switch (action.type) {
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
            await _activeService.saveCanvas(apiProject.id, initialNodes, initialEdges, 'production').catch(() => {});
          }
          const mergedProject: Project = {
            ...apiProject,
            nodes: initialNodes,
            edges: initialEdges,
            resourceCount: initialNodes.length,
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
        if (!action.id) break;
        const targetProj = currentState.projects.find((p) => p.id === action.id);
        if (targetProj && targetProj.nodes.length === 0) {
          _activeService.loadCanvas(action.id, currentState.activeEnvironment).then((canvas) => {
            if (canvas && (canvas.nodes?.length > 0 || canvas.edges?.length > 0)) {
              dispatch({
                type: 'SET_ENVIRONMENT_CANVAS',
                env: currentState.activeEnvironment,
                nodes: canvas.nodes ?? [],
                edges: canvas.edges ?? [],
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

      case 'UPDATE_CANVAS': {
        if (!currentState.activeProjectId) break;
        if (canvasSaveTimerRef.current) {
          clearTimeout(canvasSaveTimerRef.current);
        }
        const projId = currentState.activeProjectId;
        const env = currentState.activeEnvironment;
        const nodes = action.nodes;
        const edges = action.edges;
        canvasSaveTimerRef.current = setTimeout(() => {
          _activeService.saveCanvas(
            projId,
            nodes,
            edges,
            env,
          ).catch(() => {});
        }, 400);
        break;
      }

      case 'UPDATE_NODE_CONFIG':
      case 'FIX_SECURITY_ISSUE': {
        if (!currentState.activeProjectId) break;
        const project = currentState.projects.find((p) => p.id === currentState.activeProjectId);
        if (!project) break;
        _activeService.saveCanvas(
          currentState.activeProjectId,
          project.nodes,
          project.edges,
          currentState.activeEnvironment,
        ).catch(() => {});
        break;
      }

      default:
        break;
    }
  });

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

export function useActiveProject() {
  const { state } = useApp();
  return state.projects.find((p) => p.id === state.activeProjectId) ?? null;
}
