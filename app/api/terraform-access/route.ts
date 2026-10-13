/**
 * /api/terraform-access
 *
 * GET  — where the caller's organization stands on running Terraform: its status, the checks that would let it qualify automatically,
 *        whether the server approves automatically, and whether the caller is an operator (any member may read).
 * POST — ask for access (owners and admins). Approved at once when the server allows automatic approval and every check passes;
 *        otherwise it waits for an operator.
 */
import { NextRequest } from 'next/server';
import { ok, forbidden, unauthorized, internalError, badRequest } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { allowedTerraformOrgIds, terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { terraformAccessRepository } from '@/lib/repositories/terraformAccessRepository';
import { evaluateEligibility } from '@/lib/terraform/access/eligibility';
import { autoApproveEnabled, isOperatorEmail, requestAccess } from '@/lib/terraform/access/service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    const [record, checks, denied] = await Promise.all([
      terraformAccessRepository.get(orgId).catch(() => null),
      evaluateEligibility(identity.userId, orgId),
      terraformExecutionDenied(identity.userId, orgId),
    ]);
    const listed = allowedTerraformOrgIds().has(orgId);
    const status = listed ? 'approved' : record?.status ?? 'none';
    return ok({
      status,
      source: listed ? 'operator' : record?.source ?? null,
      note: record?.note ?? null,
      decidedBy: record?.decidedBy ?? null,
      requestedAt: record?.requestedAt ?? null,
      checks,
      autoApprove: autoApproveEnabled(),
      canRequest: (role === 'owner' || role === 'admin') && !listed && status !== 'approved' && status !== 'revoked',
      mayDeploy: denied === null,
      reason: denied,
      operator: await isOperatorEmail(identity.email),
    });
  } catch (err) {
    console.error('[GET terraform-access]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const result = await requestAccess(identity.userId, identity.email, orgId);
    if (!result.ok) return result.code === 'forbidden' ? forbidden(result.message) : badRequest(result.message);
    return ok({ status: result.record.status, automatic: result.automatic, checks: result.record.checks });
  } catch (err) {
    console.error('[POST terraform-access]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
