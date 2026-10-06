/**
 * An approval must survive a restart of the server: before, reviews lived only in memory, so every restart said "approval required"
 * again. "Restart" here is a fresh load of the module with the in-memory copy cleared.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const env = process.env as Record<string, string | undefined>;
const g = globalThis as unknown as { __cloudcraft_reviews?: unknown; __cloudcraft_deployments?: unknown };
const user = { id: 'u1', name: 'Admin', email: 'a@x.io' };
const summary = { nodeCount: 1, edgeCount: 0, criticalIssuesCount: 0, estimatedMonthlyCost: 0 };
const nodes = [{ id: 'n1', resourceType: 'aws_vpc', provider: 'aws', label: 'v', config: {}, groupId: null, position: { x: 0, y: 0 } }] as never;

let file = '';
function startServer() {
  jest.resetModules();
  delete g.__cloudcraft_reviews; delete g.__cloudcraft_deployments;       // a new process has nothing in memory
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('@/lib/services/ArchitectureReviewService') as typeof import('@/lib/services/ArchitectureReviewService')).ArchitectureReviewService;
}

beforeEach(() => { file = join(mkdtempSync(join(tmpdir(), 'cc-reviews-')), 'sub', 'reviews.json'); env['CLOUDCRAFT_REVIEWS_FILE'] = file; });
afterAll(() => { delete env['CLOUDCRAFT_REVIEWS_FILE']; delete g.__cloudcraft_reviews; delete g.__cloudcraft_deployments; });

describe('reviews survive a restart', () => {
  it('an approved review is still approved after the server starts again', () => {
    const before = startServer();
    const r = before.submitReview('p1', 'production', nodes, [], user, summary);
    before.approveReview(r.id, user, 'ok');

    const after = startServer();
    const latest = after.getLatestReview('p1', 'production');
    expect(latest?.status).toBe('approved');
    expect(latest?.id).toBe(r.id);
    expect(latest?.architectureHash).toBe(before.computeArchitectureHash(nodes, []));
  });

  it('keeps rejections, change requests and invalidation too', () => {
    const s = startServer();
    const a = s.submitReview('p1', 'production', nodes, [], user, summary); s.rejectReview(a.id, user, 'no');
    const b = s.submitReview('p2', 'production', nodes, [], user, summary); s.requestChanges(b.id, user, 'fix');
    const c = s.submitReview('p3', 'production', nodes, [], user, summary); s.approveReview(c.id, user);
    s.checkAndInvalidateOnSave('p3', 'production', [{ ...(nodes as never[])[0] as object, config: { cidrBlock: '10.0.0.0/16' } }] as never, []);

    const t = startServer();
    expect(t.getLatestReview('p1')?.status).toBe('rejected');
    expect(t.getLatestReview('p2')?.status).toBe('changes_requested');
    expect(t.getLatestReview('p3')?.status).toBe('invalidated_due_to_changes');
    expect(t.getLatestReview('p3')?.invalidationReason).toMatch(/modified after approval/);
  });

  it('writes nothing secret, and replaces the file in one step (no leftover temp files)', () => {
    const s = startServer();
    s.approveReview(s.submitReview('p1', 'production', nodes, [], user, summary).id, user);
    const text = readFileSync(file, 'utf-8');
    expect(JSON.parse(text).reviews).toHaveLength(1);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it('starts empty, not broken, when the file is damaged', () => {
    startServer().submitReview('p1', 'production', nodes, [], user, summary);
    writeFileSync(file, '{ not json');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = startServer();
    expect(s.listReviews('p1')).toEqual([]);
    const r = s.submitReview('p1', 'production', nodes, [], user, summary);      // and it can write again
    expect(startServer().getLatestReview('p1')?.id).toBe(r.id);
  });

  it('writes nothing under tests unless a file is chosen', () => {
    delete env['CLOUDCRAFT_REVIEWS_FILE'];
    const s = startServer();
    s.submitReview('p1', 'production', nodes, [], user, summary);
    expect(existsSync(join(process.cwd(), '.cloudcraft-data', 'reviews.json'))).toBe(false);
  });
});
