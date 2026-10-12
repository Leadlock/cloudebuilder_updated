/**
 * /api/container-templates/[id]
 *
 * PUT    — rename a saved template and/or replace its configuration (members, admins and owners).
 * DELETE — delete it (the person who saved it, or an owner or admin).
 */
import { NextRequest } from 'next/server';
import { ok, forbidden, unauthorized, internalError, badRequest, notFound, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { containerTemplateRepository } from '@/lib/repositories/containerTemplateRepository';
import { checkSavable, parseStoredConfig, SaveBody, WRITE_ROLES } from '@/lib/engines/containers/stored';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const parsed = await parseBody(req, SaveBody);
    if (!parsed.ok) return parsed.response;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    if (!WRITE_ROLES.has(role)) return forbidden('Viewers cannot change templates.');

    const config = parseStoredConfig(JSON.stringify(parsed.data.config ?? null));
    if (!config) return badRequest('That configuration is not valid.');
    const errors = checkSavable(parsed.data.name, config);
    if (errors.length > 0) return badRequest(errors.join(' '));

    const { id } = await params;
    const template = await containerTemplateRepository.update(orgId, id, parsed.data.name, config);
    return template ? ok({ template }) : notFound('Template');
  } catch (err) {
    console.error('[PUT container-templates]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    if (!WRITE_ROLES.has(role)) return forbidden('Viewers cannot delete templates.');

    const { id } = await params;
    const owner = await containerTemplateRepository.createdBy(orgId, id);
    if (owner === null) return notFound('Template');
    const mine = owner === (identity.email ?? identity.userId);
    if (!mine && role === 'member') return forbidden('Only the person who saved a template, or an owner or admin, can delete it.');
    await containerTemplateRepository.delete(orgId, id);
    return ok({ deleted: true });
  } catch (err) {
    console.error('[DELETE container-templates]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
