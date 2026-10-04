/**
 * GET    /api/cloud-accounts/[id]   — get a single cloud account (no credentials)
 * DELETE /api/cloud-accounts/[id]   — disconnect/remove a cloud account
 */
import { NextRequest } from 'next/server';
import {
  ok, notFound, forbidden, unauthorized, internalError,
} from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id } = await ctx.params;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return forbidden();

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const account = await cloudAccountRepository.findById(id, orgId);
    if (!account) return notFound('CloudAccount');

    return ok(account);
  } catch (err) {
    console.error('[GET /api/cloud-accounts/[id]]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id } = await ctx.params;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return forbidden();

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    if (!['owner', 'admin'].includes(role)) return forbidden('Only owners and admins can remove cloud accounts');

    const deleted = await cloudAccountRepository.delete(id, orgId);
    if (!deleted) return notFound('CloudAccount');
    console.info(`[cloud-account] removed ${id} from org ${orgId} by user ${identity.userId}`);   // ids only, never credentials

    return ok({ deleted: true });
  } catch (err) {
    console.error('[DELETE /api/cloud-accounts/[id]]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
