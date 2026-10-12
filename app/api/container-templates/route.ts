/**
 * /api/container-templates
 *
 * GET  — the container configurations saved by the caller's organization (any member).
 * POST — save one (members, admins and owners; not viewers). The body is { name, config }; secret values are never stored.
 */
import { NextRequest } from 'next/server';
import { ok, created, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { containerTemplateRepository } from '@/lib/repositories/containerTemplateRepository';
import { checkSavable, MAX_TEMPLATES_PER_ORG, parseStoredConfig, SaveBody, WRITE_ROLES } from '@/lib/engines/containers/stored';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    if (!(await getOrgRole(identity.userId, orgId))) return forbidden();
    return ok({ templates: await containerTemplateRepository.list(orgId) });
  } catch (err) {
    console.error('[GET container-templates]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const parsed = await parseBody(req, SaveBody);
    if (!parsed.ok) return parsed.response;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    if (!WRITE_ROLES.has(role)) return forbidden('Viewers cannot save templates.');

    const config = parseStoredConfig(JSON.stringify(parsed.data.config ?? null));
    if (!config) return badRequest('That configuration is not valid.');
    const errors = checkSavable(parsed.data.name, config);
    if (errors.length > 0) return badRequest(errors.join(' '));
    if ((await containerTemplateRepository.count(orgId)) >= MAX_TEMPLATES_PER_ORG) return badRequest(`An organization can keep ${MAX_TEMPLATES_PER_ORG} templates. Delete one first.`);

    return created({ template: await containerTemplateRepository.create(orgId, parsed.data.name, config, identity.email ?? identity.userId) });
  } catch (err) {
    console.error('[POST container-templates]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
