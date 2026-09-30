import { NextRequest, NextResponse } from 'next/server';
import { AiGeneratorService } from '@/lib/services/AiGeneratorService';
import { AuthService } from '@/lib/api/authService';
import { CloudProvider } from '@/types';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';

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

    // Generates the graph and saves to AIGenerationHistory table
    const result = await AiGeneratorService.generateArchitecture(
      prompt,
      projectId,
      environmentId,
      validProvider,
      answers,
      requirementsSummary
    );


    return NextResponse.json({
      success: true,
      data: result.architectureJson,
      historyId: result.historyId,
      rejectedTypes: result.rejectedTypes,
      warning: result.rejectedTypes.length > 0
        ? `${result.rejectedTypes.length} unsupported resource type(s) were removed: ${result.rejectedTypes.join(', ')}`
        : undefined,
    });
  } catch (error: any) {
    console.error('AI Generation Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to generate architecture' }, { status: 500 });
  }
}
