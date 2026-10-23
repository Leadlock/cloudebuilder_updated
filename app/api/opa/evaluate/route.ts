/**
 * /api/opa/evaluate
 * POST - Evaluate current canvas, cost, or plan against active OPA Rego policies
 */

import { NextRequest } from 'next/server';
import { ok, internalError } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { opaPolicyService } from '@/lib/opa/opaPolicyService';
import type { OpaEvaluationInput } from '@/lib/opa/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    const orgId = identity ? await resolveOrgId(req, identity.userId) : undefined;
    const body: OpaEvaluationInput = await req.json().catch(() => ({}));

    const result = await opaPolicyService.evaluate(body, orgId ?? undefined);
    return ok(result);
  } catch (err) {
    console.error('[POST /api/opa/evaluate]', err);
    return internalError();
  }
}
