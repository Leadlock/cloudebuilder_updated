/** The SOC 2 catalog is internally consistent: every criterion has a control, every check it names exists, and nothing is copied or overclaimed. */
import { SOC2_CRITERIA, SOC2_CRITERIA_BY_ID } from '@/lib/compliance/soc2/criteria';
import { SOC2_CONTROLS, soc2CategoryOf } from '@/lib/compliance/soc2/controls';
import { ALL_RULES } from '@/lib/engines/assessment/rules';
import { QUESTION_RULES } from '@/lib/engines/assessment/questionnaire/questionRules';
import { EXTERNAL_QUESTIONS } from '@/lib/engines/assessment/externalQuestions';

describe('criteria', () => {
  it('are the 38 criteria of Security, Availability and Confidentiality, once each', () => {
    expect(SOC2_CRITERIA).toHaveLength(38);
    expect(new Set(SOC2_CRITERIA.map((c) => c.id)).size).toBe(38);
    expect(SOC2_CRITERIA.filter((c) => c.category === 'security')).toHaveLength(33);
    expect(SOC2_CRITERIA.filter((c) => c.category === 'availability').map((c) => c.id)).toEqual(['A1.1', 'A1.2', 'A1.3']);
    expect(SOC2_CRITERIA.filter((c) => c.category === 'confidentiality').map((c) => c.id)).toEqual(['C1.1', 'C1.2']);
  });
});

describe('controls', () => {
  it('have unique ids, each tied to one real criterion, with a repeatable activity and evidence to ask for', () => {
    expect(new Set(SOC2_CONTROLS.map((c) => c.id)).size).toBe(SOC2_CONTROLS.length);
    for (const c of SOC2_CONTROLS) {
      expect(SOC2_CRITERIA_BY_ID.has(c.criterion)).toBe(true);
      expect(c.activity.length).toBeGreaterThan(40);
      expect(c.evidence.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(5);
      expect(c.ownerRole).toBeTruthy();
      expect(c.frequency).toBeTruthy();
    }
  });
  it('cover every criterion at least once', () => {
    const covered = new Set(SOC2_CONTROLS.map((c) => c.criterion));
    expect(SOC2_CRITERIA.filter((c) => !covered.has(c.id)).map((c) => c.id)).toEqual([]);
  });
  it('name only checks and questions that exist', () => {
    const known = new Set([...ALL_RULES, ...QUESTION_RULES].map((r) => r.id));
    const missing = SOC2_CONTROLS.flatMap((c) => (c.rules ?? []).filter((r) => !known.has(r)).map((r) => `${c.id} -> ${r}`));
    expect(missing).toEqual([]);
    expect(EXTERNAL_QUESTIONS.length).toBeGreaterThan(0);
  });
  it('count controls per category, and have no wording that claims compliance or certification', () => {
    const by = (cat: string) => SOC2_CONTROLS.filter((c) => soc2CategoryOf(c) === cat).length;
    expect(by('security') + by('availability') + by('confidentiality')).toBe(SOC2_CONTROLS.length);
    expect(by('availability')).toBeGreaterThanOrEqual(6);
    expect(by('confidentiality')).toBeGreaterThanOrEqual(5);
    const text = JSON.stringify([...SOC2_CONTROLS, ...SOC2_CRITERIA]);
    expect(text).not.toMatch(/\b(certified|SOC 2 compliant|attested)\b/i);
  });
});
