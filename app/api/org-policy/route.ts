/**
 * /api/org-policy
 *
 * GET — the caller's organization policy (any member). An organization with no saved policy gets the empty policy: no restriction.
 * PUT — replace the policy (organization owners and admins only).
 *
 * The policy is advisory: violations are shown as warnings and nothing is blocked. The role check is made against the caller's role IN
 * the organization, never the session's `admin` flag (every self-registered user is an admin of their own new organization).
 */
import { NextRequest } from 'next/server';
import { ok, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { orgPolicyRepository } from '@/lib/repositories/orgPolicyRepository';
import { OrgPolicyRulesSchema, normalizeRules } from '@/lib/engines/policy/schema';
import { EMPTY_POLICY_RULES, type OrgPolicy } from '@/lib/engines/policy/types';

export const dynamic = 'force-dynamic';

const ADMIN_ROLES = new Set(['owner', 'admin']);

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    const policy: OrgPolicy = (await orgPolicyRepository.get(orgId)) ?? { ...EMPTY_POLICY_RULES, version: 0 };
    return ok({ policy, canEdit: ADMIN_ROLES.has(role) });
  } catch (err) {
    console.error('[GET org-policy]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function PUT(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const parsed = await parseBody(req, OrgPolicyRulesSchema);
    if (!parsed.ok) return parsed.response;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    if (!ADMIN_ROLES.has(role)) return forbidden('Only an owner or admin of the organization can change its policy.');

    const policy = await orgPolicyRepository.save(orgId, normalizeRules(parsed.data), identity.email ?? identity.userId);
    return ok({ policy, canEdit: true });
  } catch (err) {
    console.error('[PUT org-policy]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
