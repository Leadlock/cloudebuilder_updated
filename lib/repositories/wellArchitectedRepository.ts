/**
 * WellArchitectedRepository — database access for WA assessments and findings.
 *
 * Mirrors the pattern of existing repositories (securityScanRepository, etc.)
 */
import { db } from '@/src/prisma/db';
import { randomUUID as uuidv4 } from 'crypto';
import type { WaAssessment, WaFinding } from '@/lib/engines/wellArchitected/types';

// ─── DB Types ─────────────────────────────────────────────────────────────────

interface DbWaAssessment {
  id: string;
  projectId: string;
  architectureId: string;
  provider: string;
  framework: string;
  frameworkVersion: string;
  overallScore: number;
  pillarScoresJson: string;
  findingsJson: string;
  source: string;
  sourceLabel: string;
  confidence: string;
  isStale: boolean;
  createdAt: string;
  completedAt: string | null;
}

// In-memory fallback cache for when DB table is not yet migrated or offline
const waMemoryStore = new Map<string, WaAssessment>();
const waFindingsMemoryStore = new Map<string, WaFinding[]>();

class WellArchitectedRepository {

  /**
   * Persist a full WA assessment (assessment row + finding rows).
   */
  async createAssessment(assessment: WaAssessment): Promise<string> {
    const id = uuidv4();
    const now = assessment.evaluatedAt || new Date().toISOString();
    const assessmentWithId = { ...assessment, id };

    // Always cache in memory
    waMemoryStore.set(assessment.architectureId, assessmentWithId);
    waFindingsMemoryStore.set(id, assessment.findings);

    try {
      await db.orm.public.WellArchitectedAssessment.create({
        id,
        projectId: assessment.projectId,
        architectureId: assessment.architectureId,
        provider: assessment.provider,
        framework: assessment.framework,
        frameworkVersion: assessment.frameworkVersion,
        overallScore: assessment.overallScore,
        pillarScoresJson: JSON.stringify(assessment.pillarScores),
        findingsJson: JSON.stringify(assessment.findings),
        source: assessment.source,
        sourceLabel: assessment.sourceLabel,
        confidence: assessment.confidence,
        isStale: false,
        createdAt: now,
        completedAt: now,
      });

      // Persist individual findings for resource-level lookups
      for (const finding of assessment.findings) {
        await db.orm.public.WellArchitectedFinding.create({
          id: finding.id || uuidv4(),
          assessmentId: id,
          ruleId: finding.ruleId,
          provider: finding.provider,
          pillar: finding.pillar,
          pillarLabel: finding.pillarLabel,
          pillarRef: finding.pillarRef,
          severity: finding.severity,
          title: finding.title,
          description: finding.description,
          affectedResourceIds: JSON.stringify(finding.affectedResourceIds),
          evidenceJson: JSON.stringify(finding.evidence),
          recommendation: finding.recommendation,
          remediation: finding.remediation,
          frameworkReference: finding.frameworkReference,
          source: finding.source,
          sourceLabel: finding.sourceLabel,
          resourceState: finding.resourceState ?? null,
          detectedAt: finding.detectedAt || now,
        });
      }
    } catch (err) {
      console.warn('[WellArchitectedRepository] DB createAssessment fallback to in-memory:', err instanceof Error ? err.message : err);
    }

    return id;
  }

  /**
   * Get the most recent assessment for a given architecture ID.
   */
  async findLatestByArchitecture(architectureId: string): Promise<WaAssessment | null> {
    try {
      const rows = await db.orm.public.WellArchitectedAssessment
        .where({ architectureId })
        .all();

      if (!rows || rows.length === 0) {
        return waMemoryStore.get(architectureId) ?? null;
      }

      // Sort by createdAt descending
      const sorted = [...rows].sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      const row = sorted[0] as DbWaAssessment;

      return this._rowToAssessment(row, architectureId);
    } catch (err) {
      console.warn('[WellArchitectedRepository] DB findLatestByArchitecture fallback to in-memory:', err instanceof Error ? err.message : err);
      return waMemoryStore.get(architectureId) ?? null;
    }
  }

  /**
   * Mark all assessments for an architecture as stale.
   * Called when the canvas changes (UPDATE_CANVAS, UPDATE_NODE_CONFIG, etc.)
   */
  async markStale(architectureId: string): Promise<void> {
    const cached = waMemoryStore.get(architectureId);
    if (cached) {
      cached.isStale = true;
    }
    try {
      const rows = await db.orm.public.WellArchitectedAssessment
        .where({ architectureId })
        .all();
      for (const row of rows) {
        await db.orm.public.WellArchitectedAssessment
          .where({ id: (row as DbWaAssessment).id })
          .update({ isStale: true });
      }
    } catch (err) {
      // Fire-and-forget — do not propagate
      console.warn('[WellArchitectedRepository] markStale failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Get all findings for a given assessment ID.
   */
  async listFindings(assessmentId: string): Promise<WaFinding[]> {
    try {
      const rows = await db.orm.public.WellArchitectedFinding
        .where({ assessmentId })
        .all();
      return (rows as Array<Record<string, unknown>>).map(this._rowToFinding);
    } catch (err) {
      console.warn('[WellArchitectedRepository] DB listFindings fallback to in-memory:', err instanceof Error ? err.message : err);
      return waFindingsMemoryStore.get(assessmentId) ?? [];
    }
  }

  /**
   * Get all WA findings that affect a specific resource ID.
   * Used by the Properties Panel "Well-Architected" tab.
   */
  async findingsByResource(resourceId: string, architectureId: string): Promise<WaFinding[]> {
    // Get latest assessment for this architecture
    const assessment = await this.findLatestByArchitecture(architectureId);
    if (!assessment) return [];

    return assessment.findings.filter((f) =>
      f.affectedResourceIds.includes(resourceId)
    );
  }

  private _rowToAssessment(row: DbWaAssessment, architectureId: string): WaAssessment {
    let pillarScores = [];
    let findings = [];
    try { pillarScores = JSON.parse(row.pillarScoresJson); } catch {}
    try { findings = JSON.parse(row.findingsJson); } catch {}

    return {
      architectureId,
      projectId: row.projectId,
      provider: row.provider as any,
      framework: row.framework,
      frameworkVersion: row.frameworkVersion,
      frameworkSource: '',
      overallScore: row.overallScore,
      pillarScores,
      findings,
      evaluatedAt: row.createdAt,
      source: row.source as any,
      sourceLabel: row.sourceLabel,
      confidence: row.confidence as any,
      isStale: row.isStale,
    };
  }

  private _rowToFinding(row: Record<string, unknown>): WaFinding {
    let affectedResourceIds: string[] = [];
    let evidence: Record<string, unknown> = {};
    try { affectedResourceIds = JSON.parse(row['affectedResourceIds'] as string); } catch {}
    try { evidence = JSON.parse(row['evidenceJson'] as string); } catch {}

    return {
      id: row['id'] as string,
      ruleId: row['ruleId'] as string,
      provider: row['provider'] as any,
      pillar: row['pillar'] as any,
      pillarLabel: row['pillarLabel'] as string,
      pillarRef: row['pillarRef'] as string,
      severity: row['severity'] as any,
      title: row['title'] as string,
      description: row['description'] as string,
      affectedResourceIds,
      affectedResourceLabels: [],
      evidence,
      recommendation: row['recommendation'] as string,
      remediation: row['remediation'] as string,
      frameworkReference: row['frameworkReference'] as string,
      source: row['source'] as any,
      sourceLabel: row['sourceLabel'] as string,
      detectedAt: row['detectedAt'] as string,
      resourceState: row['resourceState'] as any,
    };
  }
}

export const wellArchitectedRepository = new WellArchitectedRepository();
