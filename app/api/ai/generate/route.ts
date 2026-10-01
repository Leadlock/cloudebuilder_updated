import { NextRequest, NextResponse } from 'next/server';
import { AiGeneratorService } from '@/lib/services/AiGeneratorService';
import { AuthService } from '@/lib/api/authService';
import { CloudProvider } from '@/types';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import { describeNotices } from '@/lib/ai/serviceCoverage';
import { describeSanitized } from '@/lib/ai/specSanitizer';

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

    const rl = checkRateLimit(`${session.user.id}:ai-generate`, RATE_LIMITS.AI_GENERATE.limit, RATE_LIMITS.AI_GENERATE.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many AI generation requests — please slow down and try again shortly.' },
        { status: 429, headers: rl.retryAfterSeconds ? { 'Retry-After': String(rl.retryAfterSeconds) } : undefined },
      );
    }

    const body = await req.json();
    const { prompt, projectId, environmentId, provider, answers, requirementsSummary } = body;

    if (!prompt || !projectId || !environmentId) {
      return NextResponse.json({ error: 'Missing required parameters: prompt, projectId, environmentId' }, { status: 400 });
    }

    const validProvider = (provider as 'aws' | 'azure') || 'aws';

    // Generate → compile → run every deploy-readiness gate → repair loop; saves to AIGenerationHistory.
    const result = await AiGeneratorService.generateValidatedArchitecture(
      prompt,
      projectId,
      environmentId,
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
      historyId: result.historyId,
      warning: warnings.length ? warnings.join('\n') : undefined,
    });
  } catch (error: any) {
    console.error('AI Generation Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to generate architecture' }, { status: 500 });
  }
}
