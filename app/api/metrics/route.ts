import { NextRequest, NextResponse } from 'next/server';
import { ObservabilityService, type MetricsRequest } from '@/lib/services/ObservabilityService';

export const dynamic = 'force-dynamic';

/**
 * POST /api/metrics
 *
 * Fetches real cloud monitoring metrics for a set of canvas resources.
 * Each resource must supply its cloud provider, actual cloud resource ID, type, and region.
 *
 * Request body:
 * {
 *   resources: Array<{
 *     nodeId:       string;  // CloudCraft canvas node ID (used as map key in response)
 *     provider:     'aws' | 'azure' | 'gcp';
 *     resourceId:   string;  // The actual cloud resource identifier (EC2 instance ID, Azure resource path, etc.)
 *     resourceType: string;  // CloudCraft RDE type e.g. aws_ec2, gcp_compute_instance
 *     region:       string;
 *   }>
 * }
 *
 * Response:
 * {
 *   [nodeId]: ResourceMetrics
 * }
 *
 * NEVER returns synthetic/random metric values.
 * Returns { status: 'unavailable', unavailableReason: '...' } when credentials or data are missing.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (!Array.isArray(body?.resources)) {
      return NextResponse.json(
        { error: 'Request body must contain a "resources" array.' },
        { status: 400 }
      );
    }

    const resources: Array<{
      nodeId: string;
      provider: string;
      resourceId: string;
      resourceType: string;
      region: string;
    }> = body.resources;

    if (resources.length === 0) {
      return NextResponse.json({});
    }

    if (resources.length > 50) {
      return NextResponse.json(
        { error: 'Maximum 50 resources per batch request.' },
        { status: 400 }
      );
    }

    // Validate required fields
    for (const r of resources) {
      if (!r.nodeId || !r.provider || !r.resourceId || !r.region) {
        return NextResponse.json(
          { error: `Each resource must have nodeId, provider, resourceId, and region. Missing in: ${JSON.stringify(r)}` },
          { status: 400 }
        );
      }
    }

    // Fetch metrics in parallel
    const results = await Promise.all(
      resources.map(async (r) => {
        const metricsReq: MetricsRequest = {
          provider: r.provider as 'aws' | 'azure' | 'gcp',
          resourceId: r.resourceId,
          resourceType: r.resourceType || '',
          region: r.region,
          // Credentials come from environment variables in ObservabilityService
          // Never pass credentials through the API body for security
        };
        const metrics = await ObservabilityService.getResourceMetrics(metricsReq);
        return [r.nodeId, metrics] as [string, typeof metrics];
      })
    );

    const metricsMap = Object.fromEntries(results);
    return NextResponse.json(metricsMap);
  } catch (error: any) {
    console.error('[/api/metrics] Error:', error);
    return NextResponse.json(
      { error: error?.message ?? 'Failed to fetch metrics' },
      { status: 500 }
    );
  }
}
