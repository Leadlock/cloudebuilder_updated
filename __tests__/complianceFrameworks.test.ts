/** The control sets: right sizes, no invented checks, and the SOC 2 scope choice. */
import { awsDefs, azureDefs, soc2Defs, defsFor } from '@/lib/compliance/frameworks';
import { ALL_RULES } from '@/lib/engines/assessment/rules';
import { QUESTION_RULES } from '@/lib/engines/assessment/questionnaire/questionRules';

const known = new Set([...ALL_RULES, ...QUESTION_RULES].map((r) => r.id));
const PLATFORM = new Set(['mfa', 'approvals', 'audit-log', 'restricted-deploy', 'recent-assessment', 'recent-discovery']);
const unknown = (defs: ReturnType<typeof awsDefs>) => defs.flatMap((d) => (d.rules ?? []).filter((r) => !known.has(r)).map((r) => `${d.id} -> ${r}`));

describe('AWS Well-Architected controls', () => {
  const defs = awsDefs();
  it('are the 56 questions, six pillars, unique ids', () => {
    expect(defs).toHaveLength(56);
    expect(new Set(defs.map((d) => d.id)).size).toBe(56);
    expect(new Set(defs.map((d) => d.group))).toEqual(new Set(['Operational Excellence', 'Security', 'Reliability', 'Performance Efficiency', 'Cost Optimization', 'Sustainability']));
    const count = (p: string) => defs.filter((d) => d.group === p).length;
    expect([count('Operational Excellence'), count('Security'), count('Reliability'), count('Performance Efficiency'), count('Cost Optimization'), count('Sustainability')]).toEqual([11, 10, 13, 5, 11, 6]);
  });
  it('name only checks that exist, and only AWS ones', () => {
    expect(unknown(defs)).toEqual([]);
    expect(defs.flatMap((d) => d.rules ?? []).filter((r) => r.startsWith('AZ-') || r.startsWith('WAQ-AZ-'))).toEqual([]);
    for (const d of defs) for (const p of d.platform ?? []) expect(PLATFORM.has(p)).toBe(true);
  });
});

describe('Azure Well-Architected controls', () => {
  it('are the 59 recommendations of the five pillars', () => {
    const defs = azureDefs();
    expect(defs).toHaveLength(59);
    expect(defs[0]!.id).toBe('RE:01');
    expect(unknown(defs)).toEqual([]);
  });
});

describe('SOC 2 controls', () => {
  it('follow the categories the company chose', () => {
    const all = soc2Defs();
    const sec = soc2Defs(['security']);
    expect(all.length).toBe(63);
    expect(sec.every((d) => d.group.startsWith('CC'))).toBe(true);
    expect(soc2Defs(['availability']).every((d) => d.group.startsWith('A1'))).toBe(true);
    expect(sec.length + soc2Defs(['availability']).length + soc2Defs(['confidentiality']).length).toBe(all.length);
    expect(unknown(all)).toEqual([]);
  });
  it('carry the effect of a failure in the words of the criterion', () => {
    expect(soc2Defs().find((d) => d.id === 'CTL-22')!.effect).toMatch(/^Weakens CC6\.1 \(Access protection\)/);
    expect(defsFor('soc2', ['security']).length).toBeLessThan(defsFor('soc2').length);
  });
});
