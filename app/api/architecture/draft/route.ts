/**
 * GET  /api/architecture/draft — load durable draft architecture
 * PUT  /api/architecture/draft — save durable draft architecture with 409 conflict detection
 * DELETE /api/architecture/draft — clear draft architecture
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { draftRepository } from '@/lib/repositories/draftRepository';
import { orgRepository } from '@/lib/repositories/orgRepository';
import type { CanvasNode, CanvasEdge, ProviderMode, ScaleProfile } from '@/types';

export const dynamic = 'force-dynamic';

const CanvasNodeSchema = z.object({
  id:           z.string(),
  type:         z.string().default('cloudNode'),
  resourceType: z.string(),
  provider:     z.enum(['aws', 'azure', 'gcp']),
  label:        z.string(),
  position:     z.object({ x: z.number(), y: z.number() }),
  config:       z.record(z.string(), z.unknown()).optional().default({}),
  region:       z.string().optional().nullable(),
  groupId:      z.string().optional().nullable(),
  parentId:     z.string().optional().nullable(),
  width:        z.number().optional().nullable(),
  height:       z.number().optional().nullable(),
  locked:       z.boolean().optional().nullable(),
  selected:     z.boolean().optional().nullable(),
  importState:  z.string().optional().nullable(),
}).passthrough();

const CanvasEdgeSchema = z.object({
  id:               z.string(),
  source:           z.string(),
  target:           z.string(),
  label:            z.string().optional().nullable(),
  edgeType:         z.string().optional().nullable(),
  relationshipType: z.string().optional().nullable(),
  networkScope:     z.string().optional().nullable(),
  direction:        z.string().optional().nullable(),
  protocol:         z.string().optional().nullable(),
  port:             z.union([z.string(), z.number()]).optional().nullable(),
  validationStatus: z.string().optional().nullable(),
}).passthrough();

const SaveDraftSchema = z.object({
  nodes:        z.array(CanvasNodeSchema),
  edges:        z.array(CanvasEdgeSchema),
  providerMode: z.enum(['AWS', 'AZURE', 'GCP', 'MULTI_CLOUD']).optional(),
  scaleProfile: z.record(z.string(), z.unknown()).optional(),
  revision:     z.number().optional(),
});

function resolveDraftKey(req: NextRequest, identityUserId?: string): string {
  const customKey = req.nextUrl.searchParams.get('key');
  if (customKey) return customKey;
  if (identityUserId) return `usr-${identityUserId}`;
  const cookieSession = req.cookies.get('cloudcraft_session')?.value;
  if (cookieSession) return `sess-${cookieSession.slice(0, 16)}`;
  return 'default-user-draft';
}

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    const key = resolveDraftKey(req, identity?.userId);
    const draft = await draftRepository.getDraft(key);
    return ok(draft);
  } catch (err) {
    console.error('[GET /api/architecture/draft]', err);
    return internalError();
  }
}

export async function PUT(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    const key = resolveDraftKey(req, identity?.userId);

    const parsed = await parseBody(req, SaveDraftSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const result = await draftRepository.saveDraft(key, {
      userId: identity?.userId,
      nodes: body.nodes as CanvasNode[],
      edges: body.edges as CanvasEdge[],
      providerMode: body.providerMode as ProviderMode | undefined,
      scaleProfile: body.scaleProfile as unknown as ScaleProfile | undefined,
      revision: body.revision,
    });

    if (result.conflict) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: 'CONFLICT',
            message: 'A newer draft revision exists on the server.',
            serverRevision: result.serverRevision,
            clientRevision: body.revision,
          },
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return ok({
      draft: result.draft,
      revision: result.draft.revision,
      hash: result.draft.hash,
    });
  } catch (err) {
    console.error('[PUT /api/architecture/draft]', err);
    return internalError();
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    const key = resolveDraftKey(req, identity?.userId);
    const cleared = await draftRepository.clearDraft(key);
    return ok({ cleared });
  } catch (err) {
    console.error('[DELETE /api/architecture/draft]', err);
    return internalError();
  }
}
