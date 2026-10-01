import { NextRequest, NextResponse } from 'next/server';
import { AiGeneratorService } from '@/lib/services/AiGeneratorService';
import { AuthService } from '@/lib/api/authService';
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

    const rl = checkRateLimit(`${session.user.id}:ai-questionnaire`, RATE_LIMITS.AI_GENERATE.limit, RATE_LIMITS.AI_GENERATE.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many discovery requests — please slow down and try again shortly.' },
        { status: 429, headers: rl.retryAfterSeconds ? { 'Retry-After': String(rl.retryAfterSeconds) } : undefined },
      );
    }

    const body = await req.json();
    const { prompt, provider } = body;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return NextResponse.json({ error: 'Missing required parameter: prompt' }, { status: 400 });
    }

    const validProvider = (provider as 'aws' | 'azure') || 'aws';

    const questionnaire = await AiGeneratorService.generateQuestionnaire(
      prompt.trim(),
      validProvider
    );

    return NextResponse.json({
      success: true,
      data: questionnaire,
    });
  } catch (error: any) {
    console.error('AI Questionnaire Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to generate questionnaire' }, { status: 500 });
  }
}
