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
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { notFound, forbidden, unauthorized, internalError, badRequest, parseBody, tooManyRequests, ok } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import {
  buildSnapshot, persistSnapshot, getSnapshot, previousSnapshot, compareSnapshots, loadActiveReviews,
} from '@/lib/services/AssessmentSnapshotService';
import { buildReport, type AutoFixHistoryEntry } from '@/lib/engines/assessment/report/buildReport';
import { renderReportPdf } from '@/lib/services/report/renderReportPdf';
import { renderReportHtml } from '@/lib/services/report/renderReportHtml';
import { AiCommentaryInputSchema, buildCommentary } from '@/lib/ai/reportCommentary';
import { db } from '@/src/prisma/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Schema = z.object({
  env: z.string().optional().default('production'),
  format: z.enum(['pdf', 'html', 'json']).default('pdf'),
  scanId: z.string().uuid().optional(),
  /** The AI security review the user is looking at; validated against the report's own findings. */
  aiCommentary: AiCommentaryInputSchema.optional(),
});

async function autoFixHistory(architectureId: string): Promise<AutoFixHistoryEntry[]> {
  try {
    const rows = await db.orm.public.ArchitectureVersion.where({ architectureId }).select('label', 'summary', 'author', 'createdAt').all();
    return rows
      .filter((r) => r.label.startsWith('Security Auto-Fix'))
      .map((r) => ({ timestamp: r.createdAt, summary: r.summary, author: r.author }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch { return []; }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const rl = checkRateLimit(`${identity.userId}:assessment-report`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const { id: projectId } = await params;
    const parsed = await parseBody(req, Schema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    if (!(await getOrgRole(identity.userId, orgId))) return forbidden();

    const ctx = await resolveArchitecture(projectId, orgId, body.env);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      return badRequest('Save the architecture before generating a report — reports are generated from the persisted architecture.');
    }

    let snapshot;
    if (body.scanId) {
      snapshot = await getSnapshot(projectId, body.scanId);
      if (!snapshot) return notFound('Assessment snapshot');
    } else {
      snapshot = buildSnapshot({
        project: { id: projectId, name: ctx.project.name, environment: body.env, region: ctx.project.region },
        arch: ctx.arch,
        createdBy: identity.userId,
        reviews: await loadActiveReviews(projectId),
      });
      await persistSnapshot(snapshot);
    }

    const prev = await previousSnapshot(projectId, snapshot.architecture.architectureId, snapshot.createdAt, {
      graphHash: snapshot.architecture.graphHash, rulesetVersion: snapshot.assessment.rulesetVersion,
    }).catch(() => null);
    const cmp = prev ? compareSnapshots(prev, snapshot) : undefined;
    const report = buildReport(snapshot, {
      comparison: cmp ? { ...cmp, unchangedCount: cmp.unchangedFindings.length } : undefined,
      autoFixHistory: (await autoFixHistory(snapshot.architecture.architectureId)).filter((h) => h.timestamp <= snapshot.createdAt),
    });

    if (body.aiCommentary) report.aiCommentary = buildCommentary(body.aiCommentary, report.security.findings, new Date().toISOString());

    const base = `cloudcraft-assessment-${ctx.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}-rev${snapshot.architecture.revision}-${report.meta.reportId}`;
    if (body.format === 'json') {
      return ok({ report, scanId: snapshot.scanId });
    }
    if (body.format === 'html') {
      return new NextResponse(renderReportHtml(report), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}.html"`, 'Cache-Control': 'no-store', 'X-Assessment-Scan-Id': snapshot.scanId },
      });
    }
    const pdf = await renderReportPdf(report);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${base}.pdf"`, 'Content-Length': String(pdf.length), 'Cache-Control': 'no-store', 'X-Assessment-Scan-Id': snapshot.scanId },
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/assessment-report]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
