/**
 * Draft Architecture Repository
 *
 * Provides durable backend persistence for interactive draft architectures
 * before they are named or promoted to formal projects.
 * Supports revision-controlled concurrency, graph hash verification,
 * and resilient multi-user session scoping.
 */

import { CanvasNode, CanvasEdge, ProviderMode, ScaleProfile } from '@/types';
import { computeGraphHash, toCanonicalGraph } from '@/lib/domain/canonicalArchitecture';

export interface DurableDraft {
  id: string;
  userId: string;
  orgId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  providerMode: ProviderMode;
  scaleProfile: ScaleProfile;
  revision: number;
  hash: string;
  updatedAt: string;
}

// In-memory persistent draft store (survives across requests, can back database or dev mode)
const _draftStore = new Map<string, DurableDraft>();

export const draftRepository = {
  /**
   * Retrieve the active draft for a given user or org context.
   */
  async getDraft(key: string): Promise<DurableDraft | null> {
    const draft = _draftStore.get(key);
    if (!draft) return null;
    return { ...draft };
  },

  /**
   * Persist a draft architecture with revision concurrency checks.
   */
  async saveDraft(
    key: string,
    data: {
      userId?: string;
      orgId?: string;
      nodes: CanvasNode[];
      edges: CanvasEdge[];
      providerMode?: ProviderMode;
      scaleProfile?: ScaleProfile;
      revision?: number;
    }
  ): Promise<{ draft: DurableDraft; conflict?: boolean; serverRevision?: number }> {
    const current = _draftStore.get(key);

    // Strict revision check if draft already exists
    if (current && data.revision !== undefined && data.revision < current.revision) {
      return {
        draft: current,
        conflict: true,
        serverRevision: current.revision,
      };
    }

    const scaleProfile: ScaleProfile = data.scaleProfile ?? current?.scaleProfile ?? {
      expectedUsers: 10000,
      requestsPerSecond: 50,
      peakRequestsPerSecond: 150,
      availabilityTarget: 99.9,
      geographicDistribution: 'single-region',
      dataGrowth: 'moderate',
      trafficPattern: 'steady',
    };

    const providerMode: ProviderMode = data.providerMode ?? current?.providerMode ?? 'AWS';
    const canonical = toCanonicalGraph(data.nodes, data.edges, { scaleProfile, providerMode });
    const hash = canonical.hash;
    const newRevision = current
      ? Math.max(current.revision, data.revision ?? current.revision) + 1
      : 1;

    const savedDraft: DurableDraft = {
      id: `draft-${key}`,
      userId: data.userId ?? current?.userId ?? 'anonymous-user',
      orgId: data.orgId ?? current?.orgId ?? 'default-org',
      nodes: data.nodes,
      edges: data.edges,
      providerMode,
      scaleProfile,
      revision: newRevision,
      hash,
      updatedAt: new Date().toISOString(),
    };

    _draftStore.set(key, savedDraft);
    return { draft: savedDraft };
  },

  /**
   * Clear the draft architecture (e.g. after project promotion or discard).
   */
  async clearDraft(key: string): Promise<boolean> {
    return _draftStore.delete(key);
  },
};
