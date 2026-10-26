/**
 * The AWS Well-Architected Tool sync: what is selected from the design's evidence, what is never touched, and that re-running is safe.
 * The Tool itself is replaced by an in-memory fake that follows its rules (an update REPLACES the selected choices).
 */
import type { Evaluation } from '@/lib/engines/assessment/types';
import { ALL_RULES } from '@/lib/engines/assessment/rules';
import { AWS_BEST_PRACTICES } from '@/lib/wellArchitectedTool/awsMap';
import { evaluatePractices, mergeNotes, planSync, type ToolAnswer } from '@/lib/wellArchitectedTool/plan';
import { syncWorkload, workloadNameFor } from '@/lib/wellArchitectedTool/sync';
import type { WaToolClient, WorkloadInput } from '@/lib/wellArchitectedTool/client';

const ev = (ruleId: string, status: Evaluation['status'], observation = 'observed'): Evaluation => ({ ruleId, status, observation } as Evaluation);

// The Tool's questions for the practices above, as ListAnswers would give them.
const QUESTIONS: ToolAnswer[] = [
  { questionId: 'protect-data-rest', questionTitle: 'SEC 8. How do you protect your data at rest?', choices: [{ id: 'sec_protect_data_rest_key_mgmt', title: 'k' }, { id: 'sec_protect_data_rest_encrypt', title: 'e' }, { id: 'sec_protect_data_rest_none', title: 'None of these' }], selected: [] },
  { questionId: 'network-protection', questionTitle: 'SEC 5. How do you protect your network resources?', choices: [{ id: 'sec_network_protection_create_layers', title: 'l' }, { id: 'sec_network_protection_layered', title: 'f' }, { id: 'sec_network_protection_inspection', title: 'i' }], selected: ['sec_network_protection_inspection'] },
  { questionId: 'fault-isolation', questionTitle: 'REL 10. fault isolation', choices: [{ id: 'rel_fault_isolation_multiaz_region_system', title: 'm' }], selected: [] },
];

class FakeTool implements WaToolClient {
  workloads = new Map<string, { id: string; input: WorkloadInput }>();
  answers = new Map<string, ToolAnswer>(QUESTIONS.map((q) => [q.questionId, { ...q, selected: [...q.selected] }]));
  notes = new Map<string, string>();
  calls: string[] = [];
  async findWorkload(name: string) { this.calls.push('find'); return [...this.workloads.values()].find((w) => w.input.name === name) ?? null; }
  async createWorkload(input: WorkloadInput) { this.calls.push('create'); const id = 'a'.repeat(32); this.workloads.set(id, { id, input }); return { id }; }
  async listAnswers() { return [...this.answers.values()].map((a) => ({ ...a, selected: [...a.selected] })); }
  async getNotes(_w: string, q: string) { return this.notes.get(q) ?? ''; }
  async updateAnswer(_w: string, q: string, c: { selectedChoices?: string[]; notes: string }) {
    this.calls.push(`update ${q}`);
    if (c.selectedChoices) this.answers.get(q)!.selected = c.selectedChoices;
    this.notes.set(q, c.notes);
  }
  async createMilestone() { this.calls.push('milestone'); return 3; }
}

const base = { project: { id: '12345678-aaaa-bbbb-cccc-1234567890ab', name: 'Shop', environment: 'production' }, regions: ['eu-north-1'], reviewOwner: 'a@b.co', rulesetVersion: 'r1', evaluatedAt: '2026-10-26T00:00:00.000Z' };
const GOOD = [ev('AWS-S3-002', 'PASS'), ev('AWS-RDS-002', 'PASS'), ev('AWS-KMS-001', 'PASS'), ev('AWS-SG-001', 'PASS'), ev('AWS-ARCH-002', 'PASS')];

describe('the best-practice map', () => {
  it('names only checks that exist, and each practice once', () => {
    const rules = new Set(ALL_RULES.map((r) => r.id));
    for (const p of AWS_BEST_PRACTICES) for (const id of p.ruleIds) expect(rules.has(id)).toBe(true);
    expect(new Set(AWS_BEST_PRACTICES.map((p) => p.choiceId)).size).toBe(AWS_BEST_PRACTICES.length);
    for (const p of AWS_BEST_PRACTICES) expect(p.choiceId).toMatch(/^(sec|rel|ops|perf|cost|sus)_[a-z0-9_]+$/);
  });
});

describe('what counts as evidence', () => {
  it('is met only when something passed and nothing failed or lacked data', () => {
    const state = (evs: Evaluation[]) => evaluatePractices(evs).find((p) => p.bp === 'SEC08-BP02')!.state;
    expect(state([ev('AWS-S3-002', 'PASS')])).toBe('met');
    expect(state([ev('AWS-S3-002', 'PASS'), ev('AWS-RDS-002', 'FAIL')])).toBe('not_met');
    expect(state([ev('AWS-S3-002', 'PASS'), ev('AWS-RDS-002', 'WARNING')])).toBe('not_met');
    expect(state([ev('AWS-S3-002', 'PASS'), ev('AWS-RDS-002', 'INSUFFICIENT_DATA')])).toBe('unknown');
    expect(state([ev('AWS-S3-002', 'NOT_APPLICABLE')])).toBe('unknown');
    expect(state([])).toBe('unknown');
  });
});

describe('planning', () => {
  it('adds to what a person selected and never removes it', () => {
    const plan = planSync([ev('AWS-SG-001', 'PASS')], QUESTIONS, { rulesetVersion: 'r1', evaluatedAt: '2026-10-26T00:00:00Z' });
    const net = plan.updates.find((u) => u.questionId === 'network-protection')!;
    expect(net.selectedChoices).toEqual(['sec_network_protection_inspection', 'sec_network_protection_layered']);
  });

  it('writes notes but changes no selection for a practice that is not in place', () => {
    const plan = planSync([ev('AWS-S3-002', 'FAIL', 'bucket b has no encryption')], QUESTIONS, { rulesetVersion: 'r1', evaluatedAt: '2026-10-26T00:00:00Z' });
    const u = plan.updates.find((x) => x.questionId === 'protect-data-rest')!;
    expect(u.selectedChoices).toBeUndefined();
    expect(u.notesBlock).toContain('Not in place: SEC08-BP02');
    expect(u.notesBlock).toContain('bucket b has no encryption');
  });

  it('reports a practice the lens does not list instead of guessing a question', () => {
    const plan = planSync(GOOD, QUESTIONS.slice(0, 1), { rulesetVersion: 'r1', evaluatedAt: '2026-10-26T00:00:00Z' });
    expect(plan.unmatched.map((p) => p.bp)).toContain('REL10-BP01');
    expect(plan.updates.map((u) => u.questionId)).toEqual(['protect-data-rest']);
  });

  it('keeps a person\'s notes and replaces only its own block', () => {
    const first = mergeNotes('Our team note.', '--- CloudBuilder, ruleset r1 ---\nold\n--- end CloudBuilder ---');
    const second = mergeNotes(first, '--- CloudBuilder, ruleset r2 ---\nnew\n--- end CloudBuilder ---');
    expect(second).toContain('Our team note.');
    expect(second).toContain('new');
    expect(second).not.toContain('old');
    expect(second.match(/end CloudBuilder/g)).toHaveLength(1);
  });

  it('never exceeds the Tool\'s notes limit and never cuts the person\'s own notes', () => {
    const own = 'x'.repeat(1500);
    const merged = mergeNotes(own, `--- CloudBuilder ---\n${'y'.repeat(3000)}\n--- end CloudBuilder ---`);
    expect(merged.length).toBeLessThanOrEqual(2084);
    expect(merged.startsWith(own)).toBe(true);
  });
});

describe('the sync', () => {
  it('creates the workload once, pre-fills the supported answers, and a second run changes nothing', async () => {
    const tool = new FakeTool();
    const first = await syncWorkload({ client: tool, ...base, evaluations: GOOD });
    expect(first.created).toBe(true);
    expect(tool.workloads.size).toBe(1);
    const w = [...tool.workloads.values()][0].input;
    expect(w.name).toBe(workloadNameFor(base.project));
    expect(w.environment).toBe('PRODUCTION');
    expect(w.regions).toEqual(['eu-north-1']);
    expect(tool.answers.get('protect-data-rest')!.selected.sort()).toEqual(['sec_protect_data_rest_encrypt', 'sec_protect_data_rest_key_mgmt']);
    expect(tool.answers.get('fault-isolation')!.selected).toEqual(['rel_fault_isolation_multiaz_region_system']);
    expect(first.unmatched.length).toBeGreaterThan(0); // practices whose questions this fake lens does not hold

    const again = await syncWorkload({ client: tool, ...base, evaluations: GOOD });
    expect(again.created).toBe(false);
    expect(tool.workloads.size).toBe(1);
    expect(again.answered).toEqual([]);
    expect(tool.answers.get('protect-data-rest')!.selected.sort()).toEqual(['sec_protect_data_rest_encrypt', 'sec_protect_data_rest_key_mgmt']);
  });

  it('uses PREPRODUCTION outside production and saves a milestone only when asked', async () => {
    const tool = new FakeTool();
    await syncWorkload({ client: tool, ...base, project: { ...base.project, environment: 'staging' }, evaluations: GOOD });
    expect([...tool.workloads.values()][0].input.environment).toBe('PREPRODUCTION');
    expect(tool.calls).not.toContain('milestone');
    const r = await syncWorkload({ client: tool, ...base, evaluations: GOOD, milestone: true });
    expect(r.milestone).toBe(3);
  });

  it('keeps the name within 100 characters and tells two projects with the same name apart', () => {
    const long = workloadNameFor({ id: 'a'.repeat(32), name: 'N'.repeat(300) });
    expect(long.length).toBeLessThanOrEqual(100);
    expect(workloadNameFor({ id: '11111111-0000-0000-0000-000000000000', name: 'Shop' })).not.toBe(workloadNameFor({ id: '22222222-0000-0000-0000-000000000000', name: 'Shop' }));
  });
});
