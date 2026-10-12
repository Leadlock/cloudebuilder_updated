/**
 * The account-control readings an assessment of this project should include, for the routes that run one.
 *
 * Returns undefined when the account has never been checked, so a project that has not used the feature is assessed exactly as
 * before (the account-level rules stay NOT EVALUATED); a database problem here never stops an assessment from running.
 */
import { accountControlEvidenceRepository } from '@/lib/repositories/accountControlEvidenceRepository';
import type { AccountEvidenceMap } from '@/lib/engines/assessment/accountEvidence';

export async function loadAccountEvidence(projectId: string): Promise<AccountEvidenceMap | undefined> {
  try {
    const evidence = await accountControlEvidenceRepository.evidenceFor(projectId);
    return Object.keys(evidence).length > 0 ? evidence : undefined;
  } catch (err) {
    console.warn('[account evidence] could not load readings; assessing without them:', err instanceof Error ? err.message : err);
    return undefined;
  }
}
