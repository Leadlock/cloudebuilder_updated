/**
 * API tests: persisted scans (snapshot integrity + history), finding-review
 * governance, assessment report generation, and tenant isolation.
 */
interface Row { [key: string]: unknown }
type Store = Map<string, Row>;

function makeTable(store: Store) {
  const matches = (filter: Record<string, unknown>) => [...store.values()].filter((row) => Object.entries(filter).every(([k, v]) => row[k] === v));
  return {
    where(filter: Record<string, unknown>) {
      return {
        select(..._f: string[]) { return { async first() { return matches(filter)[0] ?? null; }, async all() { return matches(filter); } }; },
        async first() { return matches(filter)[0] ?? null; },
        async all() { return matches(filter); },
        async update(data: Record<string, unknown>) { for (const r of matches(filter)) Object.assign(r, data); },
        async delete() { for (const r of matches(filter)) store.delete(r['id'] as string); },
      };
    },
    async create(row: Record<string, unknown>) {
      if (store.has(row['id'] as string)) throw new Error(`duplicate primary key ${row['id']}`);
      store.set(row['id'] as string, { ...row });
    },
    select(..._f: string[]) { return { async first() { return [...store.values()][0] ?? null; }, async all() { return [...store.values()]; } }; },
  };
}

const stores: Record<string, Store> = Object.fromEntries(['Organization', 'OrgMember', 'User', 'Project', 'Environment', 'Architecture', 'ArchitectureResource',
  'ArchitectureConnection', 'ArchitectureVersion', 'SecurityScan', 'SecurityFinding', 'FindingReview'].map((k) => [k, new Map()]));
const mockDb = { orm: { public: Object.fromEntries(Object.entries(stores).map(([k, s]) => [k, makeTable(s)])) } };

jest.mock('@/src/prisma/db', () => ({ db: mockDb, rawTransaction: jest.fn(), rawExec: jest.fn() }));

import { NextRequest } from 'next/server';
import { POST as scanPost, GET as scanGet } from '@/app/api/projects/[id]/security-scans/route';
import { POST as reviewPost } from '@/app/api/projects/[id]/finding-reviews/route';
import { DELETE as reviewDelete } from '@/app/api/projects/[id]/finding-reviews/[reviewId]/route';
import { POST as reportPost } from '@/app/api/projects/[id]/assessment-report/route';
import { POST as waReportPost } from '@/app/api/projects/[id]/well-architected-report/route';
import { findingIdFor } from '@/lib/engines/assessment/AssessmentEngine';

const now = '2026-09-24T10:00:00.000Z';
function seed() {
  for (const s of Object.values(stores)) s.clear();
  stores.Organization.set('org-a', { id: 'org-a', name: 'A' });
  stores.Organization.set('org-b', { id: 'org-b', name: 'B' });
  stores.OrgMember.set('m1', { id: 'm1', orgId: 'org-a', userId: 'owner-a', role: 'owner' });
  stores.OrgMember.set('m2', { id: 'm2', orgId: 'org-a', userId: 'member-a', role: 'member' });
  stores.OrgMember.set('m3', { id: 'm3', orgId: 'org-b', userId: 'owner-b', role: 'owner' });
  stores.Project.set('proj-a', { id: 'proj-a', name: 'Ledger Platform', orgId: 'org-a', ownerId: 'owner-a', provider: 'aws', region: 'us-east-1', description: '', tags: '[]', createdAt: now, updatedAt: now });
  stores.Environment.set('env-a', { id: 'env-a', envKey: 'production', label: 'Production', region: 'us-east-1', projectId: 'proj-a', createdAt: now, updatedAt: now });
  stores.Architecture.set('arch-a', { id: 'arch-a', environmentId: 'env-a', createdAt: now, updatedAt: now, revision: 4 });
  const res = (id: string, resourceType: string, label: string, config: Record<string, unknown>) => stores.ArchitectureResource.set(id, {
    id, architectureId: 'arch-a', resourceType, provider: resourceType.startsWith('azure') ? 'azure' : 'aws', label, positionX: 0, positionY: 0, configJson: JSON.stringify(config), region: 'us-east-1', groupId: null, locked: false,
  });
  res('db-1', 'aws_rds', 'production-db', { publiclyAccessible: true, encrypted: true, multiAz: true, backupRetentionPeriod: 7, deletionProtection: true, iamDatabaseAuthenticationEnabled: false });
  res('bucket-1', 'aws_s3', 'app-bucket', { publicAccess: false, encryption: true, versioning: true, loggingEnabled: true, objectOwnership: 'BucketOwnerEnforced' });
  res('fn-1', 'aws_lambda', 'worker', { tracingMode: 'Active', architecture: 'arm64', environmentVariables: { DB_PASSWORD: 'super-secret-value' } });
  // Discovered resource with a secret nested inside the discovery provenance record.
  res('fn-2', 'aws_lambda', 'discovered-worker', { tracingMode: 'PassThrough', importState: 'imported', _discovery: { source: 'aws-api', discoveredAt: '2026-09-24T00:00:00Z', values: { tracingMode: 'PassThrough', environmentVariables: { API_TOKEN: 'nested-discovered-secret' } } }, _metadata: { tags: { password: 'tag-secret-value' } } });
}

const req = (url: string, user: string, body?: unknown, method = 'POST') => new NextRequest(`http://localhost:3000${url}`, {
  method, headers: { 'Content-Type': 'application/json', 'x-user-id': user }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(seed);

describe('Persisted security scans', () => {
  test('stores an immutable, revision-bound snapshot; re-scans do not collide on finding primary keys', async () => {
    const r1 = await scanPost(req('/api/projects/proj-a/security-scans', 'owner-a', {}), params('proj-a'));
    const b1 = await r1.json() as { ok: boolean; data: { scanId: string; architectureRevision: number; graphHash: string; rulesetVersion: string; persisted: boolean; findings: Array<{ ruleId: string }> } };
    expect(b1.ok).toBe(true);
    expect(b1.data.persisted).toBe(true);
    expect(b1.data.architectureRevision).toBe(4);
    expect(b1.data.findings.some((f) => f.ruleId === 'AWS-RDS-001')).toBe(true);
    const findingRowsAfterFirst = stores.SecurityFinding.size;
    expect(findingRowsAfterFirst).toBeGreaterThan(0);

    const r2 = await scanPost(req('/api/projects/proj-a/security-scans', 'owner-a', {}), params('proj-a'));
    expect((await r2.json() as { ok: boolean }).ok).toBe(true);
    expect(stores.SecurityFinding.size).toBe(findingRowsAfterFirst * 2); // previously the 2nd scan's rows silently failed

    const hist = await scanGet(req('/api/projects/proj-a/security-scans', 'owner-a', undefined, 'GET'), params('proj-a'));
    const h = await hist.json() as { data: { scans: Array<{ architectureRevision: number; legacy: boolean }> } };
    expect(h.data.scans).toHaveLength(2);
    expect(h.data.scans.every((s) => s.architectureRevision === 4 && !s.legacy)).toBe(true);
  });

  test('other organizations cannot scan the project', async () => {
    const res = await scanPost(req('/api/projects/proj-a/security-scans', 'owner-b', {}), params('proj-a'));
    expect([403, 404]).toContain(res.status);
  });
});

describe('Finding review governance', () => {
  const fid = findingIdFor('AWS-RDS-001', 'db-1');

  test('ordinary members cannot suppress CRITICAL findings; owners can with reason + expiry; evaluation stays FAIL', async () => {
    const denied = await reviewPost(req('/api/projects/proj-a/finding-reviews', 'member-a', { findingId: fid, status: 'ACCEPTED_RISK', reason: 'Temporary vendor migration window', expiresAt: '2026-12-01T00:00:00.000Z' }), params('proj-a'));
    expect(denied.status).toBe(403);

    const noExpiry = await reviewPost(req('/api/projects/proj-a/finding-reviews', 'owner-a', { findingId: fid, status: 'ACCEPTED_RISK', reason: 'Temporary vendor migration window' }), params('proj-a'));
    expect(noExpiry.status).toBe(400);

    const shortReason = await reviewPost(req('/api/projects/proj-a/finding-reviews', 'owner-a', { findingId: fid, status: 'FALSE_POSITIVE', reason: 'nope' }), params('proj-a'));
    expect(shortReason.status).toBe(400);

    const tooLong = await reviewPost(req('/api/projects/proj-a/finding-reviews', 'owner-a', { findingId: fid, status: 'ACCEPTED_RISK', reason: 'Temporary vendor migration window', expiresAt: '2030-01-01T00:00:00.000Z' }), params('proj-a'));
    expect(tooLong.status).toBe(400);

    const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
    const ok = await reviewPost(req('/api/projects/proj-a/finding-reviews', 'owner-a', { findingId: fid, status: 'ACCEPTED_RISK', reason: 'Temporary vendor migration window', expiresAt }), params('proj-a'));
    expect(ok.status).toBe(201);
    const created = await ok.json() as { data: { review: { id: string; approvedBy: string } } };
    expect(created.data.review.approvedBy).toBe('owner-a');

    const scan = await scanPost(req('/api/projects/proj-a/security-scans', 'owner-a', {}), params('proj-a'));
    const body = await scan.json() as { data: { assessment: { findings: Array<{ findingId: string; status: string; reviewStatus: string }> } } };
    const f = body.data.assessment.findings.find((x) => x.findingId === fid)!;
    expect(f.status).toBe('FAIL');
    expect(f.reviewStatus).toBe('ACCEPTED_RISK');

    // Revocation is kept for audit history.
    const del = await reviewDelete(req(`/api/projects/proj-a/finding-reviews/${created.data.review.id}`, 'owner-a', undefined, 'DELETE'), { params: Promise.resolve({ id: 'proj-a', reviewId: created.data.review.id }) });
    expect(del.status).toBe(200);
    expect(stores.FindingReview.get(created.data.review.id)?.['revokedAt']).toBeTruthy();
  });

  test('reviews can only target findings that exist in the saved architecture', async () => {
    const res = await reviewPost(req('/api/projects/proj-a/finding-reviews', 'owner-a', { findingId: 'AWS-RDS-002-FFFFFF', status: 'FALSE_POSITIVE', reason: 'This finding does not exist at all' }), params('proj-a'));
    expect(res.status).toBe(404);
  });

  test('members may review MEDIUM/LOW findings', async () => {
    const res = await reviewPost(req('/api/projects/proj-a/finding-reviews', 'member-a', { findingId: findingIdFor('AWS-RDS-003', 'db-1'), status: 'NOT_APPLICABLE', reason: 'Secrets Manager rotation is used instead' }), params('proj-a'));
    expect(res.status).toBe(201);
  });
});

describe('Assessment report API', () => {
  test('PDF is generated from structured data; JSON carries revision; secrets are redacted', async () => {
    const pdf = await reportPost(req('/api/projects/proj-a/assessment-report', 'owner-a', { format: 'pdf' }), params('proj-a'));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
    const buf = Buffer.from(await pdf.arrayBuffer());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');

    const json = await reportPost(req('/api/projects/proj-a/assessment-report', 'owner-a', { format: 'json' }), params('proj-a'));
    const body = await json.json() as { data: { report: { meta: { architectureRevision: number; projectName: string } }; scanId: string } };
    expect(body.data.report.meta.architectureRevision).toBe(4);
    expect(body.data.report.meta.projectName).toBe('Ledger Platform');
    expect(JSON.stringify(body)).not.toContain('super-secret-value');
    expect(JSON.stringify(body)).not.toContain('nested-discovered-secret');
    expect(JSON.stringify(body)).not.toContain('tag-secret-value');
  }, 30_000);

  test('re-rendering an old snapshot is unaffected by later architecture changes; comparison shows resolution', async () => {
    const first = await reportPost(req('/api/projects/proj-a/assessment-report', 'owner-a', { format: 'json' }), params('proj-a'));
    const firstBody = await first.json() as { data: { scanId: string; report: { security: { findings: Array<{ findingId: string }> } } } };
    const fid = findingIdFor('AWS-RDS-001', 'db-1');
    expect(firstBody.data.report.security.findings.some((f) => f.findingId === fid)).toBe(true);

    // Fix the architecture (as Auto-Fix + save would) and bump the revision.
    const row = stores.ArchitectureResource.get('db-1')!;
    row['configJson'] = JSON.stringify({ ...JSON.parse(row['configJson'] as string), publiclyAccessible: false });
    stores.Architecture.get('arch-a')!['revision'] = 5;

    const again = await reportPost(req('/api/projects/proj-a/assessment-report', 'owner-a', { format: 'json', scanId: firstBody.data.scanId }), params('proj-a'));
    const againBody = await again.json() as { data: { report: { meta: { architectureRevision: number }; security: { findings: Array<{ findingId: string }> } } } };
    expect(againBody.data.report.meta.architectureRevision).toBe(4);
    expect(againBody.data.report.security.findings.some((f) => f.findingId === fid)).toBe(true);

    const fresh = await reportPost(req('/api/projects/proj-a/assessment-report', 'owner-a', { format: 'json' }), params('proj-a'));
    const freshBody = await fresh.json() as { data: { report: { meta: { architectureRevision: number }; comparison?: { resolvedFindings: Array<{ findingId: string }> } } } };
    expect(freshBody.data.report.meta.architectureRevision).toBe(5);
    expect(freshBody.data.report.comparison?.resolvedFindings.map((f) => f.findingId)).toContain(fid);

    // A re-scan of the identical graph is not a meaningful baseline: the comparison
    // must still be against the last genuinely different state (revision 4).
    await new Promise((r) => setTimeout(r, 5));
    const rescan = await reportPost(req('/api/projects/proj-a/assessment-report', 'owner-a', { format: 'json' }), params('proj-a'));
    const rescanBody = await rescan.json() as { data: { report: { comparison?: { previousRevision: number; resolvedFindings: Array<{ findingId: string }> } } } };
    expect(rescanBody.data.report.comparison?.previousRevision).toBe(4);
    expect(rescanBody.data.report.comparison?.resolvedFindings.map((f) => f.findingId)).toContain(fid);
  }, 30_000);

  test('tenant isolation: another org cannot render this project\'s snapshot', async () => {
    const first = await reportPost(req('/api/projects/proj-a/assessment-report', 'owner-a', { format: 'json' }), params('proj-a'));
    const scanId = (await first.json() as { data: { scanId: string } }).data.scanId;
    const res = await reportPost(req('/api/projects/proj-a/assessment-report', 'owner-b', { format: 'json', scanId }), params('proj-a'));
    expect([403, 404]).toContain(res.status);
  });

  test('unknown snapshot IDs return 404', async () => {
    const res = await reportPost(req('/api/projects/proj-a/assessment-report', 'owner-a', { format: 'json', scanId: '7a1c0e55-0000-4000-8000-000000000000' }), params('proj-a'));
    expect(res.status).toBe(404);
  });
});

describe('Well-Architected report API', () => {
  const url = '/api/projects/proj-a/well-architected-report';

  test('PDF and HTML are produced from the same snapshot, pillar by pillar, and are not the security report', async () => {
    const pdf = await waReportPost(req(url, 'owner-a', { format: 'pdf' }), params('proj-a'));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('Content-Disposition')).toContain('cloudbuilder-well-architected-');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');

    const html = await waReportPost(req(url, 'owner-a', { format: 'html' }), params('proj-a'));
    const text = await html.text();
    expect(text).toContain('Well-Architected Review');
    expect(text).toContain('Pillar Reviews');
    expect(text).toContain('Improvement Roadmap');
    expect(text).not.toContain('SOC 1 Readiness Analysis');           // that belongs to the security report
    expect(text).not.toContain('AI-generated commentary');           // none supplied
    expect(text).not.toContain('super-secret-value');
  }, 30_000);

  test('AI commentary is validated: made-up rules and pillars are dropped, pillar text for thin pillars is fixed', async () => {
    const json = await waReportPost(req(url, 'owner-a', { format: 'json' }), params('proj-a'));
    const body = await json.json() as { data: { report: { waPillars: { key: string; evaluable: boolean; findingIds: string[] }[] }; scanId: string } };
    const pillars = body.data.report.waPillars;
    expect(pillars.length).toBeGreaterThan(0);
    const withFindings = pillars.find((p) => p.evaluable && p.findingIds.length > 0)!;
    const thin = pillars.find((p) => !p.evaluable);

    const res = await waReportPost(req(url, 'owner-a', {
      format: 'html',
      aiCommentary: {
        summary: 'Overall <b>fine</b>.',
        pillars: [
          { pillar: withFindings.key, assessment: 'Pillar commentary here.', topFixes: [{ ruleId: 'AWS-MADE-UP-999', fix: 'invented fix' }] },
          { pillar: 'aws:not_a_pillar', assessment: 'invented pillar', topFixes: [] },
          ...(thin ? [{ pillar: thin.key, assessment: 'This pillar is excellent!', topFixes: [] }] : []),
        ],
        plan: [{ ruleId: 'AWS-MADE-UP-999', action: 'invented action' }],
        suggestions: ['Enable GuardDuty'],
      },
    }), params('proj-a'));
    const text = await res.text();
    expect(text).toContain('AI-generated commentary');
    expect(text).toContain('Pillar commentary here.');
    expect(text).toContain('Unverified AI suggestions');
    expect(text).not.toContain('invented');
    expect(text).not.toContain('<b>fine</b>');                       // escaped
    if (thin) { expect(text).not.toContain('This pillar is excellent!'); expect(text).toContain('Insufficient evidence'); expect(text).toContain('Too few checks could be evaluated'); }
  }, 30_000);

  test('same access rules as the assessment report', async () => {
    expect((await waReportPost(req(url, 'owner-b', { format: 'json' }), params('proj-a'))).status).toBeGreaterThanOrEqual(403);
    const unknown = await waReportPost(req(url, 'owner-a', { format: 'json', scanId: '7a1c0e55-0000-4000-8000-000000000000' }), params('proj-a'));
    expect(unknown.status).toBe(404);
  });
});
