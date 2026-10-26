/**
 * /api/projects/[id]/readiness/[framework]/report
 *
 * GET  ?format=docx|pdf|json — a DRAFT of the report as it stands now (not recorded as a version).
 * POST { format } — ISSUES the report: takes the next version number, records it (id, readiness, date, who), and returns the file.
 *
 * SOC 2 is a Word document by default (editable, so the auditor and the company can work in it) and can also be a PDF to read or review; the AWS and Azure control reports are PDF. Either can be asked
 * for as JSON. A report is a readiness report: it is never called a SOC 2 report, a certification or an opinion.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { notFound, badRequest, internalError, parseBody, ok } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { buildProjectReport } from '@/lib/compliance/service';
import { renderSoc2Docx } from '@/lib/compliance/renderSoc2Docx';
import { renderControlPdf } from '@/lib/compliance/renderControlPdf';
import { renderSoc2Pdf } from '@/lib/compliance/renderSoc2Pdf';
import { readinessRepository } from '@/lib/repositories/readinessRepository';
import type { FrameworkId } from '@/lib/compliance/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; framework: string }> };
const FormatSchema = z.enum(['docx', 'pdf', 'json']);
const defaultFormat = (f: FrameworkId) => (f === 'soc2' ? 'docx' : 'pdf');

async function produce(req: NextRequest, p: { id: string; framework: string }, format: z.infer<typeof FormatSchema> | undefined, issue: boolean) {
  const caller = await guardReadiness(req, p, { limitKey: 'readiness-report' });
  if ('response' in caller) return caller.response;
  const fmt = format ?? defaultFormat(caller.framework);
  if (fmt === 'docx' && caller.framework !== 'soc2') return badRequest('The AWS and Azure control reports are PDF.');
  const built = await buildProjectReport({ orgId: caller.orgId, projectId: caller.projectId, framework: caller.framework, env: caller.env, preparedBy: caller.email });
  if (!built.ok) return built.reason === 'project_not_found' ? notFound('Project') : badRequest('Save the architecture first: the report is built from the saved architecture.');
  const { report } = built;
  if (issue) {
    await readinessRepository.recordReport(caller.projectId, caller.framework, {
      version: built.input.version, reportId: report.reportId, readiness: report.readiness, asOf: report.asOf, generatedBy: caller.email,
      summaryJson: JSON.stringify({ controls: report.results.length, assessed: report.summary.coveragePct, findings: report.findings.length }),
    });
  }
  const base = `cloudbuilder-${caller.framework}-readiness-${report.version}-${report.reportId}${issue ? '' : '-DRAFT'}`.toLowerCase();
  if (fmt === 'json') return ok({ report });
  const bytes = fmt === 'docx' ? await renderSoc2Docx(report) : caller.framework === 'soc2' ? await renderSoc2Pdf(report) : await renderControlPdf(report);
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': fmt === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf',
      'Content-Disposition': `attachment; filename="${base}.${fmt}"`, 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'X-Report-Id': report.reportId,
    },
  });
}

export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const raw = req.nextUrl.searchParams.get('format');
    const f = raw ? FormatSchema.safeParse(raw) : undefined;
    if (f && !f.success) return badRequest('format must be docx, pdf or json.');
    return await produce(req, await params, f?.data, false);
  } catch (err) {
    console.error('[GET readiness report]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const parsed = await parseBody(req, z.object({ format: FormatSchema.optional() }));
    if (!parsed.ok) return parsed.response;
    return await produce(req, await params, parsed.data.format, true);
  } catch (err) {
    console.error('[POST readiness report]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
