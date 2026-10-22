/**
 * /api/architecture-templates/[id]/listing — what the caller's organization wrote about a template for the Neozaar marketplace export:
 * the business problem, outcomes, price, audience, segments, industries, CTA, regions, category. Anything left out falls back to the category's defaults.
 *
 * GET    — the listing and the Neozaar request it produces, with what is still missing (any member).
 * PUT    — write it (administrators and owners). The body is the listing; values for the form's choice lists must be ones the form offers.
 * DELETE — remove it, so the defaults apply again (administrators and owners).
 */
import { NextRequest } from 'next/server';
import { ok, forbidden, unauthorized, internalError, badRequest, notFound, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { PgTemplateStore } from '@/lib/templates/templateStore';
import { PgListingStore } from '@/lib/marketplace/listingStore';
import { ListingSchema } from '@/lib/marketplace/listingSchema';
import { toNeozaarService } from '@/lib/marketplace/neozaar';
import { publicTemplate } from '@/lib/apiKeys/publicTemplate';

export const dynamic = 'force-dynamic';

const templates = new PgTemplateStore();
const listings = new PgListingStore();
const ADMIN = new Set(['owner', 'admin']);

async function context(req: NextRequest, id: string, write: boolean) {
  const identity = extractIdentity(req);
  if (!identity) return { response: unauthorized() };
  const orgId = await resolveOrgId(req, identity.userId);
  if (!orgId) return { response: badRequest('orgId required') };
  const role = await getOrgRole(identity.userId, orgId);
  if (!role) return { response: forbidden() };
  if (write && !ADMIN.has(role)) return { response: forbidden('Only an administrator can change a template\'s marketplace listing.') };
  const t = await templates.get(orgId, id);
  if (!t) return { response: notFound('Template') };
  return { identity, orgId, template: t };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const c = await context(req, (await params).id, false);
    if ('response' in c) return c.response;
    const saved = await listings.get(c.orgId, c.template.id);
    return ok({ listing: saved?.listing ?? null, updatedAt: saved?.updatedAt ?? null, neozaar: toNeozaarService(publicTemplate(c.template, c.template.graph), saved?.listing ?? {}) });
  } catch (err) {
    console.error('[GET template listing]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const c = await context(req, (await params).id, true);
    if ('response' in c) return c.response;
    const parsed = await parseBody(req, ListingSchema);
    if (!parsed.ok) return parsed.response;
    await listings.put(c.orgId, c.template.id, parsed.data, c.identity.email ?? c.identity.userId);
    return ok({ listing: parsed.data, neozaar: toNeozaarService(publicTemplate(c.template, c.template.graph), parsed.data) });
  } catch (err) {
    console.error('[PUT template listing]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const c = await context(req, (await params).id, true);
    if ('response' in c) return c.response;
    return ok({ deleted: await listings.delete(c.orgId, c.template.id) });
  } catch (err) {
    console.error('[DELETE template listing]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
