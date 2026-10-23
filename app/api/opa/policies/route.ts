/**
 * /api/opa/policies
 * GET - Retrieve all OPA Rego policies (built-in + organization custom)
 * PUT - Update policy toggles or add custom Rego policies
 */

import { NextRequest } from 'next/server';
import { ok, unauthorized, internalError, badRequest, forbidden } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { opaPolicyService } from '@/lib/opa/opaPolicyService';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    const orgId = identity ? await resolveOrgId(req, identity.userId) : undefined;
    const policies = await opaPolicyService.getPolicies(orgId ?? undefined);
    return ok({ policies });
  } catch (err) {
    console.error('[GET /api/opa/policies]', err);
    return internalError();
  }
}

export async function PUT(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role || (role !== 'owner' && role !== 'admin')) {
      return forbidden('Only organization owners and admins can configure policy guardrails.');
    }

    const body = await req.json().catch(() => ({}));
    const updated = await opaPolicyService.savePolicyOverrides(
      orgId,
      {
        disabledPolicyIds: body.disabledPolicyIds,
        customPolicies: body.customPolicies,
      },
      identity.userId,
    );

    return ok({ policies: updated });
  } catch (err) {
    console.error('[PUT /api/opa/policies]', err);
    return internalError();
  }
}
