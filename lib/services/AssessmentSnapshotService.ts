/**
 * AssessmentSnapshotService (server only).
 *
 * An assessment snapshot binds a set of results to the exact architecture they
 * were computed from: architecture revision, CloudCraft graph hash, a SHA-256
 * of the sanitized graph content, the ruleset version and timestamp. Snapshots
 * are persisted in the existing SecurityScan table (findingsJson holds the
 * versioned envelope) and are immutable, so a report regenerated later from
 * the same scan ID is identical even if the architecture has changed since.
 */
import { createHash, randomUUID } from 'crypto';
import { db } from '@/src/prisma/db';
import { toCanvas } from '@/lib/domain/canvasMapping';
import type { DbArchitecture } from '@/lib/repositories/architectureRepository';
import { findingReviewRepository } from '@/lib/repositories/findingReviewRepository';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import type { AccountEvidenceMap } from '@/lib/engines/assessment/accountEvidence';
import type { AssessmentResult, Finding, FindingReview } from '@/lib/engines/assessment/types';
import type { CanvasEdge, CanvasNode } from '@/types';

export const SNAPSHOT_SCHEMA = 'cloudcraft.assessment-snapshot.v1';

export interface AssessmentSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  scanId: string;
  createdAt: string;
  createdBy: string;
  project: { id: string; name: string; environment: string; region?: string };
  architecture: {
    architectureId: string;
    revision: number;
    graphHash: string;
    contentSha256: string;
    nodes: CanvasNode[];
    edges: CanvasEdge[];
  };
  assessment: AssessmentResult;
}

export interface SnapshotSummary {
  scanId: string;
  createdAt: string;
  architectureRevision: number | null;
  graphHash: string | null;
  rulesetVersion: string | null;
  securityScore: number | null;
  coveragePct: number | null;
  findingCount: number;
  legacy: boolean;
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

/** Config keys whose values may contain secrets and are never copied into snapshots or reports. */
const SENSITIVE_KEY = /(password|passwd|secret|token|credential|private.?key|connection.?string|sas|userData|customData|environmentVariables|appSettings|adminPassword)/i;

export function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(config ?? {}, 0) as Record<string, unknown>;
}

/** Redacts sensitive keys at any depth (e.g. inside `_discovery.values` or `_metadata`). */
function sanitizeValue(v: unknown, depth: number): unknown {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => sanitizeValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) {
      const empty = val === undefined || val === null || val === '' || (typeof val === 'object' && Object.keys(val as object).length === 0);
      out[k] = empty ? val : '[redacted]';
    } else {
      out[k] = sanitizeValue(val, depth + 1);
    }
  }
  return out;
}

export function sanitizeNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((n) => ({ ...n, config: sanitizeConfig(n.config as Record<string, unknown>) }));
}

export function contentSha256(nodes: CanvasNode[], edges: CanvasEdge[]): string {
  const canonical = JSON.stringify({
    nodes: [...nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => ({
      id: n.id, type: n.resourceType, parent: n.parentId ?? n.groupId ?? null, region: n.region ?? null,
      config: Object.fromEntries(Object.entries(n.config ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    })),
    edges: [...edges].sort((a, b) => a.id.localeCompare(b.id)).map((e) => ({ id: e.id, s: e.source, t: e.target })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Snapshot lifecycle ───────────────────────────────────────────────────────

export async function loadActiveReviews(projectId: string): Promise<FindingReview[]> {
  try { return await findingReviewRepository.activeReviews(projectId); } catch { return []; }
}

export function buildSnapshot(args: {
  scanId?: string;
  project: { id: string; name: string; environment: string; region?: string };
  arch: DbArchitecture;
  createdBy: string;
  reviews: FindingReview[];
  now?: string;
  /** Questionnaire answers to include (the Well-Architected report). Left out, questions play no part. */
  questionnaire?: { answers: Record<string, { answer: string; note?: string }> };
  /** Dated readings of account-level controls for this project (CloudTrail, GuardDuty, root MFA, AWS Config). */
  accountEvidence?: AccountEvidenceMap;
}): AssessmentSnapshot {
  const { nodes, edges } = toCanvas(args.arch.resources, args.arch.connections);
  const createdAt = args.now ?? new Date().toISOString();
  const assessment = runAssessment({ nodes, edges, reviews: args.reviews, evaluatedAt: createdAt, questionnaire: args.questionnaire, accountEvidence: args.accountEvidence });
  const safeNodes = sanitizeNodes(nodes);
  return {
    schema: SNAPSHOT_SCHEMA,
    scanId: args.scanId ?? randomUUID(),
    createdAt,
    createdBy: args.createdBy,
    project: args.project,
    architecture: {
      architectureId: args.arch.id,
      revision: args.arch.revision,
      graphHash: assessment.graphHash,
      contentSha256: contentSha256(safeNodes, edges),
      nodes: safeNodes,
      edges,
    },
    assessment,
  };
}

export async function persistSnapshot(snapshot: AssessmentSnapshot): Promise<boolean> {
  const a = snapshot.assessment;
  try {
    await db.orm.public.SecurityScan.create({
      id: snapshot.scanId,
      projectId: snapshot.project.id,
      architectureId: snapshot.architecture.architectureId,
      versionId: `rev-${snapshot.architecture.revision}`,
      status: a.securityScore.score === null ? 'completed-not-scored' : 'completed',
      score: a.securityScore.score ?? 0,
      findingsJson: JSON.stringify(snapshot),
      createdAt: snapshot.createdAt,
      completedAt: snapshot.createdAt,
    });
    // Per-finding rows for queries. Row IDs are unique per scan (the stable
    // finding ID is kept in metaJson) — the previous implementation reused the
    // deterministic finding ID as primary key, so every re-scan after the first
    // silently failed to persist findings.
    for (const f of a.findings) {
      await db.orm.public.SecurityFinding.create({
        id: randomUUID(),
        scanId: snapshot.scanId,
        ruleId: f.ruleId,
        severity: f.severity,
        title: f.title,
        description: f.description,
        resourceId: f.resourceIds[0] ?? null,
        provider: f.provider,
        resourceType: f.resourceType ?? null,
        remediation: f.recommendation,
        metaJson: JSON.stringify({ findingId: f.findingId, status: f.status, domain: f.domain, reviewStatus: f.reviewStatus }),
        createdAt: snapshot.createdAt,
      });
    }
    return true;
  } catch (err) {
    console.warn('[AssessmentSnapshotService] snapshot not persisted:', (err as Error)?.message);
    return false;
  }
}

function parseSnapshot(json: string): AssessmentSnapshot | null {
  try {
    const v = JSON.parse(json);
    return v && v.schema === SNAPSHOT_SCHEMA ? (v as AssessmentSnapshot) : null;
  } catch { return null; }
}

export async function getSnapshot(projectId: string, scanId: string): Promise<AssessmentSnapshot | null> {
  const row = await db.orm.public.SecurityScan.where({ id: scanId, projectId }).select('id', 'findingsJson').first();
  return row ? parseSnapshot(row.findingsJson) : null;
}

export async function listSnapshots(projectId: string, architectureId?: string): Promise<SnapshotSummary[]> {
  const rows = await db.orm.public.SecurityScan
    .where(architectureId ? { projectId, architectureId } : { projectId })
    .select('id', 'createdAt', 'score', 'findingsJson', 'versionId')
    .all();
  return rows.map((r) => {
    const s = parseSnapshot(r.findingsJson);
    return {
      scanId: r.id,
      createdAt: r.createdAt,
      architectureRevision: s?.architecture.revision ?? null,
      graphHash: s?.architecture.graphHash ?? null,
      rulesetVersion: s?.assessment.rulesetVersion ?? null,
      securityScore: s ? s.assessment.securityScore.score : r.score,
      coveragePct: s?.assessment.securityScore.coverage.coveragePct ?? null,
      findingCount: s ? s.assessment.findings.length : (() => { try { return (JSON.parse(r.findingsJson) as unknown[]).length; } catch { return 0; } })(),
      legacy: !s,
    };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Most recent snapshot for the architecture created before `before` (for historical comparison).
 * When `current` is given, re-scans of the identical graph under the same ruleset are skipped so
 * the comparison is against the last genuinely different assessed state.
 */
export async function previousSnapshot(
  projectId: string, architectureId: string, before: string,
  current?: { graphHash: string; rulesetVersion: string },
): Promise<AssessmentSnapshot | null> {
  const list = (await listSnapshots(projectId, architectureId)).filter((s) => !s.legacy && s.createdAt < before
    && !(current && s.graphHash === current.graphHash && s.rulesetVersion === current.rulesetVersion));
  return list[0] ? getSnapshot(projectId, list[0].scanId) : null;
}

// ─── Comparison ──────────────────────────────────────────────────────────────

export interface AssessmentComparison {
  previousScanId: string;
  previousCreatedAt: string;
  previousRevision: number;
  newFindings: Finding[];
  resolvedFindings: Finding[];
  unchangedFindings: Finding[];
  /** New findings on a check that previously PASSED for the same resource. */
  regressions: Finding[];
  securityScore: { previous: number | null; current: number | null };
  coverage: { previous: number | null; current: number | null };
  rulesetChanged: boolean;
}

export function compareSnapshots(prev: AssessmentSnapshot, curr: AssessmentSnapshot): AssessmentComparison {
  const p = prev.assessment; const c = curr.assessment;
  const prevIds = new Set(p.findings.map((f) => f.findingId));
  const currIds = new Set(c.findings.map((f) => f.findingId));
  const prevPass = new Set(p.evaluations.filter((e) => e.status === 'PASS').map((e) => e.findingId));
  const newFindings = c.findings.filter((f) => !prevIds.has(f.findingId));
  return {
    previousScanId: prev.scanId,
    previousCreatedAt: prev.createdAt,
    previousRevision: prev.architecture.revision,
    newFindings,
    resolvedFindings: p.findings.filter((f) => !currIds.has(f.findingId)),
    unchangedFindings: c.findings.filter((f) => prevIds.has(f.findingId)),
    regressions: newFindings.filter((f) => prevPass.has(f.findingId)),
    securityScore: { previous: p.securityScore.score, current: c.securityScore.score },
    coverage: { previous: p.securityScore.coverage.coveragePct, current: c.securityScore.coverage.coveragePct },
    rulesetChanged: p.rulesetVersion !== c.rulesetVersion,
  };
}
