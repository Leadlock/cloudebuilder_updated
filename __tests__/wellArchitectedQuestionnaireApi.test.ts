/**
 * Questionnaire storage and API: who may read and write answers, what is validated, that one project never sees another's
 * answers, and that a saved review goes stale when the answers change after it.
 */
import { NextRequest } from 'next/server';

type Row = Record<string, unknown>;
const answerRows: Row[] = [];

jest.mock('@/src/prisma/db', () => {
  const matches = (r: Row, w: Row) => Object.entries(w).every(([k, v]) => r[k] === v);
  return {
    db: {
      orm: {
        public: {
          WellArchitectedAnswer: {
            where: (w: Row) => ({
              all: async () => answerRows.filter((r) => matches(r, w)),
              first: async () => answerRows.find((r) => matches(r, w)) ?? null,
              update: async (patch: Row) => { for (const r of answerRows) if (matches(r, w)) Object.assign(r, patch); },
              delete: async () => { for (let i = answerRows.length - 1; i >= 0; i--) if (matches(answerRows[i]!, w)) answerRows.splice(i, 1); },
            }),
            create: async (r: Row) => { answerRows.push({ ...r }); return r; },
          },
        },
      },
    },
  };
});

const auth = { identity: { userId: 'usr-1' } as { userId: string } | null, role: 'member' as string | null };
jest.mock('@/lib/api/auth', () => ({
  extractIdentity: () => auth.identity,
  getOrgRole: async () => auth.role,
}));

const projectsInOrg = new Set(['proj-a', 'proj-b']);
jest.mock('@/lib/repositories/projectRepository', () => ({
  projectRepository: { findById: async (id: string) => (projectsInOrg.has(id) ? { id, name: id } : null) },
}));

const architecture = { arch: { id: 'arch-1', resources: [] as unknown[], connections: [] as unknown[] }, project: { id: 'proj-a', name: 'A' } };
jest.mock('@/lib/api/phase2d', () => ({
  resolveOrgId: async () => 'org-1',
  resolveArchitecture: async () => architecture,
}));
jest.mock('@/lib/api/rateLimit', () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  RATE_LIMITS: { ANALYSIS: { limit: 30, windowMs: 60_000 }, AI_GENERATE: { limit: 10, windowMs: 60_000 } },
}));

let latestReview: Record<string, unknown> | null = null;
jest.mock('@/lib/repositories/wellArchitectedRepository', () => ({
  wellArchitectedRepository: { findLatestByArchitecture: async () => latestReview },
}));

import { GET as getQuestions, PUT as putQuestions } from '@/app/api/projects/[id]/well-architected/questions/route';
import { GET as getAssessment } from '@/app/api/projects/[id]/well-architected/route';
import { wellArchitectedAnswerRepository as repo } from '@/lib/repositories/wellArchitectedAnswerRepository';
import { loadQuestionnaire } from '@/lib/api/waQuestionnaire';
import { QUESTIONS } from '@/lib/engines/assessment/questionnaire/questions';

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (path = '/api/projects/proj-a/well-architected/questions') => new NextRequest(`http://localhost:3000${path}`);
const put = (body: unknown) => new NextRequest('http://localhost:3000/api/projects/proj-a/well-architected/questions', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const json = async (res: Response | undefined) => { return jsonOf(res!); };
const jsonOf = async (res: Response) => (await res.json()) as { ok: boolean; data?: any; error?: { code: string; message: string } };

beforeEach(() => {
  answerRows.length = 0;
  auth.identity = { userId: 'usr-1' };
  auth.role = 'member';
  latestReview = null;
});

describe('answer repository', () => {
  test('creates, updates and clears an answer', async () => {
    await repo.apply('proj-a', [{ questionId: 'REL-01', answer: 'no', note: 'Planned for Q1' }], 'usr-1');
    expect(await repo.answersFor('proj-a')).toEqual({ 'REL-01': { answer: 'no', note: 'Planned for Q1' } });

    await repo.apply('proj-a', [{ questionId: 'REL-01', answer: 'partial' }], 'usr-2');
    const row = (await repo.list('proj-a'))[0]!;
    expect([row.answer, row.note, row.answeredBy]).toEqual(['partial', 'Planned for Q1', 'usr-2']); // the note is kept when only the answer changes

    await repo.apply('proj-a', [{ questionId: 'REL-01', answer: null }], 'usr-1');
    expect(await repo.list('proj-a')).toEqual([]);
  });

  test('there is one row per project and question, however often it is answered', async () => {
    for (const a of ['yes', 'no', 'partial'] as const) await repo.apply('proj-a', [{ questionId: 'OPS-01', answer: a }], 'usr-1');
    expect(answerRows.filter((r) => r['projectId'] === 'proj-a' && r['questionId'] === 'OPS-01')).toHaveLength(1);
  });

  test('a project never sees another project\'s answers', async () => {
    await repo.apply('proj-a', [{ questionId: 'OPS-01', answer: 'yes' }], 'usr-1');
    await repo.apply('proj-b', [{ questionId: 'OPS-01', answer: 'no' }], 'usr-1');
    expect((await repo.answersFor('proj-a'))['OPS-01']!.answer).toBe('yes');
    expect((await repo.answersFor('proj-b'))['OPS-01']!.answer).toBe('no');
    await repo.apply('proj-a', [{ questionId: 'OPS-01', answer: null }], 'usr-1');
    expect((await repo.answersFor('proj-b'))['OPS-01']!.answer).toBe('no'); // clearing in A leaves B alone
  });

  test('lastChangedAt is null with no answers and the newest change otherwise', async () => {
    expect(await repo.lastChangedAt('proj-a')).toBeNull();
    await repo.apply('proj-a', [{ questionId: 'OPS-01', answer: 'yes' }], 'u');
    const first = (await repo.lastChangedAt('proj-a'))!;
    expect(new Date(first).toString()).not.toBe('Invalid Date');
  });

  test('loadQuestionnaire gives nothing until something is answered, then the answers', async () => {
    expect(await loadQuestionnaire('proj-a')).toBeUndefined();
    await repo.apply('proj-a', [{ questionId: 'SEC-01', answer: 'yes', note: 'SSO via Okta' }], 'u');
    expect(await loadQuestionnaire('proj-a')).toEqual({ answers: { 'SEC-01': { answer: 'yes', note: 'SSO via Okta' } } });
  });
});

describe('GET /well-architected/questions', () => {
  test('401 without a sign-in, 403 without a role in the org, 404 for a project outside it', async () => {
    auth.identity = null;
    expect((await getQuestions(get(), params('proj-a')))!.status).toBe(401);
    auth.identity = { userId: 'usr-1' }; auth.role = null;
    expect((await getQuestions(get(), params('proj-a')))!.status).toBe(403);
    auth.role = 'member';
    expect((await getQuestions(get(), params('other-org-project')))!.status).toBe(404);
  });

  test('returns the whole catalog and this project\'s answers; read-only roles may read', async () => {
    auth.role = 'viewer';
    await repo.apply('proj-a', [{ questionId: 'REL-01', answer: 'no', note: 'n' }], 'u');
    const res = await getQuestions(get(), params('proj-a'));
    expect(res!.status).toBe(200);
    const body = await json(res);
    expect(body.data.questions).toHaveLength(QUESTIONS.length);
    expect(body.data.questions[0]).toEqual(expect.objectContaining({ id: expect.any(String), pillarLabel: expect.any(String), question: expect.any(String), why: expect.any(String), providers: expect.any(Array) }));
    expect(body.data.answers['REL-01']).toEqual(expect.objectContaining({ answer: 'no', note: 'n' }));
    expect(body.data.answers['OPS-01']).toBeUndefined();
  });

  test('never returns answers of another project', async () => {
    await repo.apply('proj-b', [{ questionId: 'REL-01', answer: 'yes' }], 'u');
    const body = await json(await getQuestions(get(), params('proj-a')));
    expect(body.data.answers).toEqual({});
  });
});

describe('PUT /well-architected/questions', () => {
  test('401 without a sign-in; read-only roles may not write; a project outside the org is 404', async () => {
    auth.identity = null;
    expect((await putQuestions(put({ answers: [{ questionId: 'REL-01', answer: 'yes' }] }), params('proj-a')))!.status).toBe(401);
    auth.identity = { userId: 'usr-1' }; auth.role = 'viewer';
    expect((await putQuestions(put({ answers: [{ questionId: 'REL-01', answer: 'yes' }] }), params('proj-a')))!.status).toBe(403);
    expect(answerRows).toHaveLength(0);
    auth.role = 'member';
    expect((await putQuestions(put({ answers: [{ questionId: 'REL-01', answer: 'yes' }] }), params('other-org-project')))!.status).toBe(404);
  });

  test.each(['owner', 'admin', 'member'])('the %s role can save answers, recorded against the signed-in user', async (role) => {
    auth.role = role;
    const res = await putQuestions(put({ answers: [{ questionId: 'REL-01', answer: 'no', note: '  restore test planned  ' }] }), params('proj-a'));
    expect(res!.status).toBe(200);
    const body = await json(res);
    expect(body.data.answers['REL-01']).toEqual(expect.objectContaining({ answer: 'no', note: 'restore test planned' }));
    expect((answerRows[0] as Row)['answeredBy']).toBe('usr-1');
    expect((answerRows[0] as Row)['projectId']).toBe('proj-a');
  });

  test('an answer can be cleared with null', async () => {
    await putQuestions(put({ answers: [{ questionId: 'REL-01', answer: 'no' }] }), params('proj-a'));
    const res = await putQuestions(put({ answers: [{ questionId: 'REL-01', answer: null }] }), params('proj-a'));
    expect((await json(res)).data.answers['REL-01']).toBeUndefined();
    expect(answerRows).toHaveLength(0);
  });

  test('a question that is not in the catalog is refused and nothing is saved, even beside valid ones', async () => {
    const res = await putQuestions(put({ answers: [{ questionId: 'REL-01', answer: 'yes' }, { questionId: 'NOPE-99', answer: 'yes' }] }), params('proj-a'));
    expect(res!.status).toBe(400);
    expect((await json(res)).error?.message).toContain('NOPE-99');
    expect(answerRows).toHaveLength(0);
  });

  test.each([
    ['an answer value that does not exist', { answers: [{ questionId: 'REL-01', answer: 'maybe' }] }],
    ['a note over 500 characters', { answers: [{ questionId: 'REL-01', answer: 'yes', note: 'x'.repeat(501) }] }],
    ['no answers', { answers: [] }],
    ['a body that is not the expected shape', { foo: 1 }],
  ])('400 for %s', async (_n, body) => {
    expect((await putQuestions(put(body), params('proj-a')))!.status).toBe(400);
    expect(answerRows).toHaveLength(0);
  });

  test('the answer goes to the project in the URL, whatever the body says', async () => {
    await putQuestions(put({ answers: [{ questionId: 'REL-01', answer: 'yes' }], projectId: 'proj-b' }), params('proj-a'));
    expect(answerRows.map((r) => r['projectId'])).toEqual(['proj-a']);
  });
});

describe('a saved review goes stale when the answers change after it', () => {
  const review = (evaluatedAt: string, extra: Record<string, unknown> = {}) => ({ architectureId: 'arch-1', evaluatedAt, isStale: false, overallScore: 90, ...extra });
  const call = async () => json(await getAssessment(get('/api/projects/proj-a/well-architected'), params('proj-a')));

  test('answers changed after the review: stale, reason "answers"', async () => {
    latestReview = review('2020-01-01T00:00:00.000Z');
    await repo.apply('proj-a', [{ questionId: 'REL-01', answer: 'no' }], 'u');
    const a = (await call()).data.assessment;
    expect(a.isStale).toBe(true);
    expect(a.staleReason).toBe('answers');
  });

  test('answers changed before the review: not stale', async () => {
    await repo.apply('proj-a', [{ questionId: 'REL-01', answer: 'no' }], 'u');
    latestReview = review('2999-01-01T00:00:00.000Z');
    expect((await call()).data.assessment.isStale).toBe(false);
  });

  test('no answers at all: not stale', async () => {
    latestReview = review('2020-01-01T00:00:00.000Z');
    expect((await call()).data.assessment.isStale).toBe(false);
  });

  test('a review that is already stale keeps its own reason', async () => {
    latestReview = review('2020-01-01T00:00:00.000Z', { isStale: true, staleReason: 'ruleset' });
    await repo.apply('proj-a', [{ questionId: 'REL-01', answer: 'no' }], 'u');
    expect((await call()).data.assessment.staleReason).toBe('ruleset');
  });

  test('no review yet: nothing to mark', async () => {
    latestReview = null;
    await repo.apply('proj-a', [{ questionId: 'REL-01', answer: 'no' }], 'u');
    expect((await call()).data.assessment).toBeNull();
  });
});
