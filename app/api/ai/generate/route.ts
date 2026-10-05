import { NextRequest, NextResponse } from 'next/server';
import { AiGeneratorService } from '@/lib/services/AiGeneratorService';
import { AuthService } from '@/lib/api/authService';
import { CloudProvider } from '@/types';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import { describeNotices } from '@/lib/ai/serviceCoverage';
import { describeSanitized } from '@/lib/ai/specSanitizer';
import { AI_INPUT_LIMITS, checkText, checkOptionalText, checkAnswers, normalizeProvider } from '@/lib/ai/inputGuard';
import { resolveOrgId } from '@/lib/api/phase2d';
import { getOrgRole } from '@/lib/api/auth';
import { resolveEnvironmentInOrg } from '@/lib/api/tenantScope';

export async function POST(req: NextRequest) {
  try {
    const cookieToken = req.cookies.get('cloudcraft_session')?.value;
    const authHeader = req.headers.get('authorization');
    const bearerToken = authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.substring(7).trim() : null;
    const token = cookieToken || bearerToken;
    const session = token ? AuthService.getSession(token) : null;

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rl = await checkRateLimit(`${session.user.id}:ai-generate`, RATE_LIMITS.AI_GENERATE.limit, RATE_LIMITS.AI_GENERATE.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many AI generation requests — please slow down and try again shortly.' },
        { status: 429, headers: rl.retryAfterSeconds ? { 'Retry-After': String(rl.retryAfterSeconds) } : undefined },
      );
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    const { projectId, environmentId } = body as { projectId?: unknown; environmentId?: unknown };

    const promptCheck = checkText((body as { prompt?: unknown }).prompt, 'prompt', AI_INPUT_LIMITS.prompt);
    if (!promptCheck.ok) return NextResponse.json({ error: promptCheck.error }, { status: 400 });
    const summaryCheck = checkOptionalText((body as { requirementsSummary?: unknown }).requirementsSummary, 'requirementsSummary', AI_INPUT_LIMITS.requirements);
    if (!summaryCheck.ok) return NextResponse.json({ error: summaryCheck.error }, { status: 400 });
    const answersCheck = checkAnswers((body as { answers?: unknown }).answers);
    if (!answersCheck.ok) return NextResponse.json({ error: answersCheck.error }, { status: 400 });
    if (typeof projectId !== 'string' || !projectId || typeof environmentId !== 'string' || !environmentId) {
      return NextResponse.json({ error: 'Missing required parameters: prompt, projectId, environmentId' }, { status: 400 });
    }
    const prompt = promptCheck.value;
    const requirementsSummary = summaryCheck.value;
    const answers = answersCheck.value;
    const validProvider = normalizeProvider((body as { provider?: unknown }).provider);

    // Where the generation is recorded. Only a project of the caller's OWN organisation qualifies: a project/environment id
    // from the request body must never let a caller write into someone else's history. Anything else (a draft, an id of
    // another organisation) still generates — it is just not recorded, and the response is the same, so nothing is revealed.
    let record: { projectId: string; environmentId: string } | null = null;
    const orgId = await resolveOrgId(req, session.user.id);
    if (orgId && (await getOrgRole(session.user.id, orgId))) {
      const scope = await resolveEnvironmentInOrg(environmentId, orgId);
      if (scope && scope.projectId === projectId) record = scope;
    }

    // Generate → compile → run every deploy-readiness gate → repair loop; saves to AIGenerationHistory.
    const result = await AiGeneratorService.generateValidatedArchitecture(
      prompt,
      record?.projectId ?? 'draft-project',
      record?.environmentId ?? '',
      validProvider,
      answers,
      requirementsSummary
    );

    if (!result.ok || !result.graph) {
      // Never hand back a design that failed a gate — say what is still wrong instead.
      // If the request names services CloudCraft cannot model, that is the real reason — say so plainly.
      const names = result.notices.unsupported.map((u) => u.service);
      return NextResponse.json({
        error: names.length
          ? `CloudCraft can't model ${names.join(', ')} yet, so it couldn't build a design that passes validation. Remove ${names.length === 1 ? 'it' : 'them'} from the request, or ask for the closest supported services.`
          : 'The AI could not produce an architecture that passes CloudCraft\'s validation. Try describing the workload more specifically (cloud, region, database, scale).',
        unsupported: result.notices.unsupported,
        issues: result.issues.slice(0, 8),
        stage: result.stage,
        attempts: result.attempts.length,
      }, { status: 422 });
    }

    const warnings = [
      ...(result.needsReview
        ? [`Review before deploying: the AI's design still has ${result.issues.length} point(s) CloudCraft's checks flag — ${result.issues.slice(0, 4).join('; ')}${result.issues.length > 4 ? '; …' : ''}. Fix them on the canvas (the Security and Validate panels show how) before deploying.`]
        : []),
      ...(result.autoRepairs && result.autoRepairs.length > 0
        ? [`CloudCraft corrected ${result.autoRepairs.length} setting(s) the AI got wrong: ${result.autoRepairs.slice(0, 4).join('; ')}${result.autoRepairs.length > 4 ? '; …' : ''}.`]
        : []),
      ...describeNotices(result.notices),
      ...describeSanitized(result.sanitized),
      ...(result.deploymentInputs.length > 0
        ? [`${result.deploymentInputs.length} value(s) must be supplied before this can be deployed: ${result.deploymentInputs.map((d) => `${d.resourceLabel} → ${d.setting}`).join('; ')}`]
        : []),
    ];

    return NextResponse.json({
      success: true,
      graph: result.graph,
      deploymentInputs: result.deploymentInputs,
      notices: result.notices,
      attempts: result.attempts.length,
      needsReview: result.needsReview === true,
      historyId: result.historyId,
      warning: warnings.length ? warnings.join('\n') : undefined,
    });
  } catch (error: any) {
    console.error('AI Generation Error:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'Failed to generate architecture' }, { status: 500 });
  }
}
