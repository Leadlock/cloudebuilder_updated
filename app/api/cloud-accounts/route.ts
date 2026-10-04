/**
 * GET  /api/cloud-accounts        — list org's cloud accounts (no credentials)
 * POST /api/cloud-accounts        — connect a new cloud account
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  ok, created, badRequest, forbidden, unauthorized, internalError, parseBody,
} from '@/lib/api/response';
import { extractIdentity, getOrgRole, resolveOrgIds } from '@/lib/api/auth';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { authMethodOf, isAwsCredentials, type CloudCredentials } from '@/lib/cloud/types';

export const dynamic = 'force-dynamic';

// ─── Input schemas ────────────────────────────────────────────────────────────

/**
 * AWS IAM Role ARN format: arn:aws:iam::<account-id>:role/<role-name>
 * Account ID is exactly 12 digits. Role name allows letters, digits, +, =, ,, ., @, -, _.
 */
const AWS_ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,64}$/;

/**
 * AWS external ID: printable ASCII, 2–1224 chars (AWS limits).
 * No leading/trailing whitespace.
 */
const AWS_EXTERNAL_ID_RE = /^[\x21-\x7E]{2,1224}$/;

/**
 * AWS region: e.g. us-east-1, eu-central-1, ap-southeast-2.
 */
const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

/**
 * UUID v4 format (used for Azure tenantId, clientId, subscriptionId).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AwsCredentialsSchema = z.object({
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
});

/**
 * Access-key connection (discovery only). Long-term IAM user keys: the key id starts AKIA and is 20 characters, the secret is
 * exactly 40 characters of base64. Temporary keys (ASIA…) need a session token and are not accepted.
 */
const AwsKeyCredentialsSchema = z.object({
  accessKeyId: z
    .string()
    .regex(/^AKIA[A-Z0-9]{16}$/, 'accessKeyId must be a long-term IAM access key ID (20 characters, starting AKIA)'),
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
});

const AzureCredentialsSchema = z.object({
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
});

const CreateCloudAccountSchema = z.object({
  orgId:       z.string().min(1).optional(),
  provider:    z.enum(['aws', 'azure']),
  name:        z.string().min(1).max(120),
  credentials: z.union([AwsCredentialsSchema, AwsKeyCredentialsSchema, AzureCredentialsSchema]),
});

// ─── Route handlers ───────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    let orgId = req.nextUrl.searchParams.get('orgId') ?? '';
    if (!orgId) {
      const memberOrgIds = await resolveOrgIds(identity.userId);
      orgId = memberOrgIds[0] ?? '';
    }
    if (!orgId && process.env.NODE_ENV === 'development') {
      try {
        const ctx = await orgRepository.ensureDevContext();
        orgId = ctx.orgId;
      } catch {
        orgId = 'dev-org-id';
      }
    }
    if (!orgId) return badRequest('orgId query parameter is required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const accounts = await cloudAccountRepository.list(orgId);
    // Double-check: credentials are never included in mapAccount output
    return ok(accounts);
  } catch (err) {
    console.error('[GET /api/cloud-accounts]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const parsed = await parseBody(req, CreateCloudAccountSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    let orgId = body.orgId ?? '';
    if (!orgId) {
      const memberOrgIds = await resolveOrgIds(identity.userId);
      orgId = memberOrgIds[0] ?? '';
    }
    if (!orgId && process.env.NODE_ENV === 'development') {
      try {
        const ctx = await orgRepository.ensureDevContext();
        orgId = ctx.orgId;
      } catch {
        orgId = 'dev-org-id';
      }
    }
    if (!orgId) return badRequest('orgId is required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role || role === 'viewer') return forbidden();

    // The credentials must belong to the cloud they are saved under.
    const creds = body.credentials as CloudCredentials;
    if ((body.provider === 'aws') !== isAwsCredentials(creds)) return badRequest('The credentials do not match the selected cloud provider.');

    // Serialize credentials for storage — never log this value
    const credentialsJson = JSON.stringify(body.credentials);

    const account = await cloudAccountRepository.create({
      orgId,
      provider: body.provider,
      name: body.name,
      credentialsJson,
      identityJson: JSON.stringify({ authMethod: authMethodOf(creds) }),   // how it signs in — not a secret; the list shows what it may be used for
    });

    // account is the safe shape — credentials are not included
    return created(account);
  } catch (err) {
    console.error('[POST /api/cloud-accounts]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
