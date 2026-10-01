/**
 * POST /api/projects/[id]/well-architected-report
 *
 * The dedicated, pillar-by-pillar Well-Architected report (separate from the Architecture & Security Assessment
 * report). Same immutable-snapshot rules: with `scanId` it re-renders that snapshot, without it takes a new one
 * from the persisted architecture. Formats: pdf, html, json.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { internalError, parseBody, ok } from '@/lib/api/response';
import { loadAssessmentReport } from '@/lib/api/assessmentReportContext';
import { AiWaCommentaryInputSchema, buildWaCommentary } from '@/lib/ai/reportCommentary';
import { waPillarViews } from '@/lib/engines/assessment/report/waReportView';
import { renderWaReportPdf } from '@/lib/services/report/renderWaReportPdf';
import { renderWaReportHtml } from '@/lib/services/report/renderWaReportHtml';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Schema = z.object({
  env: z.string().optional().default('production'),
  format: z.enum(['pdf', 'html', 'json']).default('pdf'),
  scanId: z.string().uuid().optional(),
  /** The AI Well-Architected review the user is looking at; validated against the report's own pillars and findings. */
  aiCommentary: AiWaCommentaryInputSchema.optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const parsed = await parseBody(req, Schema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const loaded = await loadAssessmentReport(req, projectId, body, 'wa-report');
    if ('response' in loaded) return loaded.response;
    const { report, scanId, projectName } = loaded;

    if (body.aiCommentary) report.aiWaCommentary = buildWaCommentary(body.aiCommentary, waPillarViews(report), new Date().toISOString());

    const base = `cloudcraft-well-architected-${projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}-rev${report.meta.architectureRevision}-${report.meta.reportId}`;
    if (body.format === 'json') return ok({ report: { ...report, waPillars: waPillarViews(report).map(({ findings, ...p }) => ({ ...p, findingIds: findings.map((f) => f.findingId) })) }, scanId });
    if (body.format === 'html') {
      return new NextResponse(renderWaReportHtml(report), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}.html"`, 'Cache-Control': 'no-store', 'X-Assessment-Scan-Id': scanId },
      });
    }
    const pdf = await renderWaReportPdf(report);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${base}.pdf"`, 'Content-Length': String(pdf.length), 'Cache-Control': 'no-store', 'X-Assessment-Scan-Id': scanId },
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/well-architected-report]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
