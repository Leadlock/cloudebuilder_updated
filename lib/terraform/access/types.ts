export type AccessStatus = 'none' | 'requested' | 'approved' | 'denied' | 'revoked';
export type AccessSource = 'auto' | 'operator';

export interface EligibilityCheck {
  id: 'authenticator' | 'cloud-account' | 'encryption-key';
  label: string;
  passed: boolean;
  /** What was found. */
  detail: string;
  /** What to do when it did not pass. */
  fix: string;
}

export interface AccessRecord {
  orgId: string;
  status: Exclude<AccessStatus, 'none'>;
  source: AccessSource;
  requestedBy: string | null;
  requestedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  checks: EligibilityCheck[];
  updatedAt: string;
}
