/**
 * Checks what a person typed into the Connect AWS form BEFORE it is sent, and says in plain words what is wrong — instead of a bare
 * "Validation failed". Pure function, safe in the browser. (The server checks the same things again; this only makes the message useful.)
 */
export interface AwsConnectInput {
  accessKeyId: string;
  secretAccessKey: string;
  roleArn: string;
  externalId?: string;
}

const ACCESS_KEY_ID_RE = /^AKIA[A-Z0-9]{16}$/;
const SECRET_RE = /^[A-Za-z0-9/+=]{40}$/;
const ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,64}$/;
const EXTERNAL_ID_RE = /^[\x21-\x7E]{2,1224}$/;

/** What a mistyped Role ARN actually is, so the message can say "that is a user, you need a role". */
export function describeArn(arn: string): 'user' | 'root' | 'role' | 'other' {
  if (/^arn:[a-z-]+:iam::\d{12}:user\//.test(arn)) return 'user';
  if (/^arn:[a-z-]+:iam::\d{12}:root$/.test(arn)) return 'root';
  if (/^arn:[a-z-]+:iam::\d{12}:role\//.test(arn)) return 'role';
  return 'other';
}

/** Returns the first problem, as a sentence a person can act on, or null when the input looks right. */
export function checkAwsConnectInput(input: AwsConnectInput): string | null {
  const accessKeyId = input.accessKeyId.trim();
  const secret = input.secretAccessKey.trim();
  const roleArn = input.roleArn.trim();
  const externalId = (input.externalId ?? '').trim();

  if (!accessKeyId) return 'Enter the Access key ID (it starts with AKIA).';
  if (accessKeyId.startsWith('ASIA')) return 'That is a temporary access key (it starts with ASIA). Create a long-term access key for the IAM user — it starts with AKIA.';
  if (!ACCESS_KEY_ID_RE.test(accessKeyId)) return 'The Access key ID should be 20 characters and start with AKIA. Copy it exactly from the access key you created.';

  if (!secret) return 'Enter the Secret access key. AWS shows it only once, when the key is created.';
  if (!SECRET_RE.test(secret)) return 'The Secret access key should be 40 characters. Copy it exactly — AWS shows it only once, when the key is created; if you lost it, create a new key.';

  if (!roleArn) return 'Enter the Role ARN: the ARN of the role you created (IAM → Roles → your role).';
  if (!ROLE_ARN_RE.test(roleArn)) {
    const kind = describeArn(roleArn);
    if (kind === 'user') return 'That is the ARN of an IAM user, not of a role. The Role ARN is the ARN of the role the user assumes (IAM → Roles → your role). If you have not created the role yet, follow steps 1 and 2 above.';
    if (kind === 'root') return 'That is the ARN of an account, not of a role. The Role ARN looks like arn:aws:iam::123456789012:role/CloudCraftRole.';
    return 'The Role ARN should look like arn:aws:iam::123456789012:role/CloudCraftRole. Copy it from the role\'s page in IAM.';
  }

  if (externalId && !EXTERNAL_ID_RE.test(externalId)) return 'The External ID must be 2 to 1224 characters. Leave it empty if the role does not require one.';
  return null;
}
