import { NextRequest, NextResponse } from 'next/server';
import { ExportService, type ExportInput, type ExportFormat } from '@/lib/services/ExportService';
import { AuthService } from '@/lib/api/authService';

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
    const cookieToken = req.cookies.get('cloudcraft_session')?.value;
    const authHeader = req.headers.get('authorization');
    const bearerToken = authHeader?.toLowerCase().startsWith('bearer ')
      ? authHeader.substring(7).trim()
      : null;
    const token = cookieToken || bearerToken;
    const session = token ? AuthService.getSession(token) : null;

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { format, title, version, theme, nodes, edges } = body;

    // Validate
    if (!format || !['svg', 'png', 'pdf'].includes(format)) {
      return NextResponse.json(
        { error: 'format must be one of: svg, png, pdf' },
        { status: 400 }
      );
    }

    if (!Array.isArray(nodes)) {
      return NextResponse.json(
        { error: 'nodes must be an array of CanvasNode' },
        { status: 400 }
      );
    }

    if (nodes.length === 0) {
      return NextResponse.json(
        { error: 'Cannot export an empty canvas. Add at least one resource.' },
        { status: 400 }
      );
    }

    const input: ExportInput = {
      nodes,
      edges: Array.isArray(edges) ? edges : [],
      title: title || 'Architecture',
      version: version || undefined,
      theme: theme === 'dark' ? 'dark' : 'light',
    };

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
    console.error('[/api/export] Error:', error);
    return NextResponse.json(
      { error: error?.message ?? 'Failed to export architecture' },
      { status: 500 }
    );
  }
}
