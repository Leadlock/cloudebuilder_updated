/**
 * POST /api/cloud/pricing
 * Normalized cloud pricing query endpoint.
 * Supports single query or batch array of queries.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, badRequest, internalError, parseBody } from '@/lib/api/response';
import { cloudProviderPricingService } from '@/lib/cloud/pricing/CloudProviderPricingService';
import type { PriceQuery } from '@/lib/cloud/pricing/types';

export const dynamic = 'force-dynamic';

const SingleQuerySchema = z.object({
  provider: z.enum(['aws', 'azure']),
  service: z.string().optional(),
  resourceType: z.string(),
  region: z.string().default('us-east-1'),
  configuration: z.record(z.string(), z.unknown()).optional().default({}),
});

const BatchQuerySchema = z.object({
  queries: z.array(SingleQuerySchema),
});

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();

    if (raw && Array.isArray(raw.queries)) {
      const parsed = BatchQuerySchema.safeParse(raw);
      if (!parsed.success) return badRequest(parsed.error.message);
      const results = await Promise.all(
        parsed.data.queries.map((q) =>
          cloudProviderPricingService.getPrice(q as PriceQuery)
        )
      );
      return ok({ items: results });
    }

    const parsed = SingleQuerySchema.safeParse(raw);
    if (!parsed.success) return badRequest(parsed.error.message);

    const price = await cloudProviderPricingService.getPrice(
      parsed.data as PriceQuery
    );
    return ok(price);
  } catch (err) {
    console.error('[POST /api/cloud/pricing]', err);
    return internalError();
  }
}
