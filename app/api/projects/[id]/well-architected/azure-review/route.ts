/**
 * POST /api/projects/[id]/well-architected/azure-review — the Azure Well-Architected review sheet of a project: Microsoft's design review checklists,
 * pre-filled from the architecture and the team's answers (lib/azureReview). `format: "md"` downloads it as a Markdown file, `"json"` returns the data.
 * Read-only: nothing is sent anywhere. Any member of the organization may read it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ok, internalError, notFound, badRequest, parseBody } from '@/lib/api/response';
import { loadAssessmentReport } from '@/lib/api/assessmentReportContext';
import { getSnapshot } from '@/lib/services/AssessmentSnapshotService';
import { azureReviewMarkdown, buildAzureReview } from '@/lib/azureReview/review';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Schema = z.object({ env: z.string().optional().default('production'), format: z.enum(['md', 'json']).default('json') });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const parsed = await parseBody(req, Schema);
    if (!parsed.ok) return parsed.response;
    const { env, format } = parsed.data;

    const loaded = await loadAssessmentReport(req, projectId, { env }, 'azure-review', { includeQuestionnaire: true });
    if ('response' in loaded) return loaded.response;
    const snapshot = await getSnapshot(projectId, loaded.scanId);
    if (!snapshot) return notFound('Assessment snapshot');
    const a = snapshot.assessment;
    if (!a.providers.includes('azure')) return badRequest('This project has no Azure resources: the Azure Well-Architected review sheet is for Azure workloads.');

    const review = buildAzureReview(a.evaluations, { project: loaded.projectName, environment: env, rulesetVersion: a.rulesetVersion, evaluatedAt: a.evaluatedAt });
    if (format === 'json') return ok({ review });
    const name = `azure-well-architected-${loaded.projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.md`;
    return new NextResponse(azureReviewMarkdown(review), {
      status: 200,
      headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/well-architected/azure-review]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
