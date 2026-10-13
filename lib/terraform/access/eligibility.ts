/**
 * The conditions an organization has to meet to qualify for Terraform execution without an operator deciding by hand. Each one closes a way
 * the gate could otherwise be abused or a customer could be hurt, so "everyone may deploy" is never the same as "no checks":
 *
 *  - authenticator: the person asking has turned on the authenticator app, so a leaked password alone cannot deploy or tear down anything;
 *  - cloud-account: the organization has a cloud account that was checked and works, so the deploy targets something real;
 *  - encryption-key: this server holds stored credentials under a key of its own, not a published example (checked in production only:
 *    a development machine uses a throwaway key by design, and refuses it the moment it runs as a real server).
 */
import { totpEnabled } from '@/lib/api/totpStore';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { encryptionKeyIsTrustworthy } from '@/lib/crypto/credentials';
import type { EligibilityCheck } from './types';

export async function evaluateEligibility(userId: string, orgId: string): Promise<EligibilityCheck[]> {
  let totp = false;
  try { totp = await totpEnabled(userId); } catch { /* unreadable counts as not enabled */ }
  let active = 0;
  let total = 0;
  try {
    const accounts = await cloudAccountRepository.list(orgId);
    total = accounts.length;
    active = accounts.filter((a) => a.status === 'active').length;
  } catch { /* unreadable counts as none */ }
  const production = process.env['NODE_ENV'] === 'production';
  const key = production ? encryptionKeyIsTrustworthy() : { ok: true };
  return [
    {
      id: 'authenticator', label: 'Authenticator app turned on for you', passed: totp,
      detail: totp ? 'On.' : 'Not turned on.',
      fix: 'Cloud Accounts, then "Authenticator app for deploy and teardown": enter your password and scan the code.',
    },
    {
      id: 'cloud-account', label: 'A cloud account that passed its check', passed: active > 0,
      detail: active > 0 ? `${active} of ${total} cloud account${total === 1 ? '' : 's'} checked and working.` : total === 0 ? 'No cloud account connected.' : 'None of the connected cloud accounts has passed its check.',
      fix: 'Connect an account under Cloud Accounts, then click Re-check until it shows active.',
    },
    {
      id: 'encryption-key', label: 'Credentials stored under the server\'s own key', passed: key.ok,
      detail: !production ? 'Not required on a development machine.' : key.ok ? 'The server uses its own encryption key.' : 'The server is using a published example key or a weak one.',
      fix: 'The server operator sets a real ENCRYPTION_KEY (npm run credentials:new-key).',
    },
  ];
}

export const allPassed = (checks: EligibilityCheck[]): boolean => checks.every((c) => c.passed);
