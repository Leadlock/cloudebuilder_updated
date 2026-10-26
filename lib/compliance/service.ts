/**
 * Assembles the readiness report's input for one project and framework from everything CloudBuilder holds: the saved architecture and its
 * assessment (checks on the design, readings of the cloud account, answers), the team's records, evidence, findings and sign-offs, and the
 * platform's own facts. The report itself is then a pure function of that input (lib/compliance/report.ts).
 */
import { toCanvas } from '@/lib/domain/canvasMapping';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { resolveArchitecture } from '@/lib/api/phase2d';
import { loadQuestionnaire } from '@/lib/api/waQuestionnaire';
import { loadAccountEvidence } from '@/lib/api/accountEvidence';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { readinessRepository, evidenceControls } from '@/lib/repositories/readinessRepository';
import { findingReviewRepository } from '@/lib/repositories/findingReviewRepository';
import { gatherPlatformFacts } from './facts';
import { buildReadinessReport, type ReadinessReport, type ReportInput, type SystemFacts } from './report';
import type { Soc2Category } from './soc2/criteria';
import type { EvidenceRef, FrameworkId } from './types';

export interface ReadinessScope { categories: Soc2Category[]; exclusions: Partial<Record<Soc2Category, string>> }

const humanize = (resourceType: string) => resourceType.replace(/^(aws|azure)_/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const KIND_LABEL: Record<string, string> = { database: 'Database or data platform', monitoring: 'Monitoring', identity: 'Sign-in and identity', payments: 'Payments', edge: 'CDN, edge or security', messaging: 'Email, SMS or messaging', analytics: 'Analytics', devtools: 'Source code, CI or CD', ai: 'AI or ML service', other: 'Other' };
const DATA_LABEL: Record<string, string> = { none: 'No data', internal: 'Non-sensitive data', personal: 'Personal data', regulated: 'Regulated data' };

export function systemFacts(project: { name: string; description: string; region: string }, nodes: ReturnType<typeof toCanvas>['nodes'], environment: string): SystemFacts {
  const counts = new Map<string, number>();
  const regions = new Set<string>([project.region]);
  const providers = new Set<'aws' | 'azure'>();
  const thirdParties: SystemFacts['thirdParties'] = [];
  for (const n of nodes) {
    if (n.provider === 'aws' || n.provider === 'azure') providers.add(n.provider);
    if (n.region) regions.add(n.region);
    if (n.resourceType.endsWith('_external_service')) {
      const c = n.config;
      const vendor = typeof c['vendor'] === 'string' && c['vendor'].trim() ? c['vendor'].trim() : n.label;
      thirdParties.push({ vendor, use: KIND_LABEL[String(c['kind'] ?? 'other')] ?? 'Other', dataHeld: DATA_LABEL[String(c['dataHeld'] ?? 'none')] ?? 'Not stated' });
      continue;
    }
    const k = humanize(n.resourceType);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const services = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([k, n]) => (n > 1 ? `${k} x${n}` : k));
  return { name: project.name, description: project.description, environment, providers: [...providers], regions: [...regions].filter(Boolean).sort(), services, thirdParties };
}

export async function loadScope(projectId: string): Promise<ReadinessScope> {
  const s = await readinessRepository.settings<ReadinessScope>(projectId, 'soc2');
  const valid = (s.categories ?? []).filter((c): c is Soc2Category => c === 'security' || c === 'availability' || c === 'confidentiality');
  // Security is always in scope: SOC 2 has no report without it.
  const categories = [...new Set<Soc2Category>(['security', ...(valid.length ? valid : ['security', 'availability', 'confidentiality'] as Soc2Category[])])];
  return { categories, exclusions: s.exclusions ?? {} };
}

export type LoadResult = { ok: true; input: ReportInput } | { ok: false; reason: 'project_not_found' | 'no_architecture' };

export async function loadReportInput(args: { orgId: string; projectId: string; framework: FrameworkId; env?: string; preparedBy: string; asOf?: Date; version?: number }): Promise<LoadResult> {
  const env = args.env ?? 'production';
  const ctx = await resolveArchitecture(args.projectId, args.orgId, env);
  if ('error' in ctx) return { ok: false, reason: ctx.error === 'project_not_found' ? 'project_not_found' : 'no_architecture' };
  const asOf = args.asOf ?? new Date();
  const { nodes, edges } = toCanvas(ctx.arch.resources, ctx.arch.connections);
  const [questionnaire, accountEvidence, reviews, records, evidence, findingRecords, signoffs, scope, facts, org, version] = await Promise.all([
    loadQuestionnaire(args.projectId),
    loadAccountEvidence(args.projectId),
    findingReviewRepository.activeReviews(args.projectId).catch(() => []),
    readinessRepository.controls(args.projectId, args.framework),
    readinessRepository.evidence(args.projectId),
    readinessRepository.findings(args.projectId, args.framework),
    readinessRepository.signoffs(args.projectId, args.framework),
    args.framework === 'soc2' ? loadScope(args.projectId) : Promise.resolve(undefined),
    gatherPlatformFacts(args.orgId, args.projectId, asOf),
    orgRepository.findOrg(args.orgId).catch(() => null),
    args.version ?? readinessRepository.nextVersion(args.projectId, args.framework),
  ]);
  const assessment = runAssessment({ nodes, edges, reviews, evaluatedAt: asOf.toISOString(), questionnaire, accountEvidence });
  const refs: Array<EvidenceRef & { controls: string[] }> = evidence.map((e) => ({
    id: e.id, title: e.title, kind: e.kind, origin: e.origin, collectedAt: e.collectedAt,
    ...(e.validUntil ? { validUntil: e.validUntil } : {}), ...(e.fileName ? { fileName: e.fileName } : {}), ...(e.sha256 ? { sha256: e.sha256 } : {}), uploadedBy: e.uploadedBy,
    controls: evidenceControls(e, args.framework),
  })).filter((e) => e.controls.length > 0);
  return {
    ok: true,
    input: {
      framework: args.framework, company: org?.name ?? 'Your organization', system: systemFacts(ctx.project, nodes, env),
      asOf, generatedAt: new Date(), version, ...(scope ? { categories: scope.categories, exclusions: scope.exclusions } : {}),
      records, evidence: refs, evaluations: assessment.evaluations, ...(facts ? { facts } : {}), findingRecords, signoffs,
      accountRead: assessment.evaluations.some((e) => e.provenance !== 'DESIGN_TIME'), preparedBy: args.preparedBy,
    },
  };
}

export async function buildProjectReport(args: Parameters<typeof loadReportInput>[0]): Promise<{ ok: true; report: ReadinessReport; input: ReportInput } | { ok: false; reason: 'project_not_found' | 'no_architecture' }> {
  const r = await loadReportInput(args);
  return r.ok ? { ok: true, report: buildReadinessReport(r.input), input: r.input } : r;
}
