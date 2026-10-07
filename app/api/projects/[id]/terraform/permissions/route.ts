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
import { azureRequiredPermissionsFor, azureGrantCommands, checkAzureAccess } from '@/lib/terraform/execution/azurePermissions';
import { isAwsKeyRoleCredentials, isAwsRoleCredentials, isAzureCredentials, type CloudCredentials } from '@/lib/cloud/types';

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
    if (account.provider !== 'aws' && account.provider !== 'azure') return badRequest('This is only for AWS and Azure accounts.');
    const authMethod = typeof account.identity['authMethod'] === 'string' ? account.identity['authMethod'] : undefined;
    const connection = (account.identity['connection'] ?? {}) as { roleArn?: string; clientId?: string; subscriptionId?: string };

    // A key that can deploy by itself has nothing to add.
    if (authMethod === 'access-key-deploy') return ok({ needed: false, authMethod });

    // A check also needs the account's credentials; ask for them while the design is read instead of afterwards (each is a round trip).
    const credentialsPromise = check ? cloudAccountRepository.getCredentials(cloudAccountId, orgId).catch((e: unknown) => e) : null;
    credentialsPromise?.catch(() => undefined);
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
    // Azure grants access by role, not by a policy: say which roles, give the commands, and (on request) read the principal's effective permissions.
    if (account.provider === 'azure') {
      const az = azureRequiredPermissionsFor(generated.files);
      const clientId = connection.clientId ?? '';
      const subscriptionId = connection.subscriptionId ?? '';
      const azureBase = {
        needed: true as const, cloud: 'azure' as const, authMethod: authMethod ?? 'service-principal',
        clientId, subscriptionId, roles: az.roles, providers: az.providers, unknownTypes: az.unknownTypes,
        needsRoleAssignment: az.needsRoleAssignment, terraformTypeCount: az.terraformTypes.length,
        commands: clientId && subscriptionId ? azureGrantCommands(az.roles, clientId, subscriptionId) : '',
      };
      if (!check) return ok(azureBase);
      const rl = await checkRateLimit(`${identity.userId}:terraform-permission-check`, 10, 10 * 60_000);
      if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);
      const stored = await credentialsPromise;
      if (stored instanceof Error) throw stored;
      if (!stored) return notFound('Cloud account credentials');
      const creds = JSON.parse(stored as string) as CloudCredentials;
      if (!isAzureCredentials(creds)) return ok(azureBase);
      let access;
      try {
        const { ClientSecretCredential } = await import('@azure/identity');
        const token = await new ClientSecretCredential(creds.tenantId, creds.clientId, creds.clientSecret).getToken('https://management.azure.com/.default');
        access = await checkAzureAccess({ token: token.token, subscriptionId: creds.subscriptionId, providers: az.providers, needsRoleAssignment: az.needsRoleAssignment });
      } catch (err) {
        access = { state: 'cannot-check' as const, providers: az.providers.map((provider) => ({ provider, allowed: null })), message: `Could not sign in to Azure with the saved service principal (${err instanceof Error ? err.message.slice(0, 120) : 'error'}). Check its client secret on the Cloud Accounts screen.` };
      }
      // The same shape as AWS (one row per "service"), so the card shows both the same way; an Azure row is a resource provider.
      return ok({ ...azureBase, access: { state: access.state, services: access.providers.map((p) => ({ service: p.provider, allowed: p.allowed })), ...(access.message ? { message: access.message } : {}) } });
    }
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

    const credentialsJson = await credentialsPromise;
    if (credentialsJson instanceof Error) throw credentialsJson;
    if (!credentialsJson) return notFound('Cloud account credentials');
    const credentials = JSON.parse(credentialsJson as string) as CloudCredentials;
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
