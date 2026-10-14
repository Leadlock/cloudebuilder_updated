/**
 * Who may run `terraform plan / apply / destroy` on this server.
 *
 * Executing Terraform runs a process on the host with real cloud credentials, so it cannot hang off a role every
 * self-registered user receives (signup makes the new user the owner — and so "admin" — of a brand-new org).
 * Execution is therefore DENIED by default and needs both:
 *   1. the caller's organisation to be allowed: listed in CLOUDCRAFT_TERRAFORM_ORG_IDS (comma-separated org ids; an override the
 *      server operator sets in the environment), or approved in its TerraformAccess record, either by an operator or automatically
 *      when the organization passes every check and the server allows that (lib/terraform/access). Never something a user can grant themselves; and
 *   2. the caller to be an owner or admin of that organisation.
 *
 * Local development convenience: when NODE_ENV is exactly "development" and CLOUDCRAFT_TERRAFORM_ORG_IDS is not set,
 * the caller's own organisation is allowed (rule 2 still applies). Setting the variable turns this off, so the gate can
 * still be exercised locally. It never applies in production or test builds.
 */
import { canUseRestrictedFeatures, RESTRICTED_FEATURE_MESSAGE } from '@/lib/auth/restrictedFeatures';
import { devShortcutsEnabled } from '@/lib/dev/shortcuts';
import { getOrgRole } from '@/lib/api/auth';
import { terraformExecutionDisabled } from '@/lib/terraform/execution/killSwitch';

const EXECUTION_ROLES = new Set(['owner', 'admin']);

/** The organization's access record, or null when there is none or it cannot be read (an unreadable record means "not enabled"). Loaded on demand so importing this file never opens the database. */
async function accessRecord(orgId: string) {
  try {
    const { terraformAccessRepository } = await import('@/lib/repositories/terraformAccessRepository');
    return await terraformAccessRepository.get(orgId);
  } catch { return null; }
}

export function allowedTerraformOrgIds(): Set<string> {
  return new Set((process.env.CLOUDCRAFT_TERRAFORM_ORG_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** Returns a message explaining the refusal, or null when the caller may execute Terraform for `orgId`. */
export async function terraformExecutionDenied(userId: string, orgId: string, email?: string): Promise<string | null> {
  if (!canUseRestrictedFeatures(email)) return RESTRICTED_FEATURE_MESSAGE;
  if (terraformExecutionDisabled()) return 'Terraform execution is switched off by the server operator (CLOUDCRAFT_TERRAFORM_DISABLED).';
  const listed = allowedTerraformOrgIds();
  const localDevOpen = devShortcutsEnabled() && listed.size === 0;
  if (!localDevOpen && !listed.has(orgId)) {
    // Not on the operator's list: the organization's own access record decides.
    const record = await accessRecord(orgId);
    if (record?.status !== 'approved') {
      const why = record?.status === 'requested' ? ' Your request is waiting for an operator to approve it.'
        : record?.status === 'denied' ? ` An operator declined it${record.note ? `: ${record.note}` : '.'}`
          : record?.status === 'revoked' ? ` An operator withdrew access${record.note ? `: ${record.note}` : '.'}`
            : ' Ask for access below: it is approved automatically when the checks pass (if the server allows that), or by an operator.';
      return `Terraform execution is not enabled for this organization.${why}`;
    }
  }
  const role = await getOrgRole(userId, orgId);
  if (!role || !EXECUTION_ROLES.has(role)) {
    return 'Only an owner or admin of the organization can run Terraform plan, apply or destroy.';
  }
  return null;
}
