/**
 * Puts a canvas that was just fetched from the API into a project of the list, without opening the project.
 *
 * The project list API returns only each project's details, not its resources, so every project starts with no nodes and the dashboard
 * would show 0 resources, $0.00 and "N/A" for all of them until each was opened. The app now fetches each project's canvas in the
 * background and applies it here. If the canvas belongs to the environment being viewed, the project's summary figures (resource count,
 * security, cost) are recomputed from it; the project's "last updated" time is kept, because loading is not an edit.
 */
import type { Project, CanvasNode, CanvasEdge, Environment, EnvironmentState } from '@/types';

export function applyLoadedCanvas(
  project: Project,
  env: Environment,
  activeEnvironment: Environment,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  revision: number | undefined,
  compute: (p: Project, nodes: CanvasNode[], edges: CanvasEdge[]) => Project,
): Project {
  const currentEnv = project.environments[env];
  const environments: Record<Environment, EnvironmentState> = {
    ...project.environments,
    [env]: {
      ...currentEnv,
      id: env,
      label: currentEnv?.label ?? env.charAt(0).toUpperCase() + env.slice(1),
      region: currentEnv?.region ?? project.region,
      nodes,
      edges,
    },
  };
  const revisionPatch = revision !== undefined ? { revision } : {};
  if (activeEnvironment === env) {
    return { ...compute(project, nodes, edges), ...revisionPatch, updatedAt: project.updatedAt, environments };
  }
  return { ...project, ...revisionPatch, environments };
}
