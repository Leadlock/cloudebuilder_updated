/**
 * POST /api/ai/review — AI review of an architecture (optionally answering a question about it).
 *
 * The client sends the live canvas (nodes + edges), like the cost-comparison route does, so the review
 * reflects what the user is looking at rather than the last autosave. Scores and findings come from
 * CloudCraft's own analysis engine; the model only explains and prioritises them (see AiReviewService).
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, badRequest, unauthorized, internalError, tooManyRequests, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import { AiReviewService } from '@/lib/services/AiReviewService';
import type { CanvasNode, CanvasEdge } from '@/types';

export const dynamic = 'force-dynamic';

const NodeSchema = z.object({
  id: z.string().min(1),
  resourceType: z.string().min(1),
  provider: z.string(),
  label: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

const EdgeSchema = z.object({ id: z.string().min(1), source: z.string().min(1), target: z.string().min(1) }).passthrough();

const RequestSchema = z.object({
  nodes: z.array(NodeSchema).max(500),
  edges: z.array(EdgeSchema).max(1500).default([]),
  question: z.string().trim().min(1).max(500).optional(),
  mode: z.enum(['general', 'security', 'well-architected']).default('general'),
});

export async function POST(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const rl = checkRateLimit(`${identity.userId}:ai-review`, RATE_LIMITS.AI_GENERATE.limit, RATE_LIMITS.AI_GENERATE.windowMs);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const { nodes, edges, question, mode } = parsed.data;
    if (nodes.length === 0) return badRequest('There is nothing to review yet — add resources to the canvas first.');

    const args = { nodes: nodes as unknown as CanvasNode[], edges: edges as unknown as CanvasEdge[], question };
    const review = mode === 'security' ? await AiReviewService.reviewSecurity(args)
      : mode === 'well-architected' ? await AiReviewService.reviewWellArchitected(args)
      : await AiReviewService.review(args);
    return ok(review);
  } catch (err) {
    console.error('[POST /api/ai/review]', err instanceof Error ? err.message : String(err));
    return internalError('The AI review could not be completed. Please try again.');
  }
}
