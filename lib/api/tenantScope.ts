/**
 * "Does this id belong to the caller's organisation?" for ids that arrive in a request BODY or QUERY STRING (environment ids,
 * architecture ids). A project id in a URL is checked by requireProjectAccess; these are the ids that route does not cover.
 *
 * An id proves nothing — anyone can paste any id — so a route that reads or writes by environment/architecture id must
 * resolve it through here first. "Not found" is the right answer for an id of another organisation (do not confirm it exists).
 */
import { environmentRepository, projectRepository } from '@/lib/repositories/projectRepository';
import { architectureRepository } from '@/lib/repositories/architectureRepository';

export interface EnvironmentScope { environmentId: string; projectId: string }

/**
 * Accepts an environment id, or a project id (meaning its production environment), and returns the environment only if its
 * project belongs to `orgId`.
 */
export async function resolveEnvironmentInOrg(idOrProjectId: string, orgId: string): Promise<EnvironmentScope | null> {
  if (!idOrProjectId || typeof idOrProjectId !== 'string') return null;
  const env = await environmentRepository.findById(idOrProjectId);
  if (env) return (await projectRepository.findById(env.projectId, orgId)) ? { environmentId: env.id, projectId: env.projectId } : null;
  const project = await projectRepository.findById(idOrProjectId, orgId);
  if (!project) return null;
  const production = await environmentRepository.findByKey(project.id, 'production');
  return production ? { environmentId: production.id, projectId: project.id } : null;
}

/** True only if the architecture belongs to a project of `orgId`. */
export async function architectureInOrg(architectureId: string, orgId: string): Promise<boolean> {
  if (!architectureId || typeof architectureId !== 'string') return false;
  const environmentId = await architectureRepository.environmentIdOf(architectureId);
  return !!environmentId && !!(await resolveEnvironmentInOrg(environmentId, orgId));
}
