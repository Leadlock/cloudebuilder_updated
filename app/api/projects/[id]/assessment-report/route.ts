/**
 * POST /api/projects/[id]/assessment-report
 *
 * Generates the professional Architecture & Security Assessment report from an
 * IMMUTABLE assessment snapshot:
 *  - with `scanId`: re-renders that snapshot (identical results even if the
 *    architecture changed since);
 *  - without: runs the engine on the persisted architecture, stores a new
 *    snapshot, and renders it.
 * Formats: pdf (pdfkit, structured — not a screenshot), html, json.
 * Includes a comparison with the previous snapshot of the same architecture.
 * (The pillar-by-pillar Well-Architected report is a separate endpoint: ../well-architected-report.)
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { internalError, parseBody, ok } from '@/lib/api/response';
import { loadAssessmentReport } from '@/lib/api/assessmentReportContext';
import { renderReportPdf } from '@/lib/services/report/renderReportPdf';
import { renderReportHtml } from '@/lib/services/report/renderReportHtml';
import { AiCommentaryInputSchema, buildCommentary } from '@/lib/ai/reportCommentary';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Schema = z.object({
  env: z.string().optional().default('production'),
  format: z.enum(['pdf', 'html', 'json']).default('pdf'),
  scanId: z.string().uuid().optional(),
  /** The AI security review the user is looking at; validated against the report's own findings. */
  aiCommentary: AiCommentaryInputSchema.optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const parsed = await parseBody(req, Schema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const loaded = await loadAssessmentReport(req, projectId, body, 'assessment-report');
    if ('response' in loaded) return loaded.response;
    const { report, scanId, projectName } = loaded;

    if (body.aiCommentary) report.aiCommentary = buildCommentary(body.aiCommentary, report.security.findings, new Date().toISOString());

    const base = `cloudbuilder-assessment-${projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}-rev${report.meta.architectureRevision}-${report.meta.reportId}`;
    if (body.format === 'json') {
      return ok({ report, scanId });
    }
    if (body.format === 'html') {
      return new NextResponse(renderReportHtml(report), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}.html"`, 'Cache-Control': 'no-store', 'X-Assessment-Scan-Id': scanId },
      });
    }
    const pdf = await renderReportPdf(report);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${base}.pdf"`, 'Content-Length': String(pdf.length), 'Cache-Control': 'no-store', 'X-Assessment-Scan-Id': scanId },
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/assessment-report]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
