const mockIdentity = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a) }));
const mockReview = jest.fn();
const mockSecurity = jest.fn();
const mockWa = jest.fn();
jest.mock('@/lib/services/AiReviewService', () => ({
  AiReviewService: { review: (...a: unknown[]) => mockReview(...a), reviewSecurity: (...a: unknown[]) => mockSecurity(...a), reviewWellArchitected: (...a: unknown[]) => mockWa(...a) },
}));

import { NextRequest } from 'next/server';
import { TtlCache } from '@/lib/api/ttlCache';
import { POST } from '@/app/api/ai/review/route';

describe('TtlCache', () => {
  it('returns a value until it expires, then forgets it', () => {
    let now = 1_000;
    const c = new TtlCache<string>(100, 10, () => now);
    c.set('a', 'x');
    expect(c.get('a')).toBe('x');
    now += 99; expect(c.get('a')).toBe('x');
    now += 1; expect(c.get('a')).toBeUndefined();
    expect(c.size).toBe(0);
  });
  it('never grows past its cap: expired entries go first, then the oldest', () => {
    let now = 0;
    const c = new TtlCache<number>(100, 3, () => now);
    c.set('a', 1); now += 10; c.set('b', 2); now += 10; c.set('c', 3);
    c.set('d', 4);                                   // full, nothing expired → the oldest ('a') is dropped
    expect(c.get('a')).toBeUndefined(); expect(c.get('b')).toBe(2); expect(c.get('d')).toBe(4);
    now += 95; c.set('e', 5);                        // a, b, c are expired now → they are cleared before anything fresh is
    expect(c.size).toBeLessThanOrEqual(3);
    expect(c.get('e')).toBe(5);
  });
  it('overwriting refreshes the entry', () => {
    let now = 0;
    const c = new TtlCache<string>(100, 3, () => now);
    c.set('a', 'old'); now += 90; c.set('a', 'new'); now += 90;
    expect(c.get('a')).toBe('new');
  });
});

describe('POST /api/ai/review — repeat reviews come from memory', () => {
  const NODE = { id: 'n1', resourceType: 'aws_s3', provider: 'aws', label: 'Assets', position: { x: 0, y: 0 }, config: {} };
  let u = 0;
  const call = (body: object) => POST(new NextRequest('http://localhost/api/ai/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodes: [NODE], edges: [], ...body }) }));

  beforeEach(() => {
    [mockIdentity, mockReview, mockSecurity, mockWa].forEach((m) => m.mockReset());
    mockIdentity.mockReturnValue({ userId: `review-user-${++u}`, role: 'user', orgIds: [] });   // a fresh user: its own cache and allowance
    mockReview.mockResolvedValue({ summary: 'general' }); mockSecurity.mockResolvedValue({ summary: 'security' }); mockWa.mockResolvedValue({ summary: 'wa' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('the same design, mode and question is answered once by the model and then from memory', async () => {
    const first = await call({ mode: 'security' });
    expect(first.headers.get('X-AI-Review-Cache')).toBeNull();
    const again = await call({ mode: 'security' });
    expect(again.headers.get('X-AI-Review-Cache')).toBe('hit');
    expect((await again.json() as { data: { summary: string } }).data.summary).toBe('security');
    expect(mockSecurity).toHaveBeenCalledTimes(1);
  });

  it('"Review again" (refresh) asks the model afresh', async () => {
    await call({ mode: 'general' });
    await call({ mode: 'general', refresh: true });
    expect(mockReview).toHaveBeenCalledTimes(2);
  });

  it('a different question, mode, design or user is a different review', async () => {
    await call({ mode: 'security' });
    await call({ mode: 'security', question: 'Why is my score low?' });
    await call({ mode: 'well-architected' });
    await call({ mode: 'security', nodes: [{ ...NODE, label: 'Other bucket' }] });
    expect(mockSecurity).toHaveBeenCalledTimes(3);
    expect(mockWa).toHaveBeenCalledTimes(1);
    mockIdentity.mockReturnValue({ userId: 'someone-else', role: 'user', orgIds: [] });
    const res = await call({ mode: 'security' });
    expect(res.headers.get('X-AI-Review-Cache')).toBeNull();            // one user's review is never served to another
    expect(mockSecurity).toHaveBeenCalledTimes(4);
  });

  it('answers from memory without using the AI allowance, so repeats never hit the rate limit', async () => {
    await call({ mode: 'general' });
    for (let i = 0; i < 25; i++) expect((await call({ mode: 'general' })).status).toBe(200);   // the allowance is 10 model calls a minute
    expect(mockReview).toHaveBeenCalledTimes(1);
  });

  it('a failed review is not remembered', async () => {
    mockReview.mockRejectedValueOnce(new Error('model unavailable'));
    expect((await call({ mode: 'general' })).status).toBe(500);
    expect((await call({ mode: 'general' })).status).toBe(200);
    expect(mockReview).toHaveBeenCalledTimes(2);
  });

  it('still requires a signed-in user and a non-empty design', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await call({})).status).toBe(401);
    mockIdentity.mockReturnValue({ userId: 'x', role: 'user', orgIds: [] });
    expect((await call({ nodes: [] })).status).toBe(400);
  });
});
