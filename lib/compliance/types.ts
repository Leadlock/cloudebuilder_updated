/**
 * Shared types of the compliance readiness module: SOC 2 (Type 1 readiness), and the control reports for the AWS and Azure Well-Architected frameworks.
 * Everything here is plain data. The scoring and the report are pure functions of it, so the same inputs always give the same report.
 */
import type { Severity } from '@/lib/engines/assessment/types';

export type FrameworkId = 'soc2' | 'aws-waf' | 'azure-waf';

/** What the control owner says about the control. Unset means nobody has answered yet. */
export type ControlStatus = 'implemented' | 'partial' | 'planned' | 'none' | 'not_applicable';

export interface ControlRecord {
  controlId: string;
  status?: ControlStatus;
  owner: string;
  note: string;
  /** Why a control does not apply. Required for not_applicable. */
  naReason: string;
  reviewer: string;
  reviewedAt?: string;
  updatedAt?: string;
}

/** A piece of evidence attached to one or more controls. The file itself is stored elsewhere; reports only ever see this description. */
export interface EvidenceRef {
  id: string;
  title: string;
  kind: 'file' | 'link' | 'note';
  /** system: exported from a system (a configuration export, a log extract); manual: written or collected by hand. */
  origin: 'system' | 'manual';
  /** The date the evidence was produced (ISO date). Not the upload date. */
  collectedAt: string;
  validUntil?: string;
  fileName?: string;
  sha256?: string;
  uploadedBy?: string;
}

/** One fact about a control, from a check or an answer. Reports show these as the reason behind a score. */
export interface Signal {
  /** design: read from the architecture; discovered/live: read from the cloud account; answer: the team's answer to a question; platform: from CloudBuilder's own records. */
  basis: 'design' | 'discovered' | 'live' | 'answer' | 'platform';
  result: 'pass' | 'fail' | 'unclear';
  /** Rule or check id, e.g. AWS-S3-002. */
  ref: string;
  text: string;
  severity?: Severity;
}

/** 0 Missing, 1 Informal, 2 Implemented, 3 Operating, 4 Audit-ready. */
export type Score = 0 | 1 | 2 | 3 | 4;
export type Confidence = 'High' | 'Medium' | 'Low';

export const SCORE_LABEL: Record<Score, string> = { 0: 'Missing', 1: 'Informal', 2: 'Implemented', 3: 'Operating', 4: 'Audit-ready' };
export const SCORE_MEANING: Record<Score, string> = {
  0: 'The control does not exist, or is only planned.',
  1: 'The team says it happens, but nothing shows it: no evidence and no check.',
  2: 'It exists and something supports it (a check on the design, or evidence that is old or partial), but not enough to rely on.',
  3: 'It operates: dated evidence within the window, or a check that read it from the cloud account, with nothing against it.',
  4: 'Audit-ready: operating, backed by a live check or system evidence, and reviewed by someone other than its owner.',
};

export interface ControlResult {
  id: string;
  title: string;
  /** The group it sits in: a criterion (CC6.1), a pillar (Security) or a domain. */
  group: string;
  owner: string;
  status?: ControlStatus;
  /** null: not scored (not applicable, or nobody has assessed it yet). */
  score: Score | null;
  scoreLabel: string;
  confidence: Confidence;
  signals: Signal[];
  evidence: EvidenceRef[];
  /** Plain sentences explaining the score. */
  reasons: string[];
  /** What would raise it. */
  nextStep: string;
  reviewer: string;
  reviewedAt?: string;
  note: string;
}

export type FindingSeverity = 'High' | 'Medium' | 'Low';
export type FindingStatus = 'open' | 'in_progress' | 'closed' | 'risk_accepted';

/** What a person writes about a finding. The finding itself (condition, cause, effect) is derived from the control. */
export interface FindingRecord {
  controlId: string;
  owner: string;
  targetDate?: string;
  status: FindingStatus;
  managementResponse: string;
  acceptedBy: string;
  retestedBy: string;
  retestedAt?: string;
  updatedAt?: string;
}

export interface Finding {
  id: string;
  controlId: string;
  group: string;
  severity: FindingSeverity;
  title: string;
  condition: string;
  cause: string;
  effect: string;
  recommendation: string;
  owner: string;
  targetDate?: string;
  status: FindingStatus;
  managementResponse: string;
  acceptedBy: string;
  retestedBy: string;
  retestedAt?: string;
}

export interface Limitation { id: string; item: string; effect: string; controlId?: string }

export type Readiness = 'Ready' | 'Ready with conditions' | 'Not ready' | 'Incomplete';

export interface Signoff { role: 'preparer' | 'reviewer' | 'management'; name: string; email: string; signedAt: string; reportHash?: string }
