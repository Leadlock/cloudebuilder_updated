/**
 * Helpers for setting up the IAM role CloudBuilder assumes — pure functions, safe to use in the browser and on the server.
 *
 * The role's TRUST policy says who may assume it: it must name the AWS identity the CloudBuilder server runs as, and require the
 * External ID. The server's own identity needs a (small) permission to call sts:AssumeRole on that role. These build both, so
 * nobody has to write IAM JSON by hand.
 */

/** A random External ID (32 hex characters = 128 bits). Uses the Web Crypto API, available in browsers and Node. */
export function generateExternalId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The principal to put in a trust policy for the identity `arn` (as returned by sts:GetCallerIdentity):
 *   IAM user                    arn:aws:iam::A:user/NAME            → the same ARN
 *   account root                arn:aws:iam::A:root                 → the same ARN
 *   assumed role (a session)    arn:aws:sts::A:assumed-role/R/S     → the role: arn:aws:iam::A:role/R
 *   anything else (federated…)  → the account root, which trusts every identity of that account that is allowed to assume
 * A session ARN can never be used as a principal, which is why it is converted.
 */
export function trustPrincipalFromArn(arn: string): string {
  const user = /^arn:(aws[a-z-]*):iam::(\d{12}):(user\/[\w+=,.@/-]+|root)$/.exec(arn);
  if (user) return arn;
  const session = /^arn:(aws[a-z-]*):sts::(\d{12}):assumed-role\/([\w+=,.@-]+)\/[^/]+$/.exec(arn);
  if (session) return `arn:${session[1]}:iam::${session[2]}:role/${session[3]}`;
  const account = /^arn:(aws[a-z-]*):[a-z0-9-]+::(\d{12}):/.exec(arn);
  return account ? `arn:${account[1]}:iam::${account[2]}:root` : arn;
}

/**
 * The role's trust policy, ready to paste into IAM → Roles → (your role) → Trust relationships → Edit trust policy. With an
 * External ID it also requires that value; without one it trusts the principal alone.
 */
export function buildTrustPolicy(principalArn: string, externalId?: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { AWS: principalArn },
      Action: 'sts:AssumeRole',
      ...(externalId ? { Condition: { StringEquals: { 'sts:ExternalId': externalId } } } : {}),
    }],
  }, null, 2);
}

/** What the IAM user needs so it may assume the role (an inline policy on that user): one permission, on that one role. */
export function buildAssumeRolePolicy(roleArn: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: roleArn }],
  }, null, 2);
}
