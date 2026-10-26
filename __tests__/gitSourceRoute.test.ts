/** POST /api/projects/{id}/releases/sources/git: the gate, the validation, what is stored, what is audited, and that the token goes nowhere. */
import { NextRequest } from 'next/server';
import { buildSourceZip } from '@/lib/deploy/project/zipWriter';
import { GitSourceError } from '@/lib/deploy/project/gitSource';

const gate = jest.fn();
const audit = jest.fn();
const put = jest.fn();
const fetchGit = jest.fn();
jest.mock('@/lib/deploy/project/routeGate', () => ({ releaseGate: (...a: unknown[]) => gate(...a) }));
jest.mock('@/lib/terraform/execution/audit', () => ({ recordTerraformAudit: (...a: unknown[]) => audit(...a) }));
jest.mock('@/lib/api/rateLimit', () => ({ checkRateLimit: async () => ({ allowed: true }), RATE_LIMITS: {} }));
jest.mock('@/lib/deploy/project/sourceStore', () => ({
  SOURCE_TTL_MS: 1000,
  PgSourceStore: class { async prune() { return undefined; } async put(s: { id: string; zip: Buffer }) { put(s); return { ...s, sha256: 'a'.repeat(64), sizeBytes: s.zip.length, expiresAtMs: 0 }; } },
}));
jest.mock('@/lib/deploy/project/gitSource', () => {
  const real = jest.requireActual('@/lib/deploy/project/gitSource');
  return { ...real, fetchGitSource: (...a: unknown[]) => fetchGit(...a), gitPolicyFromEnv: () => ({ allowedHosts: ['github.com'] }) };
});

import { POST } from '@/app/api/projects/[id]/releases/sources/git/route';

const call = (body: unknown) => POST(new NextRequest('http://x/api/projects/p1/releases/sources/git', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id: 'p1' }) });
const zip = buildSourceZip([{ path: 'package.json', content: '{}' }, { path: 'Dockerfile', content: 'FROM scratch' }]);

beforeEach(() => {
  gate.mockReset().mockResolvedValue({ ok: true, identity: { userId: 'u1' }, orgId: 'o1', projectId: 'p1' });
  audit.mockReset(); put.mockReset();
  fetchGit.mockReset().mockResolvedValue({ zip, commit: 'c'.repeat(40), files: 2, ref: 'main', subdir: '', host: 'github.com', repo: 'acme/shop' });
});

it('stores what was fetched and answers like an upload does, plus the commit', async () => {
  const res = await call({ layer: 'api', url: 'https://github.com/acme/shop', ref: 'main', token: 'ghp_SECRET' });
  expect(res.status).toBe(201);
  const d = (await res.json()).data;
  expect(d).toMatchObject({ layer: 'api', files: 2, sha256: 'a'.repeat(64), git: { host: 'github.com', repo: 'acme/shop', commit: 'c'.repeat(40) } });
  expect(d.replaced).toContain('Dockerfile');                      // a Dockerfile from the repository is not used, as for an upload
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'o1', projectId: 'p1', layer: 'api' }));
  expect(fetchGit).toHaveBeenCalledWith({ url: 'https://github.com/acme/shop', ref: 'main', subdir: undefined, token: 'ghp_SECRET' }, { allowedHosts: ['github.com'] });
});

it('never puts the token in the answer or the audit trail, and says only that one was used', async () => {
  const res = await call({ layer: 'api', url: 'https://github.com/acme/shop', token: 'ghp_SECRET' });
  expect(JSON.stringify(await res.json())).not.toContain('ghp_SECRET');
  expect(JSON.stringify(audit.mock.calls)).not.toContain('ghp_SECRET');
  expect(JSON.stringify(audit.mock.calls)).toContain('with a token');
});

it('answers 400 with the reason, audits the refusal, and stores nothing, when the repository is refused', async () => {
  fetchGit.mockRejectedValueOnce(new GitSourceError('Code can be taken from github.com. Ask an administrator to allow evil.example.'));
  const res = await call({ layer: 'api', url: 'https://evil.example/a/b', token: 'ghp_SECRET' });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toContain('Ask an administrator');
  expect(put).not.toHaveBeenCalled();
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked' }));
  expect(JSON.stringify(audit.mock.calls)).not.toContain('ghp_SECRET');
});

it('does not leak an unexpected error from git: 400 with a plain message', async () => {
  fetchGit.mockRejectedValueOnce(new Error('spawn git ENOENT /usr/local/secret/path'));
  const res = await call({ layer: 'api', url: 'https://github.com/acme/shop' });
  expect(res.status).toBe(400);
  expect(JSON.stringify(await res.json())).not.toContain('/usr/local/secret/path');
});

it('refuses a layer that is not a service, and a body without an address, before anything is fetched', async () => {
  expect((await call({ layer: 'database', url: 'https://github.com/a/b' })).status).toBe(400);
  expect((await call({ layer: 'api' })).status).toBe(400);
  expect((await call({ layer: 'api', url: 'x'.repeat(501) })).status).toBe(400);
  expect(fetchGit).not.toHaveBeenCalled();
});

it('returns the gate\'s answer when the caller may not deploy', async () => {
  gate.mockResolvedValueOnce({ ok: false, response: new Response(JSON.stringify({ ok: false }), { status: 403 }) });
  expect((await call({ layer: 'api', url: 'https://github.com/a/b' })).status).toBe(403);
  expect(fetchGit).not.toHaveBeenCalled();
});
