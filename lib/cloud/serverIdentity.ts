/**
 * Which AWS identity is the CloudBuilder server running as?
 *
 * CloudBuilder reaches a customer's AWS account by assuming a role there. To call sts:AssumeRole at all, the server needs an AWS
 * identity of its own (an access key in the environment, a profile, or an instance/task role). When it has none, connecting an
 * account fails with a confusing error long after the user typed their role details. This asks AWS who the server is — the same
 * way the SDK will sign in — so the screen can say it up front, and show the identity the role has to trust.
 *
 * Only the account id and the identity's ARN are returned (the same things STS reports); never a key.
 */
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { explainValidationFailure } from '@/lib/cloud/validationExplain';

export type ServerAwsIdentity =
  | { configured: true; accountId: string; arn: string }
  | { configured: false; reason: string; fix: string };

const CACHE_MS = 60_000;
const TIMEOUT_MS = 8_000;
let cache: { at: number; value: ServerAwsIdentity } | null = null;

export function _clearServerIdentityCacheForTests(): void { cache = null; }

export async function getServerAwsIdentity(options: { fresh?: boolean } = {}): Promise<ServerAwsIdentity> {
  if (!options.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  let value: ServerAwsIdentity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sts = new STSClient({ region: process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION'] || 'us-east-1' });
    const identity = await Promise.race([
      sts.send(new GetCallerIdentityCommand({})),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out asking AWS who the server is')), TIMEOUT_MS); }),
    ]);
    value = identity.Account && identity.Arn
      ? { configured: true, accountId: identity.Account, arn: identity.Arn }
      : { configured: false, ...explainValidationFailure('aws', 'STS GetCallerIdentity returned an incomplete response') };
  } catch (err) {
    value = { configured: false, ...explainValidationFailure('aws', err instanceof Error ? err.message : String(err)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
  cache = { at: Date.now(), value };
  return value;
}
