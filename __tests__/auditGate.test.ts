/** The dependency audit gate: high and critical fail unless accepted with a reason; an exception that is no longer needed fails too. */
import { auditReport, evaluateAudit, validateAuditPolicy, type AuditJson } from '@/lib/scan/audit';
import policy from '../security/audit-policy.json';

const vuln = (severity: string, title = 'A flaw', isDirect = false) => ({ severity, isDirect, via: [{ title }] });

describe('the gate', () => {
  it('fails a high or critical advisory nobody decided about, and names it', () => {
    const v = evaluateAudit({ vulnerabilities: { next: vuln('critical', 'Remote code execution', true), left: vuln('low') } } as AuditJson, { accepted: [] });
    expect(v.ok).toBe(false);
    expect(v.failing).toEqual([{ package: 'next', severity: 'critical', why: 'Remote code execution', direct: true }]);
    expect(auditReport(v)).toContain('CRITICAL next (a direct dependency): Remote code execution');
  });
  it('passes an accepted one, with its reason in the report, and lists moderate ones without failing', () => {
    const v = evaluateAudit({ vulnerabilities: { x: vuln('high'), y: vuln('moderate') } } as AuditJson, { accepted: [{ package: 'x', reason: 'Not reachable: the affected flow is never used.' }] });
    expect(v.ok).toBe(true);
    expect(v.accepted[0]).toMatchObject({ package: 'x', reason: expect.stringContaining('Not reachable') });
    expect(v.other).toEqual([{ package: 'y', severity: 'moderate' }]);
  });
  it('fails when an accepted package is no longer high or critical, so exceptions cannot linger', () => {
    const v = evaluateAudit({ vulnerabilities: { x: vuln('moderate') } } as AuditJson, { accepted: [{ package: 'x', reason: 'Was not reachable at the time.' }, { package: 'gone', reason: 'Was not reachable at the time.' }] });
    expect(v.ok).toBe(false);
    expect(v.stale).toEqual(['gone', 'x']);
    expect(auditReport(v)).toContain('Remove from the policy');
  });
  it('an advisory that arrives through another package is named by that package', () => {
    const v = evaluateAudit({ vulnerabilities: { a: { severity: 'high', via: ['b'] } } } as AuditJson, { accepted: [] });
    expect(v.failing[0]!.why).toBe('through b');
  });
  it('a clean audit passes', () => { expect(evaluateAudit({ vulnerabilities: {} }, { accepted: [] }).ok).toBe(true); });
});

describe('the policy file', () => {
  it('is valid: every exception has a real reason, once', () => { expect(validateAuditPolicy(policy)).toEqual([]); });
  it('rejects a missing reason, a duplicate and a nameless entry', () => {
    expect(validateAuditPolicy({ accepted: [{ package: 'a', reason: 'ok' }, { package: 'b', reason: 'A proper reason for the exception.' }, { package: 'b', reason: 'A proper reason for the exception.' }, { package: '', reason: 'A proper reason for the exception.' }] }).length).toBe(3);
  });
});
