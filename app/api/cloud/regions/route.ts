/**
 * GET /api/cloud/regions
 * Returns authoritative cloud regions for AWS, Azure, or all providers.
 */
import { NextRequest } from 'next/server';
import { ok } from '@/lib/api/response';
import { cloudRegionService } from '@/lib/cloud/regions/CloudRegionService';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const provider = (searchParams.get('provider') || 'all').toLowerCase();

  const regions = cloudRegionService.getRegions(
    provider === 'aws' ? 'aws' : provider === 'azure' ? 'azure' : 'all'
  );

  return ok({
    provider,
    count: regions.length,
    regions,
  });
}
