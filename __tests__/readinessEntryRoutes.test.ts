/**
 * @jest-environment node
 */
/** The records the team enters: what is refused, what is kept once per subject, that every change ends the sign-offs, and that one project cannot reach another's records. */
import { NextRequest } from 'next/server';

const guard = jest.fn();
const R = { entries: jest.fn(), saveEntry: jest.fn(), entryById: jest.fn(), updateEntry: jest.fn(), deleteEntry: jest.fn(), clearSignoffs: jest.fn(), updateSettings: jest.fn() };
jest.mock('@/lib/compliance/routeGuard', () => ({ guardReadiness: (...a: unknown[]) => guard(...a) }));
jest.mock('@/lib/repositories/readinessRepository', () => ({ readinessRepository: R }));
jest.mock('@/lib/compliance/service', () => ({ loadEngagement: async () => ({ cpaFirm: 'Harbor & Pike LLP', scanProvider: '', scanFrequency: '' }) }));

import * as entries from '@/app/api/projects/[id]/readiness/[framework]/entries/route';
import * as entryOne from '@/app/api/projects/[id]/readiness/[framework]/entries/[entryId]/route';
import * as engagement from '@/app/api/projects/[id]/readiness/[framework]/engagement/route';

const caller = (over: Record<string, unknown> = {}) => ({ userId: 'u', email: 'dana@x.com', orgId: 'o1', role: 'member', isAdmin: false, projectId: 'p1', framework: 'soc2', env: 'production', ...over });
const json = (method: string, body: unknown) => new NextRequest('http://localhost/x', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const ctx = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ id: 'p1', framework: 'soc2', ...extra }) });
type H = (r: NextRequest, c: any) => Promise<Response>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  jest.clearAllMocks();
  guard.mockResolvedValue(caller()); R.entries.mockResolvedValue([]); R.saveEntry.mockResolvedValue('e1'); R.clearSignoffs.mockResolvedValue(undefined);
});

describe('adding a record', () => {
  const POST = entries.POST as H;
  it('saves a valid record, and ends the sign-offs', async () => {
    const res = await POST(json('POST', { kind: 'change', data: { date: '2026-09-01', change: 'Moved the database' } }), ctx());
    expect(res.status).toBe(201);
    expect(R.saveEntry).toHaveBeenCalledWith('p1', 'soc2', 'change', null, expect.objectContaining({ date: '2026-09-01', change: 'Moved the database', systems: '' }), 'dana@x.com');
    expect(R.clearSignoffs).toHaveBeenCalledWith('p1', 'soc2');
  });
  it.each([
    ['an unknown kind', { kind: 'secret', data: {} }, /Unknown kind/],
    ['a missing required field', { kind: 'change', data: { date: '2026-09-01' } }, /Change is required/],
    ['a field that does not exist', { kind: 'change', data: { date: '2026-09-01', change: 'x', extra: 'y' } }, /./],
    ['a walkthrough for a control that does not exist', { kind: 'walkthrough', key: 'CTL-999', data: { participant: 'P', date: '2026-09-01', observed: 'x' } }, /not a control/],
    ['a walkthrough with no control', { kind: 'walkthrough', data: { participant: 'P', date: '2026-09-01', observed: 'x' } }, /Control is required/],
    ['a reviewer who prepared it', { kind: 'walkthrough', key: 'CTL-01', data: { participant: 'P', date: '2026-09-01', observed: 'x', preparer: 'Sam', reviewer: 'Sam' } }, /cannot be the person/],
    ['a gap with no note', { kind: 'cuec', key: 'CUEC-1', data: { status: 'Gap' } }, /gap needs a note/],
    ['a key in the wrong form', { kind: 'cuec', key: '../../x', data: { status: 'Confirmed' } }, /expected form/],
  ])('refuses %s', async (_n, body, msg) => {
    const res = await POST(json('POST', body), ctx());
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(msg);
    expect(R.saveEntry).not.toHaveBeenCalled();
  });
  it('a keyed record saved again is a replacement, and a conclusion is always kept under one key', async () => {
    R.entries.mockResolvedValue([{ id: 'x', kind: 'walkthrough', key: 'CTL-01' }]);
    const res = await POST(json('POST', { kind: 'walkthrough', key: 'CTL-01', data: { participant: 'P', date: '2026-09-01', observed: 'x' } }), ctx());
    expect((await res.json()).data.replaced).toBe(true);
    await POST(json('POST', { kind: 'review_conclusion', key: 'whatever', data: { conclusion: 'ok' } }), ctx());
    expect(R.saveEntry).toHaveBeenLastCalledWith('p1', 'soc2', 'review_conclusion', 'main', expect.anything(), 'dana@x.com');
  });
  it('stops at the cap, but still allows replacing', async () => {
    R.entries.mockResolvedValue(Array.from({ length: 600 }, (_, i) => ({ id: `e${i}`, kind: 'change', key: null })));
    expect((await POST(json('POST', { kind: 'change', data: { date: '2026-09-01', change: 'x' } }), ctx())).status).toBe(400);
  });
  it('is for SOC 2 only', async () => {
    guard.mockResolvedValue(caller({ framework: 'aws-waf' }));
    expect((await POST(json('POST', { kind: 'change', data: { date: '2026-09-01', change: 'x' } }), ctx())).status).toBe(404);
  });
});

describe('changing and removing a record', () => {
  const PUT = entryOne.PUT as H; const DEL = entryOne.DELETE as H;
  it('edits the fields but never the kind or key, and ends the sign-offs', async () => {
    R.entryById.mockResolvedValue({ id: 'e1', kind: 'walkthrough', key: 'CTL-01', framework: 'soc2' });
    const res = await PUT(json('PUT', { kind: 'change', key: 'CTL-02', data: { participant: 'New', date: '2026-09-02', observed: 'seen' } }), ctx({ entryId: 'e1' }));
    expect(res.status).toBe(200);
    expect(R.updateEntry).toHaveBeenCalledWith('p1', 'e1', expect.objectContaining({ participant: 'New' }), 'dana@x.com');
    expect(R.clearSignoffs).toHaveBeenCalled();
  });
  it('cannot reach a record that is not in this project or framework', async () => {
    R.entryById.mockResolvedValue(null);
    expect((await PUT(json('PUT', { data: {} }), ctx({ entryId: 'other' }))).status).toBe(404);
    expect((await DEL(json('DELETE', {}), ctx({ entryId: 'other' }))).status).toBe(404);
    R.entryById.mockResolvedValue({ id: 'e1', kind: 'change', key: null, framework: 'aws-waf' });
    expect((await DEL(json('DELETE', {}), ctx({ entryId: 'e1' }))).status).toBe(404);
    expect(R.deleteEntry).not.toHaveBeenCalled();
  });
  it('removes a record and ends the sign-offs', async () => {
    R.entryById.mockResolvedValue({ id: 'e1', kind: 'change', key: null, framework: 'soc2' });
    expect((await DEL(json('DELETE', {}), ctx({ entryId: 'e1' }))).status).toBe(200);
    expect(R.deleteEntry).toHaveBeenCalledWith('p1', 'e1');
    expect(R.clearSignoffs).toHaveBeenCalled();
  });
});

describe('the engagement settings', () => {
  it('are for owners and admins, refuse a future assessment date, and keep the scope settings', async () => {
    const PUT = engagement.PUT as H;
    guard.mockResolvedValue(caller({ isAdmin: true }));
    expect((await PUT(json('PUT', { cpaFirm: 'Harbor & Pike LLP', scanProvider: 'Pen Tests Ltd', scanFrequency: 'annually', assessmentDate: '2026-10-01' }), ctx())).status).toBe(200);
    expect(guard.mock.calls[0][2]).toMatchObject({ adminOnly: true });
    expect(R.updateSettings).toHaveBeenCalledWith('p1', 'soc2', expect.objectContaining({ cpaFirm: 'Harbor & Pike LLP', assessmentDate: '2026-10-01' }), 'dana@x.com');
    expect((await PUT(json('PUT', { assessmentDate: '2999-01-01' }), ctx())).status).toBe(400);
  });
});
