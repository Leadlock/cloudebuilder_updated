/**
 * Turns what CloudBuilder knows into the signals a control is scored on: assessment results (checks on the design, readings of the cloud account, answers to the
 * questionnaire) and facts about the platform itself (is a second factor on, are changes approved, is there an audit trail).
 */
import type { Evaluation } from '@/lib/engines/assessment/types';
import type { Signal } from './types';

export type PlatformCheck = 'mfa' | 'approvals' | 'audit-log' | 'restricted-deploy' | 'recent-assessment' | 'recent-discovery';

/** Facts about the organization's own use of CloudBuilder, gathered by the server (see lib/compliance/facts.ts). */
export interface PlatformFacts {
  members: number;
  mfaEnrolled: number;
  approvalsLast90d: number;
  auditEventsLast90d: number;
  deployRestricted: boolean;
  lastAssessmentAt?: string;
  lastDiscoveryAt?: string;
}

const isAnswerRule = (id: string) => id.startsWith('WAQ-') || id.includes('-EXT-');
const days = (iso: string, asOf: Date) => Math.floor((asOf.getTime() - new Date(iso).getTime()) / 86_400_000);

/** One signal per rule id that has results in this design. A rule with no results (the design has nothing it applies to) gives no signal. */
export function signalsFromEvaluations(evaluations: readonly Evaluation[], ruleIds: readonly string[]): Signal[] {
  const out: Signal[] = [];
  for (const ref of ruleIds) {
    const evs = evaluations.filter((e) => e.ruleId === ref);
    if (evs.length === 0) continue;
    const answer = isAnswerRule(ref);
    const failing = evs.filter((e) => e.status === 'FAIL' || e.status === 'WARNING');
    const passing = evs.filter((e) => e.status === 'PASS');
    const unclear = evs.filter((e) => e.status === 'INSUFFICIENT_DATA');
    if (failing.length > 0) {
      const worst = failing.find((e) => e.severity === 'CRITICAL') ?? failing.find((e) => e.severity === 'HIGH') ?? failing[0]!;
      out.push({ basis: answer ? 'answer' : basisOf(worst), result: 'fail', ref, text: `${trim(worst.observation)}${failing.length > 1 ? ` (and ${failing.length - 1} more)` : ''}`, severity: worst.severity });
    } else if (passing.length > 0 && unclear.length === 0) {
      const strongest = passing.map(basisOf).sort((a, b) => RANK[b] - RANK[a])[0]!;
      out.push({ basis: answer ? 'answer' : strongest, result: 'pass', ref, text: `${passing.length} ${passing.length === 1 ? 'check' : 'checks'} passed${answer ? ' (the team\'s answer)' : ''}` });
    } else if (unclear.length > 0) {
      out.push({ basis: answer ? 'answer' : basisOf(unclear[0]!), result: 'unclear', ref, text: trim(unclear[0]!.observation) });
    }
    // only NOT_EVALUATED / NOT_APPLICABLE: nothing was learned, so no signal.
  }
  return out;
}

const RANK: Record<Signal['basis'], number> = { design: 0, answer: 0, platform: 1, discovered: 2, live: 3 };
const basisOf = (e: Evaluation): Signal['basis'] => (e.provenance === 'LIVE_VERIFIED' ? 'live' : e.provenance === 'DISCOVERED_CONFIGURATION' ? 'discovered' : 'design');
const trim = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 220);

export function platformSignal(check: PlatformCheck, facts: PlatformFacts | undefined, asOf: Date): Signal | null {
  if (!facts) return null;
  const ref = `PLATFORM-${check}`;
  switch (check) {
    case 'mfa':
      if (facts.members === 0) return null;
      return facts.mfaEnrolled >= facts.members
        ? { basis: 'platform', result: 'pass', ref, text: `All ${facts.members} organization members have a second sign-in factor.` }
        : { basis: 'platform', result: 'fail', ref, severity: 'HIGH', text: `${facts.members - facts.mfaEnrolled} of ${facts.members} organization members have no second sign-in factor.` };
    case 'approvals':
      return facts.approvalsLast90d > 0 ? { basis: 'platform', result: 'pass', ref, text: `${facts.approvalsLast90d} infrastructure ${facts.approvalsLast90d === 1 ? 'change was' : 'changes were'} approved in CloudBuilder in the last 90 days.` } : null;
    case 'audit-log':
      return facts.auditEventsLast90d > 0 ? { basis: 'platform', result: 'pass', ref, text: `${facts.auditEventsLast90d} audit-trail ${facts.auditEventsLast90d === 1 ? 'event was' : 'events were'} recorded in the last 90 days.` } : null;
    case 'restricted-deploy':
      return facts.deployRestricted
        ? { basis: 'platform', result: 'pass', ref, text: 'Deploying, the AI Generator and cloud accounts are limited to named people.' }
        : { basis: 'platform', result: 'fail', ref, severity: 'MEDIUM', text: 'Deploying and cloud accounts are open to every member: no allow-list of named people is set.' };
    case 'recent-assessment': {
      if (!facts.lastAssessmentAt) return null;
      const d = days(facts.lastAssessmentAt, asOf);
      return d <= 35 ? { basis: 'platform', result: 'pass', ref, text: `The architecture was last assessed ${d} ${d === 1 ? 'day' : 'days'} ago.` } : { basis: 'platform', result: 'unclear', ref, text: `The architecture was last assessed ${d} days ago.` };
    }
    case 'recent-discovery': {
      if (!facts.lastDiscoveryAt) return null;
      const d = days(facts.lastDiscoveryAt, asOf);
      return d <= 35 ? { basis: 'platform', result: 'pass', ref, text: `The cloud account was last scanned for drift ${d} ${d === 1 ? 'day' : 'days'} ago.` } : { basis: 'platform', result: 'unclear', ref, text: `The cloud account was last scanned ${d} days ago.` };
    }
  }
}
