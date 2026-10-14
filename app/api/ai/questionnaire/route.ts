import { refuseRestrictedFeature } from '@/lib/api/restrictedFeatureGuard';
import { NextRequest, NextResponse } from 'next/server';
import { AiGeneratorService } from '@/lib/services/AiGeneratorService';
import { realSession } from '@/lib/api/realSession';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import { AI_INPUT_LIMITS, checkText, normalizeProvider } from '@/lib/ai/inputGuard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    // Only a real login is accepted, in every environment (see lib/api/realSession.ts).
    const session = realSession(req);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const closed = refuseRestrictedFeature(session.user.email);
    if (closed) return closed;

    const rl = await checkRateLimit(`${session.user.id}:ai-questionnaire`, RATE_LIMITS.AI_GENERATE.limit, RATE_LIMITS.AI_GENERATE.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many discovery requests — please slow down and try again shortly.' },
        { status: 429, headers: rl.retryAfterSeconds ? { 'Retry-After': String(rl.retryAfterSeconds) } : undefined },
      );
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    const promptCheck = checkText((body as { prompt?: unknown }).prompt, 'prompt', AI_INPUT_LIMITS.prompt);
    if (!promptCheck.ok) return NextResponse.json({ error: promptCheck.error }, { status: 400 });
    const validProvider = normalizeProvider((body as { provider?: unknown }).provider);

    const questionnaire = await AiGeneratorService.generateQuestionnaire(
      promptCheck.value.trim(),
      validProvider
    );

    return NextResponse.json({
      success: true,
      data: questionnaire,
    });
  } catch (error: any) {
    console.error('AI Questionnaire Error:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'Failed to generate questionnaire' }, { status: 500 });
  }
}
