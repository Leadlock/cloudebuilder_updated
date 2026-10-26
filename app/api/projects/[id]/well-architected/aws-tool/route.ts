/**
 * POST /api/projects/[id]/well-architected/aws-tool — send the project's Well-Architected evidence to the AWS Well-Architected Tool.
 *
 * `dryRun: true` only shows which Framework best practices CloudBuilder has evidence for and what it would select: nothing leaves CloudBuilder.
 * Otherwise (owners and admins only) it creates the project's workload in the connected AWS account's Well-Architected Tool (or finds the one it
 * made before), pre-fills the answers the design supports, and can save a milestone. It never removes a choice a person selected.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, unauthorized, badRequest, notFound, internalError, parseBody, apiError } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { requireProjectAccess } from '@/lib/api/projectAccess';
import { loadAssessmentReport } from '@/lib/api/assessmentReportContext';
import { getSnapshot } from '@/lib/services/AssessmentSnapshotService';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { resolveExecutionCredentials } from '@/lib/cloud/credentials/resolveExecutionCredentials';
import { isAwsCredentials, type CloudCredentials } from '@/lib/cloud/types';
import { createWaToolClient } from '@/lib/wellArchitectedTool/client';
import { evaluatePractices } from '@/lib/wellArchitectedTool/plan';
import { syncWorkload } from '@/lib/wellArchitectedTool/sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const Schema = z.object({
  env: z.string().optional().default('production'),
  dryRun: z.boolean().default(false),
  cloudAccountId: z.string().min(1).optional(),
  region: z.string().regex(REGION, 'Invalid AWS region').optional(),
  milestone: z.boolean().default(false),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const parsed = await parseBody(req, Schema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    // Writing to the account needs an owner or admin; looking at the evidence does not.
    let orgId: string | undefined;
    if (!body.dryRun) {
      const access = await requireProjectAccess(req, identity.userId, projectId, { adminOnly: true });
      if ('response' in access) return access.response;
      orgId = access.orgId;
      if (!body.cloudAccountId || !body.region) return badRequest('Choose the AWS account and the region of the Well-Architected Tool.');
    }

    const loaded = await loadAssessmentReport(req, projectId, { env: body.env }, 'wa-tool', { includeQuestionnaire: true });
    if ('response' in loaded) return loaded.response;
    const snapshot = await getSnapshot(projectId, loaded.scanId);
    if (!snapshot) return notFound('Assessment snapshot');
    const { evaluations, providers, regions, rulesetVersion, evaluatedAt } = snapshot.assessment;
    if (!providers.includes('aws')) return badRequest('This project has no AWS resources: the AWS Well-Architected Tool reviews AWS workloads.');

    if (body.dryRun) return ok({ dryRun: true, practices: evaluatePractices(evaluations), rulesetVersion, evaluatedAt });

    const json = await cloudAccountRepository.getCredentials(body.cloudAccountId as string, orgId as string);
    if (!json) return notFound('Cloud account');
    const credentials = JSON.parse(json) as CloudCredentials;
    if (!isAwsCredentials(credentials)) return badRequest('The selected account is not an AWS account.');
    const env = await resolveExecutionCredentials(credentials);
    if (!env['AWS_ACCESS_KEY_ID'] || !env['AWS_SECRET_ACCESS_KEY']) return apiError('AWS_CREDENTIALS', 'AWS did not give credentials for this account. Check its role.', 502);

    const region = body.region as string;
    const client = createWaToolClient(region, {
      accessKeyId: env['AWS_ACCESS_KEY_ID'], secretAccessKey: env['AWS_SECRET_ACCESS_KEY'], ...(env['AWS_SESSION_TOKEN'] ? { sessionToken: env['AWS_SESSION_TOKEN'] } : {}),
    });
    try {
      const result = await syncWorkload({
        client, project: { id: projectId, name: loaded.projectName, environment: body.env }, regions: regions.length > 0 ? regions : [region],
        reviewOwner: identity.email || 'CloudBuilder', evaluations, rulesetVersion, evaluatedAt, milestone: body.milestone,
      });
      console.info(`[wa-tool] project ${projectId} synced to workload ${result.workloadId} (${result.created ? 'created' : 'updated'}), ${result.answered.length} answers pre-filled`);
      return ok({ ...result, region, consoleUrl: `https://${region}.console.aws.amazon.com/wellarchitected/home?region=${region}#/workload/${result.workloadId}` });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      const message = e instanceof Error ? e.message : String(e);
      if (name === 'AccessDeniedException') return apiError('AWS_ACCESS_DENIED', 'The AWS account may not use the Well-Architected Tool: its role needs the wellarchitected permissions (for example the WellArchitectedConsoleFullAccess policy).', 403);
      console.error('[POST well-architected/aws-tool]', name, message);
      return apiError('AWS_TOOL_ERROR', `The AWS Well-Architected Tool refused the request: ${message}`, 502);
    }
  } catch (err) {
    console.error('[POST /api/projects/:id/well-architected/aws-tool]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
