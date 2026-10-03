import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ObservabilityService, type MetricsRequest } from '@/lib/services/ObservabilityService';
import { extractIdentity } from '@/lib/api/auth';
import { badRequest, unauthorized, internalError, tooManyRequests, parseBody } from '@/lib/api/response';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/metrics
 *
 * Fetches real cloud monitoring metrics for a set of canvas resources, using the server's configured cloud credentials.
 * Because those credentials belong to the server, this requires a signed-in user and every identifier is validated
 * strictly: an Azure resource id is placed into a management-API URL, so it must be a plain ARM resource path (no
 * query string, fragment or `..`), and an AWS id is only ever used as a CloudWatch dimension value.
 *
 * Request body:  { resources: Array<{ nodeId, provider: 'aws'|'azure', resourceId, resourceType?, region }> }
 * Response:      { [nodeId]: ResourceMetrics }
 *
 * NEVER returns synthetic/random metric values.
 * Returns { status: 'unavailable', unavailableReason: '...' } when credentials or data are missing.
 */

const AZURE_RESOURCE_ID = /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[\w.()-]{1,90}\/providers\/[\w.]+(?:\/[\w.-]+){2,10}$/;
const AWS_RESOURCE_ID = /^[A-Za-z0-9_:/.@=+-]{1,512}$/;

const ResourceSchema = z.object({
  nodeId: z.string().min(1).max(128),
  provider: z.enum(['aws', 'azure']),
  resourceId: z.string().min(1).max(1024),
  resourceType: z.string().max(100).regex(/^[a-z0-9_]*$/).optional().default(''),
  region: z.string().regex(/^[a-z0-9-]{2,40}$/, 'Invalid region'),
}).superRefine((r, ctx) => {
  const valid = r.provider === 'azure' ? AZURE_RESOURCE_ID.test(r.resourceId) && !r.resourceId.includes('..') : AWS_RESOURCE_ID.test(r.resourceId);
  if (!valid) ctx.addIssue({ code: 'custom', path: ['resourceId'], message: `Invalid ${r.provider} resource id` });
});

const RequestSchema = z.object({ resources: z.array(ResourceSchema).max(50, 'Maximum 50 resources per batch request.') });

export async function POST(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const rl = await checkRateLimit(`${identity.userId}:metrics`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const { resources } = parsed.data;
    if (resources.length === 0) return NextResponse.json({});
    if (new Set(resources.map((r) => r.nodeId)).size !== resources.length) return badRequest('Each resource needs a unique nodeId.');

    const results = await Promise.all(
      resources.map(async (r) => {
        const metricsReq: MetricsRequest = {
          provider: r.provider,
          resourceId: r.resourceId,
          resourceType: r.resourceType,
          region: r.region,
          // Credentials come from environment variables in ObservabilityService; never from the request body.
        };
        const metrics = await ObservabilityService.getResourceMetrics(metricsReq);
        return [r.nodeId, metrics] as [string, typeof metrics];
      }),
    );

    return NextResponse.json(Object.fromEntries(results));
  } catch (error) {
    // Log the message only: a full error object from a cloud SDK can carry request details.
    console.error('[/api/metrics]', error instanceof Error ? error.message : String(error));
    return internalError('Failed to fetch metrics');
  }
}
