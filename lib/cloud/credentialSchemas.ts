/**
 * What a connected cloud account's credentials must look like — shared by connecting a new account and editing one.
 * Every schema is strict: an unknown field is an error, so nothing a person sent is silently dropped.
 */
import { z } from 'zod';
import { describeArn } from './awsConnectInput';

/**
 * AWS IAM Role ARN format: arn:aws:iam::<account-id>:role/<role-name>
 * Account ID is exactly 12 digits. Role name allows letters, digits, +, =, ,, ., @, -, _.
 */
export const AWS_ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,64}$/;

/**
 * AWS external ID: printable ASCII, 2–1224 chars (AWS limits).
 * No leading/trailing whitespace.
 */
export const AWS_EXTERNAL_ID_RE = /^[\x21-\x7E]{2,1224}$/;

/**
 * AWS region: e.g. us-east-1, eu-central-1, ap-southeast-2.
 */
export const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

/**
 * UUID v4 format (used for Azure tenantId, clientId, subscriptionId).
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AwsCredentialsSchema = z.object({
  roleArn: z
    .string()
    .regex(AWS_ROLE_ARN_RE, 'roleArn must be a valid IAM Role ARN (arn:aws:iam::<12-digit-account>:role/<name>)'),
  externalId: z
    .string()
    .regex(AWS_EXTERNAL_ID_RE, 'externalId must be 2–1224 printable ASCII characters with no surrounding whitespace'),
  region: z
    .string()
    .regex(AWS_REGION_RE, 'region must be a valid AWS region identifier (e.g. us-east-1)'),
  additionalRegions: z
    .array(z.string().regex(AWS_REGION_RE, 'Each additionalRegion must be a valid AWS region identifier'))
    .max(20)
    .optional(),
}).strict();

/**
 * Access-key connection with NO role (discovery only; kept for connections made earlier). Long-term IAM user keys: the key id starts AKIA and is 20 characters, the secret is
 * exactly 40 characters of base64. Temporary keys (ASIA…) need a session token and are not accepted.
 */
const ISO_TIME = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'must be an ISO time (UTC)');

export const AwsKeyCredentialsSchema = z.object({
  accessKeyId: z
    .string()
    .regex(/^(AKIA|ASIA)[A-Z0-9]{16}$/, 'accessKeyId must be an IAM access key ID (20 characters, starting AKIA, or ASIA for temporary credentials)'),
  /** Only temporary credentials (ASIA…) have one. */
  sessionToken: z.string().regex(/^[A-Za-z0-9/+=_.-]{16,4096}$/, 'sessionToken must be the session token that came with the temporary credentials').optional(),
  expiresAt: ISO_TIME.optional(),
  forgetAfterDeploy: z.literal(true).optional(),
  secretAccessKey: z
    .string()
    .regex(/^[A-Za-z0-9/+=]{40}$/, 'secretAccessKey must be the 40-character secret access key'),
  region: z
    .string()
    .regex(AWS_REGION_RE, 'region must be a valid AWS region identifier (e.g. us-east-1)'),
  additionalRegions: z
    .array(z.string().regex(AWS_REGION_RE, 'Each additionalRegion must be a valid AWS region identifier'))
    .max(20)
    .optional(),
  /** The owner's explicit choice to let Terraform run directly on this key. Only the literal true is accepted. */
  allowDeploy: z.literal(true).optional(),
}).strict()   // strict: a key + role body that fails its own schema must NOT fall through and be saved as a key alone with the role dropped
  .superRefine((c, ctx) => {
    // Temporary credentials (ASIA) are useless without their session token and must carry a deadline; a long-term key has no session token.
    if (c.accessKeyId.startsWith('ASIA')) {
      if (!c.sessionToken) ctx.addIssue({ code: 'custom', path: ['sessionToken'], message: 'temporary credentials (ASIA…) need their session token' });
      if (!c.expiresAt) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'temporary credentials must say when they expire' });
    } else if (c.sessionToken) {
      ctx.addIssue({ code: 'custom', path: ['sessionToken'], message: 'only temporary credentials (ASIA…) have a session token' });
    }
  });

/**
 * The user's own access key + the user's own role (how accounts are connected now). The key's IAM user only needs permission to
 * assume the role; the role carries the permissions. The External ID is optional (only if the role's trust policy requires it).
 */
export const AwsKeyRoleCredentialsSchema = z.object({
  accessKeyId: z
    .string()
    .regex(/^AKIA[A-Z0-9]{16}$/, 'accessKeyId must be a long-term IAM access key ID (20 characters, starting AKIA)'),
  secretAccessKey: z
    .string()
    .regex(/^[A-Za-z0-9/+=]{40}$/, 'secretAccessKey must be the 40-character secret access key'),
  roleArn: z
    .string()
    .regex(AWS_ROLE_ARN_RE, 'roleArn must be a valid IAM Role ARN (arn:aws:iam::<12-digit-account>:role/<name>)'),
  externalId: z
    .string()
    .regex(AWS_EXTERNAL_ID_RE, 'externalId must be 2–1224 printable ASCII characters with no surrounding whitespace')
    .optional(),
  region: z
    .string()
    .regex(AWS_REGION_RE, 'region must be a valid AWS region identifier (e.g. us-east-1)'),
  additionalRegions: z
    .array(z.string().regex(AWS_REGION_RE, 'Each additionalRegion must be a valid AWS region identifier'))
    .max(20)
    .optional(),
  expiresAt: ISO_TIME.optional(),
  forgetAfterDeploy: z.literal(true).optional(),
}).strict();

export const AzureCredentialsSchema = z.object({
  tenantId: z
    .string()
    .regex(UUID_RE, 'tenantId must be a valid UUID'),
  clientId: z
    .string()
    .regex(UUID_RE, 'clientId must be a valid UUID'),
  clientSecret: z
    .string()
    .min(1)
    .max(512),
  subscriptionId: z
    .string()
    .regex(UUID_RE, 'subscriptionId must be a valid UUID'),
}).strict();


/** Most specific first: a key + role must not be read as a key alone or as a role alone. */
export const CloudCredentialsSchema = z.union([AwsKeyRoleCredentialsSchema, AwsKeyCredentialsSchema, AwsCredentialsSchema, AzureCredentialsSchema]);

/**
 * z.union reports a failure as just "Invalid input". When the credentials are recognisably one kind, check them against THAT
 * schema and say which field is wrong (and, for the common mistake of pasting a user's ARN where a role's is needed, say so).
 * Returns null when it cannot tell what kind they are, or when they are fine.
 */
export function explainCredentialsProblem(credentials: unknown): string | null {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return null;
  const keys = credentials as Record<string, unknown>;
  const schema = 'accessKeyId' in keys ? ('roleArn' in keys ? AwsKeyRoleCredentialsSchema : AwsKeyCredentialsSchema)
    : 'roleArn' in keys ? AwsCredentialsSchema
      : 'tenantId' in keys ? AzureCredentialsSchema : null;
  if (!schema) return null;
  const r = schema.safeParse(credentials);
  if (r.success) return null;
  if (typeof keys['roleArn'] === 'string' && !AWS_ROLE_ARN_RE.test(keys['roleArn'])) {
    const kind = describeArn(keys['roleArn']);
    if (kind === 'user') return 'roleArn is the ARN of an IAM user, not of a role. Use the ARN of the role the user assumes (IAM → Roles → your role).';
    if (kind === 'root') return 'roleArn is the ARN of an account, not of a role. Use the ARN of the role (IAM → Roles → your role).';
  }
  return r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

/**
 * Applies an edit to stored credentials: only the fields that were sent change. A blank value keeps the current one (so a secret
 * left empty stays as it is) — except the External ID, where blank means "remove it".
 */
export function mergeCredentialEdit(existing: Record<string, unknown>, patch: Record<string, string | null | undefined>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '') { if (key === 'externalId') delete merged[key]; continue; }
    merged[key] = text;
  }
  return merged;
}
