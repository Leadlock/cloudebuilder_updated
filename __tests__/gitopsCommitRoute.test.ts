const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
const mockResolveArch = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a), resolveArchitecture: (...a: unknown[]) => mockResolveArch(...a) }));
const mockCommit = jest.fn();
jest.mock('@/lib/services/GitOpsService', () => ({ GitOpsService: { commitArchitecture: (...a: unknown[]) => mockCommit(...a) } }));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/architecture/[id]/gitops/commit/route';

const TOKEN = 'ghp_' + 'a'.repeat(36);
const base = {
  projectId: 'proj-1', githubOrg: 'acme-corp', githubRepo: 'infra.repo', branch: 'feature/cloudcraft-1', commitMessage: 'Update',
  createPullRequest: false, githubToken: TOKEN,
  nodes: [{ id: 'n1', resourceType: 'aws_s3', provider: 'aws', label: 'Assets', position: { x: 0, y: 0 }, config: {} }], edges: [],
};
const call = (body: unknown) => POST(new NextRequest('http://localhost/api/architecture/arch-1/gitops/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'arch-1' }) });
let user = 0;

beforeEach(() => {
  [mockIdentity, mockOrgRole, mockResolveOrg, mockResolveArch, mockCommit].forEach((m) => m.mockReset());
  mockIdentity.mockReturnValue({ userId: `gitops-user-${++user}`, role: 'admin', orgIds: [] });   // a fresh user per test: its own rate-limit budget
  mockResolveOrg.mockResolvedValue('org-1'); mockOrgRole.mockResolvedValue('member'); mockResolveArch.mockResolvedValue({ arch: { id: 'arch-1' }, project: {} });
  mockCommit.mockResolvedValue({ success: true, commitSha: 'abc' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GitOps commit route', () => {
  it('commits for a valid request and never logs or stores the token', async () => {
    const res = await call(base);
    expect(res.status).toBe(200);
    const args = mockCommit.mock.calls[0]![0] as { githubOrg: string; files: { path: string }[] };
    expect(args.githubOrg).toBe('acme-corp');
    expect(args.files.map((f) => f.path)).toContain('terraform/main.tf');
  });

  it('requires a signed-in user who belongs to the project\'s organisation', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await call(base)).status).toBe(401);
    mockIdentity.mockReturnValue({ userId: 'u-x', role: 'user', orgIds: [] }); mockOrgRole.mockResolvedValue(null);
    expect((await call(base)).status).toBe(403);
    mockOrgRole.mockResolvedValue('member'); mockResolveArch.mockResolvedValue({ error: 'project_not_found' });
    expect((await call(base)).status).toBe(404);
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it.each([
    ['owner with a slash', { githubOrg: 'acme/../x' }],
    ['owner too long', { githubOrg: 'a'.repeat(40) }],
    ['repo that is ".."', { githubRepo: '..' }],
    ['repo with spaces', { githubRepo: 'my repo' }],
    ['branch with ..', { branch: 'a/../b' }],
    ['branch starting with /', { branch: '/main' }],
    ['branch ending .lock', { branch: 'main.lock' }],
    ['branch with a space', { branch: 'my branch' }],
    ['token with spaces', { githubToken: 'ghp_ ' + 'a'.repeat(30) }],
    ['token too short', { githubToken: 'abc' }],
    ['too many nodes', { nodes: Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, resourceType: 'aws_s3', provider: 'aws', label: 'x', config: {} })) }],
    ['missing nodes', { nodes: undefined }],
  ])('rejects %s without calling GitHub', async (_name, patch) => {
    const res = await call({ ...base, ...patch });
    expect(res.status).toBe(400);
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('accepts a blank commit message by using a default', async () => {
    expect((await call({ ...base, commitMessage: '' })).status).toBe(200);
    expect((mockCommit.mock.calls[0]![0] as { commitMessage: string }).commitMessage).toMatch(/CloudCraft/);
  });

  it('commits escaped Terraform: a crafted label cannot add a provisioner to the repository', async () => {
    const evil = 'x"\n  provisioner "local-exec" {\n    command = "echo PWNED"\n  }\n  tags = { a = "';
    const res = await call({ ...base, nodes: [{ ...base.nodes[0], label: evil, config: { bucketName: evil } }] });
    expect(res.status).toBe(200);
    const files = (mockCommit.mock.calls[0]![0] as { files: { content: string }[] }).files;
    expect(files.some((f) => /^\s*provisioner\s/im.test(f.content))).toBe(false);
  });

  it('does not leak a GitHub error message (it can contain request details)', async () => {
    mockCommit.mockRejectedValue(new Error(`Bad credentials for token ${TOKEN}`));
    const res = await call(base);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
  });

  it('limits commits per user', async () => {
    let last = 200;
    for (let i = 0; i < 11; i++) last = (await call(base)).status;
    expect(last).toBe(429);
  });
});
