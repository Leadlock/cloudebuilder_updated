/**
 * Turns the raw reason a cloud account failed validation into two plain sentences: what is wrong, and what to do about it.
 *
 * The adapters return AWS/Azure error text (already stripped of request ids and ARNs). That text is accurate but written for
 * developers, and the most common cause — the CloudBuilder server has no AWS credentials of its own, so it cannot even try to
 * assume your role — reads like a bug in the role the user just created. This says it straight.
 */

export interface ValidationExplanation {
  /** What is wrong, in one sentence. */
  reason: string;
  /** What to do next. */
  fix: string;
}

type Rule = { when: RegExp; reason: string; fix: string };

/** Reasons that only make sense for an account connected with an access key (no role, no server identity involved). */
const ACCESS_KEY_RULES: Rule[] = [
  {
    when: /ROOT_ACCESS_KEY/,
    reason: 'That access key belongs to the AWS account\'s root user, and CloudBuilder refuses root keys.',
    fix: 'Create a dedicated IAM user with only the read-only policy, make an access key for it, and connect the account with that key. Then delete the root key in AWS.',
  },
  {
    // AWS answers InvalidClientTokenId ("The security token included in the request is invalid") when it does not know the key ID at all.
    when: /InvalidClientTokenId|security token included in the request is invalid|Access Key Id you provided does not exist|InvalidAccessKeyId/i,
    reason: 'AWS does not recognise this Access key ID.',
    fix: 'The ID may have a typo or be cut short, or the key may have been deleted or deactivated. In IAM → Users → your user → Security credentials, check the key is listed and Active (or create a new one), then use Edit to enter the right Access key ID and Secret access key.',
  },
  {
    // SignatureDoesNotMatch: the key ID is known, but the secret does not belong to it.
    when: /SignatureDoesNotMatch|signature we calculated does not match/i,
    reason: 'The Secret access key does not match this Access key ID.',
    fix: 'Use Edit and paste the secret exactly as AWS showed it (it is shown only once, when the key is created). If you no longer have it, create a new access key for the user.',
  },
  {
    when: /AccessDenied|UnauthorizedOperation|not authorized to perform/i,
    reason: 'The access key is valid, but its IAM user is not allowed to read your resources.',
    fix: 'Attach the read-only policy (or the AWS ReadOnlyAccess policy) to that IAM user, then check again.',
  },
  {
    when: /ExpiredToken|token.{0,30}expired/i,
    reason: 'These temporary AWS credentials have expired.',
    fix: 'Temporary credentials stop working on their own. Create new ones (for example run "aws sts get-session-token" in AWS CloudShell, or copy fresh credentials from AWS access portal) and connect the account again.',
  },
];

/** Your own access key assumes your own role: what can go wrong is in the key, the key's permission to assume, or the role's trust. */
const KEY_ROLE_RULES: Rule[] = [
  ACCESS_KEY_RULES[0]!,
  ACCESS_KEY_RULES[1]!,
  ACCESS_KEY_RULES[2]!,
  {
    when: /not authorized to perform:?\s*sts:AssumeRole|is not authorized to assume|AccessDenied.{0,80}AssumeRole|AssumeRole.{0,80}AccessDenied/i,
    reason: 'AWS refused to let your access key assume the role.',
    fix: 'Check three things: the key\'s IAM user is allowed to call sts:AssumeRole on this role; the role\'s trust policy trusts that user (or your AWS account); and, if you entered an External ID, the trust policy requires exactly the same one.',
  },
  {
    when: /RoleArn|Member must satisfy regular expression pattern|not a valid (role )?arn|ValidationError/i,
    reason: 'The role ARN does not look valid.',
    fix: 'Copy the ARN from the role\'s page in IAM. It looks like arn:aws:iam::123456789012:role/CloudBuilderReadOnly.',
  },
  {
    when: /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|socket hang up|timed out/i,
    reason: 'CloudBuilder could not reach AWS.',
    fix: 'Check the server\'s internet connection and any proxy or firewall rules, then check again.',
  },
];

const AWS_RULES: Rule[] = [
  {
    when: /could not load credentials|CredentialsProviderError|Missing credentials in config/i,
    reason: 'The CloudBuilder server has no AWS credentials of its own, so it cannot start the connection to your account.',
    fix: 'Give the server an AWS identity that is allowed to assume your role (an access key in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or an instance/task role), restart it, then check again. Your role and External ID have not been tested yet. Or skip the server setup: delete this account and connect it again with your own access key and role.',
  },
  {
    when: /InvalidClientTokenId|security token included in the request is invalid|SignatureDoesNotMatch|Access Key Id you provided does not exist/i,
    reason: 'The AWS access key the CloudBuilder server uses is not valid.',
    fix: 'Check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY on the server (the key may have been deleted or mistyped), restart it, then check again.',
  },
  {
    when: /ExpiredToken|token.{0,30}expired/i,
    reason: 'The AWS credentials the CloudBuilder server uses have expired.',
    fix: 'Refresh the server\'s AWS credentials (temporary credentials expire), restart it, then check again.',
  },
  {
    when: /not authorized to perform:?\s*sts:AssumeRole|is not authorized to assume|AccessDenied.{0,80}AssumeRole|AssumeRole.{0,80}AccessDenied/i,
    reason: 'AWS refused to let CloudBuilder assume your role.',
    fix: 'Check three things: the role\'s trust policy names the AWS identity the CloudBuilder server runs as; it requires exactly the External ID you entered here; and that identity has permission to call sts:AssumeRole on the role.',
  },
  {
    when: /RoleArn|Member must satisfy regular expression pattern|not a valid (role )?arn|ValidationError/i,
    reason: 'The role ARN does not look valid.',
    fix: 'Copy the ARN from the role\'s page in IAM. It looks like arn:aws:iam::123456789012:role/CloudBuilderReadOnly.',
  },
  {
    when: /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|socket hang up|timed out/i,
    reason: 'CloudBuilder could not reach AWS.',
    fix: 'Check the server\'s internet connection and any proxy or firewall rules, then check again.',
  },
];

const AZURE_RULES: Rule[] = [
  {
    when: /AADSTS7000222|secret.{0,40}expired/i,
    reason: 'The client secret for this Azure service principal has expired.',
    fix: 'Create a new client secret in Microsoft Entra ID (App registrations → Certificates & secrets), then delete this account and connect it again with the new secret.',
  },
  {
    when: /AADSTS7000215|invalid client secret/i,
    reason: 'The client secret is wrong.',
    fix: 'Use the secret\'s Value (not its ID) from Entra ID → App registrations → Certificates & secrets, or create a new one, then connect the account again.',
  },
  {
    when: /AADSTS700016|application with identifier .{0,80} was not found/i,
    reason: 'No Azure application matches this client ID in this tenant.',
    fix: 'Check the client (application) ID and the tenant ID: both come from the app registration\'s Overview page.',
  },
  {
    when: /AADSTS90002|tenant .{0,60}not found|AADSTS900023/i,
    reason: 'This tenant ID was not found.',
    fix: 'Copy the Directory (tenant) ID from the app registration\'s Overview page and connect the account again.',
  },
  {
    when: /AuthorizationFailed|does not have authorization to perform action/i,
    reason: 'The service principal exists but is not allowed to read this subscription.',
    fix: 'Give it the Reader role on the subscription (Subscription → Access control (IAM) → Add role assignment), then check again.',
  },
  {
    when: /SubscriptionNotFound|subscription .{0,60}(was )?not found/i,
    reason: 'This subscription ID was not found for the service principal.',
    fix: 'Check the subscription ID, and that the service principal has a role on that subscription.',
  },
  {
    when: /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|socket hang up|timed out/i,
    reason: 'CloudBuilder could not reach Azure.',
    fix: 'Check the server\'s internet connection and any proxy or firewall rules, then check again.',
  },
];

/** "arn:aws:iam::123456789012:user/Test" → "123456789012" */
const accountOf = (arn: string): string => /^arn:[^:]+:[^:]+::(\d{12}):/.exec(arn)?.[1] ?? '';

/** AWS refused the assume-role and told us who and which role: say exactly that, and what to check, most likely first. */
function explainAssumeDenied(userArn: string, roleArn: string): ValidationExplanation {
  const same = !!accountOf(userArn) && accountOf(userArn) === accountOf(roleArn);
  return {
    reason: `AWS refused to let ${userArn} assume ${roleArn}.`,
    fix: same
      ? `Check, in AWS: (1) the role exists with exactly this name (IAM → Roles; AWS gives this same refusal when the role is missing or the name differs); (2) the role's trust policy allows ${userArn} (IAM → Roles → the role → Trust relationships → Edit trust policy) — naming the user there is enough by itself in the same account; if it trusts the account instead, the user also needs an inline policy allowing sts:AssumeRole on the role; (3) if the trust policy has an sts:ExternalId condition, enter that same External ID here (Edit).`
      : `Check, in AWS: (1) the role (in account ${accountOf(roleArn)}) exists with exactly this name; (2) its trust policy allows ${userArn} or the account ${accountOf(userArn)}; (3) the user has an inline policy allowing sts:AssumeRole on the role; (4) if the trust policy has an sts:ExternalId condition, enter that same External ID here (Edit).`,
  };
}

export function explainValidationFailure(provider: string, error: string | null | undefined, missingPermissions: string[] = [], authMethod?: string): ValidationExplanation {
  // Never repeat an access key id in a message, even one AWS echoed back.
  const text = (error ?? '').replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[access key id]').trim();
  const denied = /ASSUME_DENIED\|(arn:[^|\s]+)\|(arn:[^|\s]+)\|/.exec(text);
  if (denied && authMethod === 'key-and-role') return explainAssumeDenied(denied[1]!, denied[2]!);
  // For every other kind of account the internal marker is dropped, so only AWS's own (already sanitised) wording is matched and shown.
  return explainText(provider, text.replace(/ASSUME_DENIED\|[^|]*\|[^|]*\|\s*/, ''), missingPermissions, authMethod);
}

function explainText(provider: string, text: string, missingPermissions: string[], authMethod?: string): ValidationExplanation {
  if (text) {
    const rules = provider === 'azure' ? AZURE_RULES : authMethod === 'key-and-role' ? KEY_ROLE_RULES : (authMethod === 'access-key' || authMethod === 'access-key-deploy') ? [...ACCESS_KEY_RULES, ...AWS_RULES.filter((r) => /ENOTFOUND/.test(r.when.source))] : AWS_RULES;
    for (const rule of rules) if (rule.when.test(text)) return { reason: rule.reason, fix: rule.fix };
  }
  if (!text && missingPermissions.length > 0) {
    const shown = missingPermissions.slice(0, 3).join(', ');
    if (authMethod === 'access-key' || authMethod === 'access-key-deploy') {
      return { reason: `The access key works, but its IAM user cannot read your resources (for example ${shown}).`, fix: 'Attach the read-only policy (or the AWS ReadOnlyAccess policy) to that IAM user, then check again.' };
    }
    return provider === 'azure'
      ? { reason: 'CloudBuilder signed in, but it cannot read the subscription\'s resources.', fix: 'Give the service principal the Reader role on the subscription, then check again.' }
      : {
        reason: `CloudBuilder assumed the role, but the role cannot read your resources (for example ${shown}).`,
        fix: 'Attach the ReadOnlyAccess policy to the role, or a custom read-only policy that includes the actions CloudBuilder uses, then check again.',
      };
  }
  return {
    reason: text ? `The connection check failed: ${text.slice(0, 200)}` : 'The connection check failed.',
    fix: 'Check the connection details you entered, then check again. The server log has the full reason.',
  };
}
