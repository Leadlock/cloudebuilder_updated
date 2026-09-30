import { buildCommentary, AiCommentaryInputSchema } from '@/lib/ai/reportCommentary';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { buildReport } from '@/lib/engines/assessment/report/buildReport';
import { renderReportHtml } from '@/lib/services/report/renderReportHtml';
import { renderReportPdf } from '@/lib/services/report/renderReportPdf';
import type { CanvasNode } from '@/types';

const node = (id: string, resourceType: string, config: Record<string, unknown> = {}, label = id): CanvasNode =>
  ({ id, type: 'cloudNode', resourceType, provider: 'aws', label, position: { x: 0, y: 0 }, config } as CanvasNode);
const nodes = [node('sg', 'aws_sg', { allowSsh: true, sourceCidr: '0.0.0.0/0' }, 'web-sg'), node('vm', 'aws_ec2', {}, 'web-server')];
const assessment = runAssessment({ nodes, edges: [] });

describe('buildCommentary', () => {
  const input = (o: object) => AiCommentaryInputSchema.parse({ summary: 'Open SSH.', ...o });

  it('keeps only rules in the report, takes title and severity from the finding, and never repeats a rule', () => {
    const c = buildCommentary(input({ priorities: [
      { ruleId: 'AWS-SG-001', problem: 'p', fix: 'f' }, { ruleId: 'AWS-MADE-UP', problem: 'x', fix: 'x' }, { ruleId: 'AWS-SG-001', problem: 'dup' },
    ] }), assessment.findings, 't')!;
    expect(c.priorities.map((p) => p.ruleId)).toEqual(['AWS-SG-001']);
    expect(c.priorities[0]!.title).toBe(assessment.findings.find((f) => f.ruleId === 'AWS-SG-001')!.title);
    expect(c.priorities[0]!.severity).toBe('high');
  });

  it('falls back to the engine text when the model wording is empty, and returns nothing when there is nothing to show', () => {
    const c = buildCommentary(input({ priorities: [{ ruleId: 'AWS-SG-001' }] }), assessment.findings, 't')!;
    expect(c.priorities[0]!.fix.length).toBeGreaterThan(0);
    expect(buildCommentary(AiCommentaryInputSchema.parse({ summary: ' ' }), assessment.findings, 't')).toBeUndefined();
  });

  it('rejects oversized input', () => {
    expect(AiCommentaryInputSchema.safeParse({ summary: 'x'.repeat(801) }).success).toBe(false);
    expect(AiCommentaryInputSchema.safeParse({ summary: 's', suggestions: Array(6).fill('a') }).success).toBe(false);
  });
});

describe('report rendering', () => {
  const snap = {
    scanId: 's1', project: { id: 'p', name: 'Demo', environment: 'production', region: 'us-east-1' }, createdAt: '2026-09-30T00:00:00.000Z',
    architecture: { architectureId: 'a', revision: 1, graphHash: 'h', contentSha256: 'c', nodes, edges: [] }, assessment,
  } as unknown as Parameters<typeof buildReport>[0];

  it('renders a clearly labelled AI section in HTML — escaped — and leaves everything else unchanged', () => {
    const plain = buildReport(snap, { generatedAt: '2026-09-30T00:00:00.000Z' });
    const withAi = { ...plain, aiCommentary: buildCommentary(AiCommentaryInputSchema.parse({ summary: '<script>x</script> Open SSH.', suggestions: ['Enable GuardDuty'] }), assessment.findings, '2026-09-30T00:00:00.000Z') };
    const html = renderReportHtml(withAi);
    expect(html).toContain('AI-generated commentary');
    expect(html).toContain('Unverified AI suggestions');
    expect(html).not.toContain('<script>x</script>');
    expect(renderReportHtml(plain)).not.toContain('AI-generated commentary');
    expect(withAi.meta.contentSha256).toBe(plain.meta.contentSha256);
    expect(withAi.executive.security.score).toBe(plain.executive.security.score);
  });

  it('produces a PDF with the section without throwing', async () => {
    const report = { ...buildReport(snap, { generatedAt: '2026-09-30T00:00:00.000Z' }), aiCommentary: buildCommentary(AiCommentaryInputSchema.parse({ summary: 'Open SSH.', priorities: [{ ruleId: 'AWS-SG-001' }], suggestions: ['x'] }), assessment.findings, '2026-09-30T00:00:00.000Z') };
    const pdf = await renderReportPdf(report);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
