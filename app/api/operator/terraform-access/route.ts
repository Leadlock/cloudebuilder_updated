/**
 * /api/operator/terraform-access
 *
 * GET — every organization that has asked for, or been given or refused, Terraform access, requests first. Only operators: the people named in
 * CLOUDBUILDER_OPERATOR_EMAILS. Being an owner or admin of an organization (which every new account is) never makes anyone an operator.
 */
import { NextRequest } from 'next/server';
import { ok, forbidden, unauthorized, internalError } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { db } from '@/src/prisma/db';
import { terraformAccessRepository } from '@/lib/repositories/terraformAccessRepository';
import { allowedTerraformOrgIds } from '@/lib/api/terraformAccess';
import { autoApproveEnabled, isOperatorEmail } from '@/lib/terraform/access/service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    if (!(await isOperatorEmail(identity.email))) return forbidden('Only a platform operator can see this.');
    const records = await terraformAccessRepository.list();
    const entries = await Promise.all(records.map(async (r) => {
      const org = (await db.orm.public.Organization.where({ id: r.orgId }).first().catch(() => null)) as { name?: string } | null;
      return { ...r, orgName: org?.name ?? r.orgId };
    }));
    return ok({ entries, autoApprove: autoApproveEnabled(), envListed: [...allowedTerraformOrgIds()] });
  } catch (err) {
    console.error('[GET operator/terraform-access]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
