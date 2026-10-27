/**
 * /api/projects/[id]/readiness/[framework]/auditor-access   (owner or admin)
 *
 * GET  — the read-only links given to auditors for this framework (never the tokens).
 * POST — give an auditor read-only access for a limited time. The link is returned once; only its hash is stored. The auditor can read the report, the controls
 *        and the evidence linked to this framework, and download the package. They cannot change anything and cannot see anything else in the project.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, badRequest, internalError, parseBody } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { MAX_AUDITOR_DAYS, auditorLink } from '@/lib/compliance/auditorAccess';
import { readinessRepository } from '@/lib/repositories/readinessRepository';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  days: z.number().int().min(1).max(MAX_AUDITOR_DAYS).default(14),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params, { adminOnly: true });
    if ('response' in caller) return caller.response;
    return ok({ access: await readinessRepository.auditorAccesses(caller.projectId, caller.framework) });
  } catch (err) {
    console.error('[GET readiness auditor-access]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params, { adminOnly: true, limitKey: 'readiness-auditor' });
    if ('response' in caller) return caller.response;
    const parsed = await parseBody(req, Schema);
    if (!parsed.ok) return parsed.response;
    const active = (await readinessRepository.auditorAccesses(caller.projectId, caller.framework)).filter((a) => !a.revokedAt && Date.parse(a.expiresAt) > Date.now());
    if (active.length >= 10) return badRequest('Ten auditor links are already active. Revoke one first.');
    const expiresAt = new Date(Date.now() + parsed.data.days * 86_400_000).toISOString();
    const { row, token } = await readinessRepository.createAuditorAccess(caller.projectId, caller.framework, { name: parsed.data.name, email: parsed.data.email, expiresAt, createdBy: caller.email });
    return created({ access: row, token, link: auditorLink(req.nextUrl.origin, token), note: 'Copy the link now. It is shown once and cannot be retrieved again; revoke it and make a new one if it is lost.' });
  } catch (err) {
    console.error('[POST readiness auditor-access]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
