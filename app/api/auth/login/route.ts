import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ok, badRequest, unauthorized, internalError, parseBody } from '@/lib/api/response';
import { AuthService } from '@/lib/api/authService';

export const dynamic = 'force-dynamic';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, LoginSchema);
    if (!parsed.ok) return parsed.response;

    const { email, password } = parsed.data;
    const user = AuthService.authenticate(email, password);

    if (!user) {
      return unauthorized('Invalid email or password');
    }

    const session = AuthService.createSession(user);

    const response = NextResponse.json({
      success: true,
      user,
      token: session.token,
      expiresAt: session.expiresAt,
    });

    // Set HTTP-only session cookie
    response.cookies.set({
      name: 'cloudcraft_session',
      value: session.token,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60, // 24 hours
    });

    return response;
  } catch (err) {
    console.error('[POST /api/auth/login]', err);
    return internalError();
  }
}
