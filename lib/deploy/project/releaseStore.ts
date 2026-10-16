/**
 * Where releases are kept. An interface so the orchestrator is tested with the in-memory store; the database one (a table next to the Terraform
 * approvals) comes with the API routes.
 */
import type { Release } from './types';

export interface ReleaseStore {
  get(id: string): Promise<Release | null>;
  /** Creates or replaces a release. */
  save(release: Release): Promise<void>;
  /** The most recent release of this project and environment that succeeded: the rollback target, and what is running. */
  latestSucceeded(projectId: string, environment: string): Promise<Release | null>;
}

export class InMemoryReleaseStore implements ReleaseStore {
  private readonly rows = new Map<string, Release>();
  async get(id: string) { const r = this.rows.get(id); return r ? structuredClone(r) : null; }
  async save(release: Release) { this.rows.set(release.id, structuredClone(release)); }
  async latestSucceeded(projectId: string, environment: string) {
    const all = [...this.rows.values()].filter((r) => r.projectId === projectId && r.environment === environment && r.status === 'succeeded');
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return all[0] ? structuredClone(all[0]) : null;
  }
}
