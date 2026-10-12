/**
 * Who may run `terraform plan / apply / destroy` on this server.
 *
 * Executing Terraform runs a process on the host with real cloud credentials, so it cannot hang off a role every
 * self-registered user receives (signup makes the new user the owner — and so "admin" — of a brand-new org).
 * Execution is therefore DENIED by default and needs both:
 *   1. the caller's organisation to be listed in CLOUDCRAFT_TERRAFORM_ORG_IDS (comma-separated org ids) — an operator
 *      decision made on the server, not something a user can grant themselves; and
 *   2. the caller to be an owner or admin of that organisation.
 *
 * Local development convenience: when NODE_ENV is exactly "development" and CLOUDCRAFT_TERRAFORM_ORG_IDS is not set,
 * the caller's own organisation is allowed (rule 2 still applies). Setting the variable turns this off, so the gate can
 * still be exercised locally. It never applies in production or test builds.
 */
import { devShortcutsEnabled } from '@/lib/dev/shortcuts';
import { getOrgRole } from '@/lib/api/auth';
import { terraformExecutionDisabled } from '@/lib/terraform/execution/killSwitch';

const EXECUTION_ROLES = new Set(['owner', 'admin']);

export function allowedTerraformOrgIds(): Set<string> {
  return new Set((process.env.CLOUDCRAFT_TERRAFORM_ORG_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** Returns a message explaining the refusal, or null when the caller may execute Terraform for `orgId`. */
export async function terraformExecutionDenied(userId: string, orgId: string): Promise<string | null> {
  if (terraformExecutionDisabled()) return 'Terraform execution is switched off by the server operator (CLOUDCRAFT_TERRAFORM_DISABLED).';
  const listed = allowedTerraformOrgIds();
  const localDevOpen = devShortcutsEnabled() && listed.size === 0;
  if (!localDevOpen && !listed.has(orgId)) {
    return 'Terraform execution is not enabled for this organization. A server administrator must add the organization to CLOUDCRAFT_TERRAFORM_ORG_IDS.';
  }
  const role = await getOrgRole(userId, orgId);
  if (!role || !EXECUTION_ROLES.has(role)) {
    return 'Only an owner or admin of the organization can run Terraform plan, apply or destroy.';
  }
  return null;
}
