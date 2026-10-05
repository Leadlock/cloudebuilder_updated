/**
 * POST /api/cloud-accounts/[id]/lifetime — change how long CloudCraft keeps an account's credentials, without sending the key again.
 *
 *   { action: 'extend', hours: 8 | null }        keep for that long from now (null: no time limit)
 *   { action: 'forgetAfterDeploy', value: bool } erase the credentials after the next successful deployment
 *   { action: 'erase' }                          erase the credentials now (the account stays listed, marked expired)
 *
 * Only an owner or admin may do this. Nothing secret is returned.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { credentialsExpiredResponse } from '@/lib/api/credentialErrors';
import { MAX_LIFETIME_HOURS } from '@/lib/cloud/credentialLifetime';

export const dynamic = 'force-dynamic';

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('extend'), hours: z.number().positive().max(MAX_LIFETIME_HOURS).nullable() }).strict(),
  z.object({ action: z.literal('forgetAfterDeploy'), value: z.boolean() }).strict(),
  z.object({ action: z.literal('erase') }).strict(),
]);

export async function POST(req: NextRequest, ctx: { params: Promise<Record<string, string>> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id } = await ctx.params;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return forbidden();
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    if (!['owner', 'admin'].includes(role)) return forbidden('Only owners and admins can change how long credentials are kept');

    let raw: unknown;
    try { raw = await req.json(); } catch { return badRequest('Invalid JSON body'); }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) return badRequest('Choose what to do: extend, forgetAfterDeploy or erase.');

    if (!(await cloudAccountRepository.belongsToOrg(id, orgId))) return notFound('CloudAccount');

    if (parsed.data.action === 'erase') {
      await cloudAccountRepository.wipeCredentials(id, orgId, 'removed');
      console.info(`[cloud-account] credentials of ${id} erased in org ${orgId} by user ${identity.userId}`);   // ids only
      return ok(await cloudAccountRepository.findById(id, orgId));
    }

    const result = await cloudAccountRepository.changeLifetime(id, orgId, parsed.data.action === 'extend'
      ? { action: 'extend', hours: parsed.data.hours }
      : { action: 'forgetAfterDeploy', value: parsed.data.value });
    if (!result) return notFound('CloudAccount');
    if (!result.ok) return badRequest(result.message);
    console.info(`[cloud-account] lifetime of ${id} changed (${parsed.data.action}) in org ${orgId} by user ${identity.userId}`);
    return ok(result.account);
  } catch (err) {
    const expired = credentialsExpiredResponse(err);
    if (expired) return expired;
    console.error('[POST /api/cloud-accounts/[id]/lifetime]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
