/**
 * What every release route checks first, in the same order the Terraform routes do: the feature is on, the caller is signed in, they may use the
 * restricted features and Terraform in this organization, and they are an owner or admin of the organization that owns the project.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { forbidden, notFound, serviceUnavailable, unauthorized } from '@/lib/api/response';
import { extractIdentity, type RequestIdentity } from '@/lib/api/auth';
import { requireProjectAccess } from '@/lib/api/projectAccess';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { projectReleasesEnabled, PROJECT_RELEASES_OFF } from './enabled';
import type { Release } from './types';
import type { ReleaseStore } from './releaseStore';

export type Gate = { ok: true; identity: RequestIdentity; orgId: string; projectId: string } | { ok: false; response: NextResponse };

export async function releaseGate(req: NextRequest, projectId: string): Promise<Gate> {
  if (!projectReleasesEnabled()) return { ok: false, response: serviceUnavailable(PROJECT_RELEASES_OFF) };
  const identity = extractIdentity(req);
  if (!identity) return { ok: false, response: unauthorized('Authentication required to deploy a project') };
  const access = await requireProjectAccess(req, identity.userId, projectId, { adminOnly: true });
  if ('response' in access) return { ok: false, response: access.response };
  const denied = await terraformExecutionDenied(identity.userId, access.orgId, identity.email);
  if (denied) {
    await recordTerraformAudit({ action: 'release', outcome: 'denied', orgId: access.orgId, projectId, userId: identity.userId, detail: denied });
    return { ok: false, response: forbidden(denied) };
  }
  return { ok: true, identity, orgId: access.orgId, projectId };
}

/** The release of this project in this organization, or the "not found" response. A release of another project or organization is never confirmed to exist. */
export async function findRelease(store: ReleaseStore, gate: Extract<Gate, { ok: true }>, releaseId: string): Promise<Release | NextResponse> {
  const r = await store.get(releaseId);
  if (!r || r.orgId !== gate.orgId || r.projectId !== gate.projectId) return notFound('Release');
  return r;
}

/** What the browser is shown of a release: never the settings it was generated from, the compose file or the account. */
export function publicRelease(r: Release) {
  return {
    id: r.id, project: r.project, environment: r.environment, target: r.target, imageTag: r.imageTag, status: r.status, steps: r.steps,
    outputs: r.outputs ? { url: r.outputs.url, resourceGroup: r.outputs.resourceGroup, vmName: r.outputs.vmName } : null,
    error: r.error, log: r.log, secrets: r.secrets, built: r.built, ownCode: Object.keys(r.sources ?? {}), bundleHash: r.bundleHash, planId: r.planId, planHash: r.planHash,
    previousReleaseId: r.previousReleaseId, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}
