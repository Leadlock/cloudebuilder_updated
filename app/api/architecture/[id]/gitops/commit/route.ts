import { NextRequest, NextResponse } from 'next/server';
import { GitOpsService } from '@/lib/services/GitOpsService';
import { AuthService } from '@/lib/api/authService';
import { TerraformGenerator, TerraformGenerationInput } from '@/lib/engines/terraform/TerraformGenerator';
import { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';
import { CanvasNode, CanvasEdge } from '@/types';

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
    const { 
      projectId, 
      githubOrg, 
      githubRepo, 
      branch, 
      commitMessage, 
      createPullRequest, 
      githubToken,
      nodes,
      edges
    } = body as {
      projectId: string;
      githubOrg: string;
      githubRepo: string;
      branch: string;
      commitMessage: string;
      createPullRequest: boolean;
      githubToken: string;
      nodes: CanvasNode[];
      edges: CanvasEdge[];
    };

    if (!projectId || !githubOrg || !githubRepo || !branch || !githubToken) {
      return NextResponse.json({ error: 'Missing required GitOps parameters' }, { status: 400 });
    }

    // Convert CanvasNode/Edge to DbArchitectureResource/Connection for TerraformGenerator
    const resources: DbArchitectureResource[] = nodes.map(n => ({
      id: n.id,
      architectureId,
      resourceType: n.resourceType,
      provider: n.provider as any,
      label: n.label,
      groupId: n.groupId || null,
      configJson: JSON.stringify(n.config || {}),
      x: n.position?.x || 0,
      y: n.position?.y || 0,
      positionX: n.position?.x || 0,
      positionY: n.position?.y || 0,
      width: n.width || null,
      height: n.height || null,
      region: (n.config?.region as string) || 'us-east-1',
      locked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const connections: DbArchitectureConnection[] = edges.map(e => ({
      id: e.id,
      architectureId,
      sourceId: e.source,
      targetId: e.target,
      relationshipType: 'connects_to',
      edgeType: (e as any).type || 'default',
      label: e.label?.toString() || null,
      configJson: '{}',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const tfGen = new TerraformGenerator();
    const tfResult = tfGen.generate({
      architectureId,
      projectId,
      resources,
      connections,
      projectName: 'cloudcraft-deployment'
    });

    // Map files for GitHub API
    const files = tfResult.files.map(f => ({
      path: `terraform/${f.filename}`,
      content: f.content
    }));

    // If no terraform files generated, fallback to an empty main.tf
    if (files.length === 0) {
      files.push({
        path: 'terraform/main.tf',
        content: '# No resources to generate'
      });
    }

    const result = await GitOpsService.commitArchitecture({
      projectId,
      githubOrg,
      githubRepo,
      branch,
      commitMessage,
      files,
      createPullRequest,
      githubToken
    });

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('GitOps commit error:', error);
    return NextResponse.json({ error: error.message || 'Failed to commit to GitHub' }, { status: 500 });
  }
}
