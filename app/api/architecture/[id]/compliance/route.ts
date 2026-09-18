import { NextRequest, NextResponse } from 'next/server';
import { ComplianceEngine } from '@/lib/engines/compliance/ComplianceEngine';
import { AuthService } from '@/lib/api/authService';
import { CanvasNode } from '@/types';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const params = await props.params;
    const cookieToken = req.cookies.get('cloudcraft_session')?.value;
    const authHeader = req.headers.get('authorization');
    const bearerToken = authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.substring(7).trim() : null;
    const token = cookieToken || bearerToken;
    const session = token ? AuthService.getSession(token) : null;

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const architectureId = params.id;
    const body = await req.json();
    const { projectId, resources, frameworks } = body as {
      projectId: string;
      resources: CanvasNode[];
      frameworks: ('SOC2' | 'HIPAA' | 'PCI-DSS')[];
    };

    if (!projectId || !resources || !frameworks || !Array.isArray(frameworks)) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const result = await ComplianceEngine.evaluateArchitecture(projectId, architectureId, resources, frameworks);

    return NextResponse.json(result);
  } catch (error) {
    console.error('Compliance evaluation error:', error);
    return NextResponse.json({ error: 'Failed to run compliance evaluation' }, { status: 500 });
  }
}
