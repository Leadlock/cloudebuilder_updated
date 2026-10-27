/**
 * Authenticates an auditor's request: a bearer token that names one project and framework, read-only, time-limited and revocable.
 * Every refusal is the same 401 with the same words, so the response never says whether a token existed, expired or was revoked.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { apiError, tooManyRequests } from '@/lib/api/response';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { clientIp } from '@/lib/api/authRateLimit';
import { db } from '@/src/prisma/db';
import { readinessRepository, type AuditorAccessRow } from '@/lib/repositories/readinessRepository';
import { auditorAccessUsable, hashAuditorToken, looksLikeAuditorToken } from './auditorToken';
import { isFramework } from './rules';
import type { FrameworkId } from './types';

export interface AuditorCaller { access: AuditorAccessRow; orgId: string; projectId: string; framework: FrameworkId }

const refuse = () => apiError('UNAUTHORIZED', 'This link is not valid. Ask the company for a new one.', 401);

export async function authenticateAuditor(req: NextRequest): Promise<AuditorCaller | { response: NextResponse }> {
  const header = req.headers.get('authorization') ?? '';
  const token = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() : '';
  // Guessing is bounded per address, and a malformed token never reaches the database.
  const ip = await checkRateLimit(`auditor-ip:${clientIp(req)}`, 120, 60_000);
  if (!ip.allowed) return { response: tooManyRequests(ip.retryAfterSeconds) };
  if (!looksLikeAuditorToken(token)) return { response: refuse() };
  const access = await readinessRepository.findAuditorAccess(token);
  if (!access || !auditorAccessUsable(access) || !isFramework(access.framework)) return { response: refuse() };
  const rl = await checkRateLimit(`auditor:${hashAuditorToken(token)}`, 60, 60_000);
  if (!rl.allowed) return { response: tooManyRequests(rl.retryAfterSeconds) };
  const project = await db.orm.public.Project.where({ id: access.projectId }).select('orgId').first() as { orgId: string } | null;
  if (!project) return { response: refuse() };
  await readinessRepository.touchAuditorAccess(access).catch(() => undefined);
  return { access, orgId: project.orgId, projectId: access.projectId, framework: access.framework as FrameworkId };
}
