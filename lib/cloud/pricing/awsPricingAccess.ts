/**
 * Lets AWS list prices come from the official Price List API without a separate server key.
 *
 * Without AWS_PRICING_ACCESS_KEY_ID / AWS_PRICING_SECRET_ACCESS_KEY every AWS line used the built-in table. When the organization has
 * a connected AWS account that signs in with a role, this assumes that role for one hour and uses the temporary credentials for the
 * read-only `pricing:GetProducts` call. List prices are public and the same for every account, so any connected role works; the call
 * reads no resources and the credentials never leave the server. Best effort: any failure leaves the built-in table in use, and the
 * lines it prices are then labelled "built-in estimate" (lib/cost/quality/priceQuality.ts), never shown as official.
 */
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { resolveExecutionCredentials } from '@/lib/cloud/credentials/resolveExecutionCredentials';
import { isAwsKeyRoleCredentials, isAwsRoleCredentials, type CloudCredentials } from '@/lib/cloud/types';
import { provideAwsPricingCredentials, hasAwsPricingAccess } from './AwsPricingProvider';

const SESSION_MS = 50 * 60 * 1000;       // the assumed session lasts an hour; renew before it ends
const RETRY_MS = 10 * 60 * 1000;         // a failing account is not retried on every request
const tried = new Map<string, number>(); // orgId → time of the last attempt

export async function ensureAwsPricingAccess(orgId: string): Promise<void> {
  if (hasAwsPricingAccess()) return;
  const last = tried.get(orgId);
  if (last && Date.now() - last < RETRY_MS) return;
  tried.set(orgId, Date.now());
  try {
    const accounts = (await cloudAccountRepository.list(orgId)).filter((a) => a.provider === 'aws');
    for (const account of accounts) {
      const stored = await cloudAccountRepository.getCredentials(account.id, orgId).catch(() => null);
      if (!stored) continue;
      const creds = JSON.parse(stored) as CloudCredentials;
      if (!isAwsRoleCredentials(creds) && !isAwsKeyRoleCredentials(creds)) continue;
      const env = await resolveExecutionCredentials(creds);
      if (!env['AWS_ACCESS_KEY_ID'] || !env['AWS_SECRET_ACCESS_KEY']) continue;
      provideAwsPricingCredentials({
        accessKeyId: env['AWS_ACCESS_KEY_ID'], secretAccessKey: env['AWS_SECRET_ACCESS_KEY'], sessionToken: env['AWS_SESSION_TOKEN'],
      }, Date.now() + SESSION_MS);
      return;
    }
  } catch {
    // Not available: the built-in table prices AWS, and says so.
  }
}
