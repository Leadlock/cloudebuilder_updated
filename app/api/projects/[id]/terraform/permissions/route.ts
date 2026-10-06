/**
 * POST /api/projects/[id]/terraform/permissions — what the connected AWS role needs in order to deploy THIS architecture.
 * Body: { environment?, cloudAccountId, check?: boolean }
 *
 * Without `check` nothing is sent to AWS: the services are read from the Terraform CloudCraft would generate for the saved design and
 * turned into a least-privilege IAM policy the administrator can paste on the role. With `check: true` CloudCraft also asks AWS (read-only,
 * iam:SimulatePrincipalPolicy: nothing is created) whether the role can already create in each of those services.
 *
 * Accounts connected "Simple" (an administrator user's own key) need no extra permissions and get `needed: false`.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, forbidden, unauthorized, badRequest, notFound, internalError, tooManyRequests, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { requireProjectAccess } from '@/lib/api/projectAccess';
import { resolveArchitecture } from '@/lib/api/phase2d';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { credentialsExpiredResponse } from '@/lib/api/credentialErrors';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { resolveExecutionCredentials } from '@/lib/cloud/credentials/resolveExecutionCredentials';
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import { requiredPermissionsFor, checkRoleAccess } from '@/lib/terraform/execution/requiredPermissions';
import { isAwsKeyRoleCredentials, isAwsRoleCredentials, type CloudCredentials } from '@/lib/cloud/types';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  environment: z.string().default('production'),
  cloudAccountId: z.string().min(1),
  check: z.boolean().default(false),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;
    const access = await requireProjectAccess(req, identity.userId, projectId, { adminOnly: true });
    if ('response' in access) return access.response;
    const { orgId } = access;

    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const { environment, cloudAccountId, check } = parsed.data;

    const account = await cloudAccountRepository.findById(cloudAccountId, orgId);
    if (!account) return notFound('Cloud account');
    if (account.provider !== 'aws') return badRequest('This is only for AWS accounts.');
    const authMethod = typeof account.identity['authMethod'] === 'string' ? account.identity['authMethod'] : undefined;
    const connection = (account.identity['connection'] ?? {}) as { roleArn?: string };

    // A key that can deploy by itself has nothing to add.
    if (authMethod === 'access-key-deploy') return ok({ needed: false, authMethod });

    const ctx = await resolveArchitecture(projectId, orgId, environment);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      if (ctx.error === 'architecture_not_found') return badRequest('No saved architecture for this environment yet.');
      return notFound('Environment');
    }
    const generated = terraformGenerator.generate({
      architectureId: ctx.arch.id, projectId, projectName: ctx.project.name.replace(/\s+/g, '-').toLowerCase(),
      resources: ctx.arch.resources, connections: ctx.arch.connections,
    });
    const needed = requiredPermissionsFor(generated.files, connection.roleArn);

    const base = {
      needed: true as const,
      authMethod: authMethod ?? 'role',
      roleArn: connection.roleArn ?? null,
      policy: needed.json,
      services: needed.services,
      unknownTypes: needed.unknownTypes,
      includesIam: needed.includesIam,
      terraformTypeCount: needed.terraformTypes.length,
    };
    if (!check) return ok(base);

    const rl = await checkRateLimit(`${identity.userId}:terraform-permission-check`, 10, 10 * 60_000);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const credentialsJson = await cloudAccountRepository.getCredentials(cloudAccountId, orgId);
    if (!credentialsJson) return notFound('Cloud account credentials');
    const credentials = JSON.parse(credentialsJson) as CloudCredentials;
    if (!isAwsRoleCredentials(credentials) && !isAwsKeyRoleCredentials(credentials)) return ok(base);
    const { IAMClient, SimulatePrincipalPolicyCommand } = await import('@aws-sdk/client-iam');
    const env = await resolveExecutionCredentials(credentials);
    const client = new IAMClient({ region: 'us-east-1', credentials: { accessKeyId: env['AWS_ACCESS_KEY_ID']!, secretAccessKey: env['AWS_SECRET_ACCESS_KEY']!, sessionToken: env['AWS_SESSION_TOKEN'] } });
    const result = await checkRoleAccess({
      client: client as never,
      makeCommand: (input) => new SimulatePrincipalPolicyCommand(input),
      roleArn: credentials.roleArn,
      services: needed.services,
    });
    return ok({ ...base, access: result });
  } catch (err) {
    const expired = credentialsExpiredResponse(err);
    if (expired) return expired;
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 400) return badRequest((err as Error).message);
    console.error('[POST /api/projects/:id/terraform/permissions]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
