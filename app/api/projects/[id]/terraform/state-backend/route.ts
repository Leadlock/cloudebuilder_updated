/**
 * POST /api/projects/[id]/terraform/state-backend — create the remote Terraform state storage in the caller's own cloud account.
 *
 * Only runs when an Administrator clicks "Create state storage". It is idempotent and never deletes anything: storage that already
 * exists in the account is reused. The response names what was created so the form can be filled with the exact values.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { AwsBackendSchema, AzureBackendSchema } from '@/lib/terraform/execution/backendSchema';
import { ok, forbidden, unauthorized, badRequest, notFound, tooManyRequests, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { requireProjectAccess } from '@/lib/api/projectAccess';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { resolveExecutionCredentials } from '@/lib/cloud/credentials/resolveExecutionCredentials';
import { assertTerraformCapable } from '@/lib/cloud/terraformCapability';
import {
  ensureAwsStateBackend, awsClientsFromEnv, ensureAzureStateBackend, azureClientsFromEnv, StateBackendError,
} from '@/lib/terraform/execution/stateBackendProvisioner';
import { isAwsCredentials, isAzureCredentials, type CloudCredentials } from '@/lib/cloud/types';

export const dynamic = 'force-dynamic';

// The bucket and key may be left empty: CloudCraft then picks a unique bucket name.
const AwsCreate = AwsBackendSchema.partial({ bucket: true, key: true });
const AzureCreate = AzureBackendSchema.partial({ key: true }).extend({ location: z.string().regex(/^[a-z0-9]{3,30}$/, 'Invalid Azure region').default('eastus') });
const RequestSchema = z.object({
  cloudAccountId: z.string().min(1),
  stateBackend: z.discriminatedUnion('provider', [AwsCreate, AzureCreate]),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required to create state storage');
    if (identity.role !== 'admin') return forbidden('Access denied: creating state storage is restricted to Administrators.');

    const { id: projectId } = await params;
    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const { cloudAccountId, stateBackend } = parsed.data;

    const access = await requireProjectAccess(req, identity.userId, projectId, { adminOnly: true });
    if ('response' in access) return access.response;
    const { orgId } = access;

    const denied = await terraformExecutionDenied(identity.userId, orgId);
    if (denied) {
      await recordTerraformAudit({ action: 'state-backend', outcome: 'denied', orgId, projectId, userId: identity.userId, detail: denied });
      return forbidden(denied);
    }
    const rl = await checkRateLimit(`${identity.userId}:terraform-state-backend`, 10, 10 * 60_000);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const credentialsJson = await cloudAccountRepository.getCredentials(cloudAccountId, orgId);
    if (!credentialsJson) return notFound('Cloud account');
    const credentials = JSON.parse(credentialsJson) as CloudCredentials;
    try {
      assertTerraformCapable(credentials);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : 'This account cannot create storage');
    }
    if (stateBackend.provider === 'aws' ? !isAwsCredentials(credentials) : !isAzureCredentials(credentials)) {
      return badRequest(`The selected account is not an ${stateBackend.provider.toUpperCase()} account.`);
    }

    await recordTerraformAudit({ action: 'state-backend', outcome: 'requested', orgId, projectId, userId: identity.userId, detail: `${stateBackend.provider} state storage` });
    try {
      const env = await resolveExecutionCredentials(credentials);
      const result = stateBackend.provider === 'aws'
        ? await ensureAwsStateBackend(stateBackend, awsClientsFromEnv(env, stateBackend.region))
        : await ensureAzureStateBackend(stateBackend, stateBackend.location, await azureClientsFromEnv(env));
      await recordTerraformAudit({
        action: 'state-backend', outcome: 'succeeded', orgId, projectId, userId: identity.userId,
        detail: result.steps.map((s) => `${s.outcome}: ${s.what}`).join('; '),
      });
      return ok(result);
    } catch (err) {
      const message = err instanceof StateBackendError ? err.message : 'Could not create the state storage. See the server log for the cloud provider\'s reason.';
      // Log the provider's reason (names/codes only, never credentials) for the operator; the user gets the explained message.
      console.error('[POST /api/projects/:id/terraform/state-backend]', err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : 'unknown error');
      await recordTerraformAudit({ action: 'state-backend', outcome: 'failed', orgId, projectId, userId: identity.userId, detail: message });
      return err instanceof StateBackendError && err.statusCode === 403 ? forbidden(message) : badRequest(message);
    }
  } catch (err) {
    console.error('[POST /api/projects/:id/terraform/state-backend]', err instanceof Error ? err.message : 'failed');
    return badRequest('Could not create the state storage');
  }
}
