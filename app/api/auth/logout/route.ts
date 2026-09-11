import { NextRequest, NextResponse } from 'next/server';
import { ok, internalError } from '@/lib/api/response';
import { AuthService } from '@/lib/api/authService';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const cookieToken = req.cookies.get('cloudcraft_session')?.value;
    const authHeader = req.headers.get('authorization');
    const bearerToken = authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.substring(7).trim() : null;

    const token = cookieToken || bearerToken;
    if (token) {
      AuthService.revokeSession(token);
    }

    const response = NextResponse.json({ success: true, message: 'Logged out successfully' });

    // Expire cookie immediately
    response.cookies.set({
      name: 'cloudcraft_session',
      value: '',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });

    return response;
  } catch (err) {
    console.error('[POST /api/auth/logout]', err);
    return internalError();
  }
}
