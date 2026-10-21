/**
 * /api/architecture-templates
 *
 * GET  — the Templates gallery's list as the database holds it: the built-in templates (without their graphs) and the caller's organization's own (with
 *        their graphs). Any member. The built-in rows are written from the code the first time they are asked for, and at server start.
 * POST — save a template for the caller's organization (members, admins and owners; not viewers). The body is { name, description?, provider, category?, tags?, nodes, edges }.
 */
import { NextRequest } from 'next/server';
import { ok, created, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { WRITE_ROLES } from '@/lib/engines/containers/stored';
import { PgTemplateStore } from '@/lib/templates/templateStore';
import { syncBuiltInTemplates } from '@/lib/templates/sync';
import { graphProblems, MAX_ORG_TEMPLATES, SaveTemplateBody } from '@/lib/templates/stored';

export const dynamic = 'force-dynamic';

const store = new PgTemplateStore();

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    if (!(await getOrgRole(identity.userId, orgId))) return forbidden();
    let templates = await store.list(orgId);
    if (!templates.some((t) => t.source === 'builtin')) { await syncBuiltInTemplates(store); templates = await store.list(orgId); }
    const own = await store.listOwn(orgId);
    return ok({ templates: templates.map((t) => (t.source === 'org' ? { ...t, graph: own.find((o) => o.id === t.id)?.graph ?? null } : t)) });
  } catch (err) {
    console.error('[GET architecture-templates]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const parsed = await parseBody(req, SaveTemplateBody);
    if (!parsed.ok) return parsed.response;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    if (!WRITE_ROLES.has(role)) return forbidden('Viewers cannot save templates.');
    const problems = graphProblems(parsed.data.nodes, parsed.data.edges);
    if (problems.length > 0) return badRequest(problems.join(' '));
    if ((await store.countOwn(orgId)) >= MAX_ORG_TEMPLATES) return badRequest(`An organization can keep ${MAX_ORG_TEMPLATES} templates. Delete one first.`);
    return created({ template: await store.createOwn(orgId, identity.email ?? identity.userId, parsed.data) });
  } catch (err) {
    console.error('[POST architecture-templates]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
