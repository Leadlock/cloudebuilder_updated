/**
 * /api/architecture-templates/[id]
 *
 * GET    — one template with its graph (any member): a built-in one, or one of the caller's organization.
 * DELETE — remove one of the organization's own templates (admins and owners, or the member who saved it). A built-in template cannot be deleted here.
 */
import { NextRequest } from 'next/server';
import { ok, forbidden, unauthorized, internalError, badRequest, notFound } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { PgTemplateStore } from '@/lib/templates/templateStore';

export const dynamic = 'force-dynamic';

const store = new PgTemplateStore();

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    if (!(await getOrgRole(identity.userId, orgId))) return forbidden();
    const t = await store.get(orgId, (await params).id);
    return t ? ok({ template: t }) : notFound('Template');
  } catch (err) {
    console.error('[GET architecture-templates/:id]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id } = await params;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    const owner = await store.ownerOf(orgId, id);
    if (owner === undefined) return notFound('Template');           // not one of this organization's: a built-in one is not deletable here
    const mine = owner !== null && (owner === identity.email || owner === identity.userId);
    if (!(role === 'owner' || role === 'admin' || mine)) return forbidden('Only an administrator or the person who saved a template can delete it.');
    await store.deleteOwn(orgId, id);
    return ok({ deleted: true });
  } catch (err) {
    console.error('[DELETE architecture-templates/:id]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
