import { NextRequest, NextResponse } from 'next/server';
import { ExportService, type ExportInput, type ExportFormat } from '@/lib/services/ExportService';
import { AuthService } from '@/lib/api/authService';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { sanitizeExportInput } from '@/lib/services/exportInput';

export const dynamic = 'force-dynamic';

/**
 * POST /api/export
 *
 * Generates a real downloadable architecture diagram file.
 *
 * Request body:
 * {
 *   format:  'svg' | 'png' | 'pdf';
 *   title:   string;
 *   version?: string;
 *   theme?:  'light' | 'dark';
 *   nodes:   CanvasNode[];
 *   edges:   Array<{ id, source, target, label? }>;
 * }
 *
 * Response: Binary file with Content-Type and Content-Disposition: attachment header.
 * The file contains the actual architecture, not a URL or placeholder.
 */
export async function POST(req: NextRequest) {
  try {
    // Authentication
    const cookieToken = req.cookies.get('cloudbuilder_session')?.value;
    const authHeader = req.headers.get('authorization');
    const bearerToken = authHeader?.toLowerCase().startsWith('bearer ')
      ? authHeader.substring(7).trim()
      : null;
    const token = cookieToken || bearerToken;
    const session = token ? AuthService.getSession(token) : null;

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Rendering PNG/PDF is CPU- and memory-heavy, so it is rate limited per user.
    const rl = await checkRateLimit(`${session.user.id}:export`, 20, 60_000);
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many exports — please wait a moment and try again.' }, { status: 429, headers: rl.retryAfterSeconds ? { 'Retry-After': String(rl.retryAfterSeconds) } : undefined });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    const { format } = body;

    // Validate
    if (!format || !['svg', 'png', 'pdf'].includes(format)) {
      return NextResponse.json(
        { error: 'format must be one of: svg, png, pdf' },
        { status: 400 }
      );
    }

    // Bounded, well-typed input (see exportInput.ts): limits on size, text length and canvas coordinates.
    const cleaned = sanitizeExportInput(body);
    if (!cleaned.ok) return NextResponse.json({ error: cleaned.error }, { status: 400 });
    const input: ExportInput = cleaned.input;

    // Generate real file
    const result = await ExportService.export(input, format as ExportFormat);

    // Return actual binary file with download headers
    return new NextResponse(result.buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Content-Length': String(result.buffer.length),
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error: any) {
    console.error('[/api/export] Error:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'Failed to export architecture' }, { status: 500 });
  }
}
