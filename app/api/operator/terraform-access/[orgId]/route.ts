/**
 * PUT /api/operator/terraform-access/[orgId] — an operator approves, denies or revokes an organization's Terraform access.
 * Body: { action: "approve" | "deny" | "revoke", note?: string }. Takes effect at once.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, forbidden, unauthorized, internalError, notFound, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { db } from '@/src/prisma/db';
import { decideAccess, isOperatorEmail } from '@/lib/terraform/access/service';

export const dynamic = 'force-dynamic';

const Body = z.object({ action: z.enum(['approve', 'deny', 'revoke']), note: z.string().max(300).optional() });

export async function PUT(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    if (!(await isOperatorEmail(identity.email))) return forbidden('Only a platform operator can decide on access.');
    const parsed = await parseBody(req, Body);
    if (!parsed.ok) return parsed.response;
    const { orgId } = await params;
    const org = await db.orm.public.Organization.where({ id: orgId }).first().catch(() => null);
    if (!org) return notFound('Organization');
    const record = await decideAccess({ userId: identity.userId, email: identity.email as string }, orgId, parsed.data.action, parsed.data.note);
    return ok({ status: record.status, decidedBy: record.decidedBy, note: record.note });
  } catch (err) {
    console.error('[PUT operator/terraform-access]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
