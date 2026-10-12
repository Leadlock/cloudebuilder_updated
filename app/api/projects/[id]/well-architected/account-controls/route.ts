/**
 * GET  /api/projects/[id]/well-architected/account-controls  — the latest readings of the account's own controls
 * POST /api/projects/[id]/well-architected/account-controls  — read them now from a connected AWS account  { cloudAccountId, regions? }
 *
 * Checks CloudTrail, GuardDuty, root-account MFA and AWS Config with read-only calls. The reading is stored with its date and
 * feeds the review for a week; a control that cannot be read is stored as "unavailable" and is never counted as a pass.
 *
 * Auth: extractIdentity + org membership; running a check needs the owner, admin or member role.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, tooManyRequests, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { accountControlEvidenceRepository } from '@/lib/repositories/accountControlEvidenceRepository';
import { credentialsExpiredResponse } from '@/lib/api/credentialErrors';
import { createDiscoveryProvider } from '@/lib/cloud/provider';
import type { CloudCredentials } from '@/lib/cloud/types';
import { ACCOUNT_CONTROL_PERMISSIONS } from '@/lib/cloud/accountControls/readAwsAccountControls';

export const dynamic = 'force-dynamic';

const CheckSchema = z.object({
  cloudAccountId: z.string().min(1).max(100),
  regions: z.array(z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/)).max(20).optional(),
});

async function authorise(req: NextRequest, projectId: string, write: boolean) {
  const identity = extractIdentity(req);
  if (!identity) return { response: unauthorized() };
  const orgId = await resolveOrgId(req, identity.userId);
  if (!orgId) return { response: badRequest('orgId required') };
  const role = await getOrgRole(identity.userId, orgId);
  if (!role) return { response: forbidden() };
  if (write && !['owner', 'admin', 'member'].includes(role)) return { response: forbidden('Insufficient permissions') };
  const project = await projectRepository.findById(projectId, orgId);
  if (!project) return { response: notFound('Project') };
  return { identity, orgId, project };
}

async function payload(projectId: string) {
  return { controls: await accountControlEvidenceRepository.list(projectId), permissions: ACCOUNT_CONTROL_PERMISSIONS };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const auth = await authorise(req, projectId, false);
    if ('response' in auth) return auth.response;
    return ok(await payload(projectId));
  } catch (err) {
    console.error('[GET /api/projects/:id/well-architected/account-controls]', err instanceof Error ? err.message : err);
    return internalError();
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const auth = await authorise(req, projectId, true);
    if ('response' in auth) return auth.response;

    const rl = await checkRateLimit(`${auth.identity.userId}:wa-account-check`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const parsed = await parseBody(req, CheckSchema);
    if (!parsed.ok) return parsed.response;

    const account = await cloudAccountRepository.findById(parsed.data.cloudAccountId, auth.orgId);
    if (!account) return notFound('CloudAccount');
    if (account.provider !== 'aws') return badRequest('Account checks are available for AWS accounts only');

    const credentialsJson = await cloudAccountRepository.getCredentials(account.id, auth.orgId);
    if (!credentialsJson) return notFound('CloudAccount credentials');
    let credentials: CloudCredentials;
    try {
      credentials = JSON.parse(credentialsJson) as CloudCredentials;
    } catch {
      return internalError('Stored credentials are malformed');
    }

    const provider = await createDiscoveryProvider(credentials);
    try {
      if (typeof provider.readAccountControls !== 'function') return badRequest('This account type cannot be checked');
      const results = await provider.readAccountControls(parsed.data.regions ?? []);
      await accountControlEvidenceRepository.saveCheck(projectId, { cloudAccountId: account.id, accountLabel: account.name, userId: auth.identity.userId }, results);
    } finally {
      await provider.dispose();
    }
    return ok(await payload(projectId));
  } catch (err) {
    const expired = credentialsExpiredResponse(err);
    if (expired) return expired;
    console.error('[POST /api/projects/:id/well-architected/account-controls]', err instanceof Error ? err.message : err);
    return internalError();
  }
}
