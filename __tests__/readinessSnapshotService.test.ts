/**
 * @jest-environment node
 */
/** The nightly snapshot: one per project and framework in use, a failure on one never stops the others, and a stored snapshot is compact. */
import { fixtureReport, fixtureInput } from './helpers/complianceFixture';

const R = { activeProjects: jest.fn(), addSnapshot: jest.fn() };
const build = jest.fn(); const projectRow = jest.fn();
jest.mock('@/lib/repositories/readinessRepository', () => ({ readinessRepository: R }));
jest.mock('@/lib/compliance/service', () => ({ buildProjectReport: (...a: unknown[]) => build(...a) }));
jest.mock('@/src/prisma/db', () => ({ db: { orm: { public: { Project: { where: (w: { id: string }) => ({ select: () => ({ first: async () => projectRow(w.id) }) }) } } } } }));

import { snapshotAllProjects, takeSnapshot } from '@/lib/compliance/snapshotService';

beforeEach(() => {
  jest.clearAllMocks();
  R.addSnapshot.mockResolvedValue('snap-1');
  projectRow.mockImplementation((id: string) => (id === 'gone' ? null : { orgId: `org-of-${id}` }));
  build.mockImplementation(async (a: { framework: 'soc2' | 'aws-waf' }) => ({ ok: true, report: fixtureReport(a.framework), input: fixtureInput(a.framework) }));
});

describe('a snapshot', () => {
  it('stores readiness, a summary, one compact entry per control and the platform facts', async () => {
    const r = await takeSnapshot({ orgId: 'o1', projectId: 'p1', framework: 'soc2', trigger: 'manual' });
    expect(r).toMatchObject({ ok: true, id: 'snap-1' });
    const [projectId, fw, row] = R.addSnapshot.mock.calls[0];
    expect([projectId, fw, row.trigger]).toEqual(['p1', 'soc2', 'manual']);
    expect(row.controls).toHaveLength(fixtureReport('soc2').results.length);
    expect(row.summary).toMatchObject({ total: expect.any(Number), coveragePct: expect.any(Number) });
    expect(row.facts).toMatchObject({ members: 5 });
  });
  it('says why when nothing could be taken', async () => {
    build.mockResolvedValueOnce({ ok: false, reason: 'no_architecture' });
    expect(await takeSnapshot({ orgId: 'o1', projectId: 'p1', framework: 'soc2', trigger: 'scheduled' })).toEqual({ ok: false, reason: 'no_architecture' });
    expect(R.addSnapshot).not.toHaveBeenCalled();
  });
});

describe('the nightly pass', () => {
  it('covers every framework of every active project, skipping what has gone and carrying on after a failure', async () => {
    R.activeProjects.mockResolvedValue([{ projectId: 'p1', frameworks: ['soc2', 'aws-waf'] }, { projectId: 'gone', frameworks: ['soc2'] }, { projectId: 'p2', frameworks: ['soc2'] }]);
    build.mockImplementationOnce(async () => { throw new Error('database blip'); });
    const log = jest.fn();
    const r = await snapshotAllProjects(log);
    expect(r).toEqual({ projects: 3, taken: 2, skipped: 1, failed: 1 });
    expect(R.addSnapshot).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('database blip'));
    expect(build.mock.calls.map((c) => c[0].orgId)).toEqual(['org-of-p1', 'org-of-p1', 'org-of-p2']);
    expect(build.mock.calls.every((c) => c[0].preparedBy.includes('scheduled snapshot'))).toBe(true);
  });
  it('does nothing when no project uses the reports', async () => {
    R.activeProjects.mockResolvedValue([]);
    expect(await snapshotAllProjects(jest.fn())).toEqual({ projects: 0, taken: 0, skipped: 0, failed: 0 });
  });
});
