/**
 * GET /api/projects/[id]/well-architected/questions  — the questionnaire and this project's answers
 * PUT /api/projects/[id]/well-architected/questions  — save (or clear) answers
 *
 * The questions are the practices a diagram cannot show (backups restored, on-call, who owns the budget). Answers belong to the
 * project, not to an environment. They feed the Well-Architected review (see lib/engines/assessment/questionnaire).
 *
 * Auth: extractIdentity + org membership. Writing needs the owner, admin or member role.
 */
import { NextRequest } from 'next/server';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, tooManyRequests, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { wellArchitectedAnswerRepository } from '@/lib/repositories/wellArchitectedAnswerRepository';
import { QUESTIONS, QUESTIONS_BY_ID } from '@/lib/engines/assessment/questionnaire/questions';
import { AnswersSchema } from '@/lib/api/schemas/waAnswers';
import { AWS_PILLARS, AZURE_PILLARS } from '@/lib/engines/wellArchitected/frameworkDefinitions';

export const dynamic = 'force-dynamic';

const PILLAR_LABEL = Object.fromEntries([...AWS_PILLARS, ...AZURE_PILLARS].map((p) => [p.id, p.label])) as Record<string, string>;

async function authorise(req: NextRequest, projectId: string, write: boolean) {
  const identity = extractIdentity(req);
  if (!identity) return { response: unauthorized() };
  const orgId = await resolveOrgId(req, identity.userId);
  if (!orgId) return { response: badRequest('orgId required') };
  const role = await getOrgRole(identity.userId, orgId);
  if (!role) return { response: forbidden() };
  if (write && !['owner', 'admin', 'member'].includes(role)) return { response: forbidden('Insufficient permissions') };
  const project = await projectRepository.findById(projectId, orgId);
  if (!project) return { response: notFound('Project') };
  return { identity, orgId, project };
}

async function payload(projectId: string) {
  const rows = await wellArchitectedAnswerRepository.list(projectId);
  const answers = Object.fromEntries(rows.map((r) => [r.questionId, { answer: r.answer, note: r.note, updatedAt: r.updatedAt }]));
  return {
    questions: QUESTIONS.map((q) => ({
      id: q.id, pillar: q.pillar, pillarLabel: PILLAR_LABEL[q.pillar] ?? q.pillar, providers: q.providers, severity: q.severity,
      question: q.question, why: q.why, gap: q.gap, recommendation: q.recommendation, steps: q.steps, practice: q.practice,
    })),
    answers,
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const auth = await authorise(req, projectId, false);
    if ('response' in auth) return auth.response;
    return ok(await payload(projectId));
  } catch (err) {
    console.error('[GET /api/projects/:id/well-architected/questions]', err instanceof Error ? err.message : err);
    return internalError();
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const auth = await authorise(req, projectId, true);
    if ('response' in auth) return auth.response;

    const rl = await checkRateLimit(`${auth.identity.userId}:wa-answers`, RATE_LIMITS.ANALYSIS.limit * 4, RATE_LIMITS.ANALYSIS.windowMs);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const parsed = await parseBody(req, AnswersSchema);
    if (!parsed.ok) return parsed.response;

    const unknown = parsed.data.answers.filter((a) => !QUESTIONS_BY_ID.has(a.questionId)).map((a) => a.questionId);
    if (unknown.length > 0) return badRequest(`Unknown question: ${unknown.slice(0, 3).join(', ')}`);

    await wellArchitectedAnswerRepository.apply(
      projectId,
      parsed.data.answers.map((a) => ({ questionId: a.questionId, answer: a.answer as never, note: a.note?.trim() })),
      auth.identity.userId,
    );
    return ok(await payload(projectId));
  } catch (err) {
    console.error('[PUT /api/projects/:id/well-architected/questions]', err instanceof Error ? err.message : err);
    return internalError();
  }
}
