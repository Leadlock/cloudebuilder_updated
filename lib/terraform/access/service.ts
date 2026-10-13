/**
 * Who may run Terraform, and how an organization gets there. See lib/api/terraformAccess.ts for where the answer is used.
 *
 * Three ways in, all leaving a row and an audit event:
 *  - an operator (see operators.ts) approves, denies or revokes an organization;
 *  - an operator's own organization is approved when they ask: they could approve it themselves, so the checks add nothing;
 *  - any other organization qualifies automatically when every check passes (unless the server turned that off).
 * An operator's "revoked" is final until an operator approves again: asking again, or passing the checks, does not undo it.
 */
import { getOrgRole } from '@/lib/api/auth';
import { statusAccessCache } from '@/lib/api/accessCache';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { terraformAccessRepository } from '@/lib/repositories/terraformAccessRepository';
import { allPassed, evaluateEligibility } from './eligibility';
import { isOperatorEmail } from './operators';
import type { AccessRecord } from './types';

export { isOperatorEmail, operatorEmails } from './operators';
/** On unless the server turns it off (CLOUDCRAFT_TERRAFORM_AUTO_APPROVE=0): the checks, not a setting, are what keeps it safe. */
export const autoApproveEnabled = (): boolean => process.env['CLOUDCRAFT_TERRAFORM_AUTO_APPROVE'] !== '0';

const REQUEST_ROLES = new Set(['owner', 'admin']);
const clearCaches = () => statusAccessCache.clear();

export type RequestResult =
  | { ok: true; record: AccessRecord; automatic: boolean }
  | { ok: false; code: 'forbidden' | 'revoked'; message: string };

/** An owner or admin asks for their organization to be allowed. */
export async function requestAccess(userId: string, email: string | undefined, orgId: string): Promise<RequestResult> {
  const role = await getOrgRole(userId, orgId);
  if (!role || !REQUEST_ROLES.has(role)) return { ok: false, code: 'forbidden', message: 'Only an owner or admin of the organization can ask for Terraform access.' };

  const existing = await terraformAccessRepository.get(orgId);
  if (existing?.status === 'revoked') {
    return { ok: false, code: 'revoked', message: `An operator withdrew this organization's access${existing.note ? `: ${existing.note}` : ''}. Ask the operator to approve it again.` };
  }
  if (existing?.status === 'approved') return { ok: true, record: existing, automatic: existing.source === 'auto' };

  const checks = await evaluateEligibility(userId, orgId);
  const now = new Date().toISOString();
  if (await isOperatorEmail(email)) {
    const record = await terraformAccessRepository.save({ orgId, status: 'approved', source: 'operator', requestedBy: email ?? userId, requestedAt: now, decidedBy: email ?? userId, decidedAt: now, note: 'the operator\'s own organization', checks });
    clearCaches();
    await recordTerraformAudit({ action: 'access', outcome: 'allowed', orgId, userId, detail: 'approved: requested by an operator for their own organization' });
    return { ok: true, record, automatic: false };
  }
  const auto = autoApproveEnabled() && allPassed(checks);
  const record = await terraformAccessRepository.save({
    orgId, status: auto ? 'approved' : 'requested', source: auto ? 'auto' : 'operator',
    requestedBy: email ?? userId, requestedAt: now, decidedBy: auto ? 'automatic' : null, decidedAt: auto ? now : null, note: null, checks,
  });
  clearCaches();
  await recordTerraformAudit({ action: 'access', outcome: auto ? 'allowed' : 'requested', orgId, userId, detail: auto ? 'approved automatically: every check passed' : `requested; ${checks.filter((c) => !c.passed).map((c) => c.id).join(', ') || 'waiting for an operator'}` });
  return { ok: true, record, automatic: auto };
}

export type Decision = 'approve' | 'deny' | 'revoke';

/** An operator decides on an organization. */
export async function decideAccess(operator: { userId: string; email: string }, orgId: string, action: Decision, note?: string): Promise<AccessRecord> {
  const existing = await terraformAccessRepository.get(orgId);
  const now = new Date().toISOString();
  const status = action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'revoked';
  const record = await terraformAccessRepository.save({
    orgId, status, source: 'operator',
    requestedBy: existing?.requestedBy ?? null, requestedAt: existing?.requestedAt ?? null,
    decidedBy: operator.email, decidedAt: now, note: note?.trim() ? note.trim().slice(0, 300) : null, checks: existing?.checks ?? [],
  });
  clearCaches();
  await recordTerraformAudit({ action: 'access', outcome: action === 'approve' ? 'allowed' : action === 'deny' ? 'denied' : 'blocked', orgId, userId: operator.userId, detail: `${action} by ${operator.email}${note ? `: ${note.slice(0, 120)}` : ''}` });
  return record;
}
