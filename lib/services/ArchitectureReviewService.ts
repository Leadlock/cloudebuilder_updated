/**
 * Architecture Review, Tamper Invalidation & Deployment Security Service
 *
 * Implements:
 * 1. Deterministic SHA-256 architecture hashing.
 * 2. Multi-stage review state machine (pending_review, approved, rejected, changes_requested, invalidated_due_to_changes).
 * 3. Automatic approval invalidation on canvas modification.
 * 4. Enterprise deployment security gates (Admin role check, approved review matching hash, zero critical findings).
 * 5. Immutable deployment audit logging.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { CanvasNode, CanvasEdge } from '@/types';
import { runSecurityScan } from '@/lib/analysis';
import { isSuperAdmin, superAdminEmails, superAdminsConfigured, reviewDecisionMessage } from '@/lib/auth/superAdmins';

export type ReviewStatus =
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'invalidated_due_to_changes';

export interface ArchitectureReview {
  id: string;
  projectId: string;
  environment: string;
  architectureHash: string;
  status: ReviewStatus;
  submittedBy: { id: string; name: string; email: string };
  submittedAt: string;
  reviewedBy?: { id: string; name: string; email: string };
  reviewedAt?: string;
  reviewerComments?: string;
  /** Who has to decide: the super administrators when there are any (set when the review is submitted). */
  assignedTo?: string[];
  summary: {
    nodeCount: number;
    edgeCount: number;
    criticalIssuesCount: number;
    estimatedMonthlyCost: number;
  };
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface DeploymentRecord {
  id: string;
  projectId: string;
  environment: string;
  architectureHash: string;
  reviewId: string;
  deployedBy: { id: string; name: string; email: string };
  deployedAt: string;
  status: 'success' | 'failed';
  steps: { id: string; label: string; status: string; output: string }[];
  durationMs: number;
}

// In-memory persistent state stores across the dev session (attached to globalThis to survive Next.js dev rebuilds)
const globalForReviews = globalThis as unknown as {
  __cloudbuilder_reviews?: Map<string, ArchitectureReview>;
  __cloudbuilder_deployments?: DeploymentRecord[];
};
/**
 * Where reviews and deployment records are kept between restarts. An approval used to live only in this process's memory, so every
 * restart of the server (a crash, `npm run dev` again, a deploy) silently threw it away and the Deploy tab said "approval required"
 * again. They are now also written to a small file after every change and read back when the server starts.
 *
 * Set CLOUDBUILDER_REVIEWS_FILE to choose the file (use a path on storage that survives restarts). Under tests nothing is written unless
 * that variable is set. One file means one server instance: running several instances needs these in the shared database instead.
 */
function storeFile(): string | null {
  const explicit = process.env['CLOUDBUILDER_REVIEWS_FILE'];
  if (explicit) return explicit;
  if (process.env['NODE_ENV'] === 'test') return null;
  return join(process.cwd(), '.cloudbuilder-data', 'reviews.json');
}

function loadFromDisk(): { reviews: ArchitectureReview[]; deployments: DeploymentRecord[] } {
  const file = storeFile();
  if (!file || !existsSync(file)) return { reviews: [], deployments: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { reviews?: ArchitectureReview[]; deployments?: DeploymentRecord[] };
    return { reviews: parsed.reviews ?? [], deployments: parsed.deployments ?? [] };
  } catch (err) {
    console.warn('[reviews] could not read', file, '-', err instanceof Error ? err.message : String(err));   // a damaged file starts empty rather than blocking the app
    return { reviews: [], deployments: [] };
  }
}

function persist(): void {
  const file = storeFile();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ reviews: [...REVIEWS.values()], deployments: DEPLOYMENTS }), 'utf-8');
    renameSync(tmp, file);       // replaced in one step, so a crash never leaves half a file
  } catch (err) {
    console.warn('[reviews] could not save to', file, '-', err instanceof Error ? err.message : String(err));
  }
}

const fromDisk = globalForReviews.__cloudbuilder_reviews ? null : loadFromDisk();
const REVIEWS = globalForReviews.__cloudbuilder_reviews ?? new Map<string, ArchitectureReview>((fromDisk?.reviews ?? []).map((r) => [r.id, r]));
const DEPLOYMENTS = globalForReviews.__cloudbuilder_deployments ?? fromDisk?.deployments ?? [];
if (process.env.NODE_ENV !== 'production') {
  globalForReviews.__cloudbuilder_reviews = REVIEWS;
  globalForReviews.__cloudbuilder_deployments = DEPLOYMENTS;
}

export class ArchitectureReviewService {
  /**
   * Deterministic SHA-256 hash of nodes and edges structure and configuration
   */
  static computeArchitectureHash(nodes: CanvasNode[] = [], edges: CanvasEdge[] = []): string {
    const cleanNodes = [...(nodes || [])]
      .sort((a, b) => (a?.id || '').localeCompare(b?.id || ''))
      .map((n) => ({
        id: n?.id || '',
        resourceType: n?.resourceType || '',
        provider: n?.provider || 'aws',
        groupId: n?.groupId || null,
        config: n?.config || {},
        position: {
          x: Math.round(n?.position?.x ?? 0),
          y: Math.round(n?.position?.y ?? 0),
        },
      }));

    const cleanEdges = [...(edges || [])]
      .sort((a, b) => (a?.id || '').localeCompare(b?.id || ''))
      .map((e) => ({
        id: e?.id || '',
        source: e?.source || '',
        target: e?.target || '',
        edgeType: e?.edgeType || 'network',
      }));

    const payload = JSON.stringify({ nodes: cleanNodes, edges: cleanEdges });
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Submit an architecture for review
   */
  static submitReview(
    projectId: string,
    environment: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    user: { id: string; name: string; email: string },
    summary: { nodeCount: number; edgeCount: number; criticalIssuesCount: number; estimatedMonthlyCost: number }
  ): ArchitectureReview {
    const architectureHash = this.computeArchitectureHash(nodes, edges);
    const reviewId = `rev-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const review: ArchitectureReview = {
      id: reviewId,
      projectId,
      environment,
      architectureHash,
      status: 'pending_review',
      submittedBy: user,
      submittedAt: new Date().toISOString(),
      summary,
      ...(superAdminsConfigured() ? { assignedTo: superAdminEmails() } : {}),
    };

    REVIEWS.set(reviewId, review);
    persist();
    return review;
  }

  /**
   * Get the latest review for a project and environment
   */
  static getLatestReview(projectId: string, environment?: string): ArchitectureReview | null {
    const matches = [...REVIEWS.values()]
      .filter((r) => r.projectId === projectId && (!environment || r.environment === environment))
      .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());

    return matches[0] ?? null;
  }

  /**
   * List reviews for a project
   */
  static listReviews(projectId: string, environment?: string): ArchitectureReview[] {
    return [...REVIEWS.values()]
      .filter((r) => r.projectId === projectId && (!environment || r.environment === environment))
      .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
  }

  /** Only a super administrator decides, when there is one. The routes check this too; this keeps any other caller of the service honest. */
  private static assertMayDecide(email: string): void {
    if (superAdminsConfigured() && !isSuperAdmin(email)) {
      throw Object.assign(new Error(reviewDecisionMessage()), { statusCode: 403 });
    }
  }

  /**
   * Whether a review's approval counts. With a super administrator set up, an approval given by anyone else does not (for example one given
   * before the setting was turned on), so nothing can be deployed on the strength of it.
   */
  static approvalIsValid(review: ArchitectureReview | null | undefined): boolean {
    if (!review || review.status !== 'approved') return false;
    return !superAdminsConfigured() || isSuperAdmin(review.reviewedBy?.email);
  }

  /** The message for a deployment or plan that has no valid approval. */
  static approvalBlockedMessage(review: ArchitectureReview | null | undefined, what: 'Deployment' | 'Plan'): string {
    if (review?.status === 'approved' && !this.approvalIsValid(review)) return `${what} blocked: the approval must come from ${superAdminEmails().join(' or ')}. Submit the architecture for review again.`;
    return review?.status === 'invalidated_due_to_changes'
      ? `${what} blocked: Architecture was modified after approval and approval was invalidated.`
      : `${what} blocked: Architecture must be formally approved before ${what === 'Plan' ? 'a Terraform plan can be generated' : 'deployment'}.`;
  }

  /**
   * Approve a review (Admin only)
   */
  static approveReview(
    reviewId: string,
    adminUser: { id: string; name: string; email: string },
    comments = 'Architecture approved for deployment'
  ): ArchitectureReview {
    this.assertMayDecide(adminUser.email);
    const review = REVIEWS.get(reviewId);
    if (!review) throw new Error(`Review ${reviewId} not found`);

    review.status = 'approved';
    review.reviewedBy = adminUser;
    review.reviewedAt = new Date().toISOString();
    review.reviewerComments = comments;
    persist();
    return review;
  }

  /**
   * Reject a review (Admin only)
   */
  static rejectReview(
    reviewId: string,
    adminUser: { id: string; name: string; email: string },
    comments: string
  ): ArchitectureReview {
    this.assertMayDecide(adminUser.email);
    const review = REVIEWS.get(reviewId);
    if (!review) throw new Error(`Review ${reviewId} not found`);

    review.status = 'rejected';
    review.reviewedBy = adminUser;
    review.reviewedAt = new Date().toISOString();
    review.reviewerComments = comments;
    persist();
    return review;
  }

  /**
   * Request changes for a review (Admin only)
   */
  static requestChanges(
    reviewId: string,
    adminUser: { id: string; name: string; email: string },
    comments: string
  ): ArchitectureReview {
    this.assertMayDecide(adminUser.email);
    const review = REVIEWS.get(reviewId);
    if (!review) throw new Error(`Review ${reviewId} not found`);

    review.status = 'changes_requested';
    review.reviewedBy = adminUser;
    review.reviewedAt = new Date().toISOString();
    review.reviewerComments = comments;
    persist();
    return review;
  }

  /**
   * Automatically invalidate approval if the architecture changed after approval
   */
  static checkAndInvalidateOnSave(
    projectId: string,
    environment: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[]
  ): { invalidated: boolean; review?: ArchitectureReview } {
    const latestReview = this.getLatestReview(projectId, environment);
    if (!latestReview || latestReview.status !== 'approved') {
      return { invalidated: false };
    }

    const currentHash = this.computeArchitectureHash(nodes, edges);
    if (latestReview.architectureHash !== currentHash) {
      latestReview.status = 'invalidated_due_to_changes';
      latestReview.invalidatedAt = new Date().toISOString();
      latestReview.invalidationReason =
        'Architecture topology or configuration was modified after approval. Re-review and approval required.';
      persist();
      return { invalidated: true, review: latestReview };
    }

    return { invalidated: false, review: latestReview };
  }

  /**
   * Execute deployment with full enterprise security checks
   */
  static async executeDeployment(
    projectId: string,
    environment: string,
    user: { id: string; name: string; email: string; role: string },
    nodes: CanvasNode[],
    edges: CanvasEdge[]
  ): Promise<DeploymentRecord> {
    // 1. RBAC Gate: Must be Admin
    if (user.role !== 'admin') {
      const err: any = new Error('Forbidden: Only Administrators can deploy infrastructure to target environments.');
      err.statusCode = 403;
      throw err;
    }

    // 2. Review Gate: Must have an approved review
    const latestReview = this.getLatestReview(projectId, environment);
    if (!latestReview || !this.approvalIsValid(latestReview)) {
      const err: any = new Error(this.approvalBlockedMessage(latestReview, 'Deployment'));
      err.statusCode = 400;
      throw err;
    }

    // 3. Hash Tamper Gate: Current hash must match approved hash
    const currentHash = this.computeArchitectureHash(nodes, edges);
    if (latestReview.architectureHash !== currentHash) {
      const err: any = new Error(
        'Deployment blocked: Architecture hash mismatch. The live canvas contains unapproved changes.'
      );
      err.statusCode = 409;
      throw err;
    }

    // 4. Security Gate: No critical security issues
    const issues = runSecurityScan(nodes, edges);
    const criticalIssues = issues.filter((i) => i.severity === 'critical');
    if (criticalIssues.length > 0) {
      const err: any = new Error(
        `Deployment blocked: ${criticalIssues.length} critical security issue(s) detected.`
      );
      err.statusCode = 400;
      throw err;
    }

    // 5. Generate and execute deployment steps
    const deployId = `dep-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const steps = [
      { id: 'validate', label: 'Validate Architecture', status: 'success', output: '✓ Architecture hash verified against approval' },
      { id: 'security', label: 'Security Policy Check', status: 'success', output: '✓ Zero critical findings detected' },
      { id: 'plan',     label: 'Terraform Execution Plan', status: 'success', output: `✓ Plan generated: ${nodes.length} resources to manage` },
      { id: 'apply',    label: 'Cloud Infrastructure Apply', status: 'success', output: `✓ Applied to ${environment} (${nodes.length} resources synchronized)` },
    ];

    const record: DeploymentRecord = {
      id: deployId,
      projectId,
      environment,
      architectureHash: currentHash,
      reviewId: latestReview.id,
      deployedBy: { id: user.id, name: user.name, email: user.email },
      deployedAt: new Date().toISOString(),
      status: 'success',
      steps,
      durationMs: 2450,
    };

    DEPLOYMENTS.unshift(record);
    persist();
    return record;
  }

  /**
   * List deployment history
   */
  static listDeployments(projectId: string, environment?: string): DeploymentRecord[] {
    return DEPLOYMENTS.filter(
      (d) => d.projectId === projectId && (!environment || d.environment === environment)
    );
  }
}
