/**
 * Request schema for saving canvas nodes/edges (used by
 * app/api/projects/[id]/canvas/route.ts). Lives in its own module, with no
 * database imports, so it can be unit-tested directly — see
 * __tests__/canvasApiSchema.test.ts — without pulling in the Prisma/db chain
 * the route itself needs.
 */
import { z } from 'zod';

export const CanvasNodeSchema = z.object({
  id:           z.string(),
  type:         z.string().default('cloudNode'),
  resourceType: z.string(),
  // 'gcp' is accepted here only so saves of pre-existing architectures that
  // still contain legacy GCP nodes (created before GCP support was removed)
  // don't 400 on an unrelated edit. No current UI/RDE path can create a new
  // 'gcp' node — see types/index.ts CloudProvider.
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

export const CanvasEdgeSchema = z.object({
  id:       z.string(),
  source:   z.string(),
  target:   z.string(),
  label:    z.string().optional().nullable(),
  // Matches CanvasEdge['edgeType'] in types/index.ts, which is effectively an
  // open string (relationship types like 'LOAD_BALANCES'/'CONNECTS_TO'/etc.
  // from lib/domain/relationshipModel.ts, not the old fixed 4-value set).
  // A narrow z.enum() here previously silently 400'd every save whose edges
  // used a real relationship type instead of one of those four legacy
  // strings — i.e. most template-generated and RelationshipEngine-suggested
  // edges. See __tests__/canvasApiSchema.test.ts for the regression test.
  edgeType: z.string().optional().nullable(),
}).passthrough();

export const SaveCanvasSchema = z.object({
  env:          z.enum(['development', 'staging', 'production']).optional().default('production'),
  nodes:        z.array(CanvasNodeSchema),
  edges:        z.array(CanvasEdgeSchema),
  revision:     z.number().optional(),
  scaleProfile: z.record(z.string(), z.unknown()).optional(),
});
