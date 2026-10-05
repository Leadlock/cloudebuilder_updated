/**
 * Checks that an approval (or a password confirmation) is being asked for a plan that really exists in this project and organisation,
 * and has not changed, and describes it in one line. Shared by the approval request and the password confirmation, so both refuse the
 * same things.
 */
import { verifyPlanForApply } from './TerraformExecutionService';
import { peekPreparedDestroy } from './destroyPlans';

export type PlanDescription = { ok: true; summary: string } | { ok: false; status: 400 | 404; message: string };

export function describePlanForApproval(input: { orgId: string; projectId: string; action: 'apply' | 'destroy'; planId: string; planHash: string }): PlanDescription {
  const { orgId, projectId, action, planId, planHash } = input;
  if (action === 'apply') {
    let record;
    try { record = verifyPlanForApply(planId, planHash); } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode ?? 400;
      return { ok: false, status: statusCode === 404 ? 404 : 400, message: err instanceof Error ? err.message : 'Plan verification failed' };
    }
    if (record.orgId !== orgId || record.projectId !== projectId) return { ok: false, status: 404, message: 'Plan not found' };
    return { ok: true, summary: `${record.summary.toAdd} to add, ${record.summary.toChange} to change, ${record.summary.toDestroy} to destroy` };
  }
  const prepared = peekPreparedDestroy(planId);
  if (!prepared || prepared.orgId !== orgId || prepared.projectId !== projectId) return { ok: false, status: 404, message: 'The teardown preview has expired. Preview it again.' };
  if (prepared.planHash !== planHash) return { ok: false, status: 400, message: 'The teardown preview changed. Preview it again.' };
  return { ok: true, summary: `Tear down ${prepared.resources.length} resource(s) in the ${prepared.environment} state` };
}
