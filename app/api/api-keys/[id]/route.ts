/** DELETE /api/api-keys/[id] — revoke a key of the caller's organization (administrators and owners). It stops working at once; the row stays so the list shows it. */
import { NextRequest } from 'next/server';
import { ok, forbidden, unauthorized, internalError, badRequest, notFound } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { canManageApiKeys, API_KEY_MANAGER_MESSAGE } from '@/lib/auth/apiKeyManagers';
import { PgApiKeyStore } from '@/lib/apiKeys/store';

export const dynamic = 'force-dynamic';

const store = new PgApiKeyStore();

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    if (!canManageApiKeys(identity.email)) return forbidden(API_KEY_MANAGER_MESSAGE);
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role || !['owner', 'admin'].includes(role)) return forbidden('Only an administrator can manage API keys.');
    return (await store.revoke(orgId, (await params).id)) ? ok({ revoked: true }) : notFound('API key');
  } catch (err) {
    console.error('[DELETE api-keys/:id]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
