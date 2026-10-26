/**
 * Code from a Git repository: what is refused before git runs, that git runs safely, and that a real repository becomes the same safe zip an upload is.
 * The "remote" in the real-git tests is a local repository (file://), allowed only through the test-only policy flag.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkRequest, fetchGitSource, gitPolicyFromEnv, isPrivateAddress, DEFAULT_GIT_HOSTS, GitSourceError, type GitPolicy, type GitRunner } from '@/lib/deploy/project/gitSource';
import { readZip } from '@/lib/deploy/project/zip';

const policy: GitPolicy = { allowedHosts: DEFAULT_GIT_HOSTS };
const bad = (r: Parameters<typeof checkRequest>[0], p: GitPolicy = policy) => { try { checkRequest(r, p); } catch (e) { return (e as Error).message; } return null; };

describe('what is refused before git runs', () => {
  it('accepts an ordinary repository address', () => {
    expect(bad({ url: 'https://github.com/acme/shop' })).toBeNull();
    expect(bad({ url: 'https://github.com/acme/shop.git/', ref: 'release/1.2', subdir: 'services/api' })).toBeNull();
    expect(bad({ url: 'https://gitlab.com/group/sub/project', ref: 'a'.repeat(40) })).toBeNull();
  });
  it.each([
    ['http://github.com/a/b', /https/],
    ['git@github.com:a/b.git', /not a valid URL/],
    ['ssh://github.com/a/b', /https/],
    ['file:///etc', /https/],
    ['https://user:pw@github.com/a/b', /user name or password/],
    ['https://github.com:8443/a/b', /port/],
    ['https://evil.example/a/b', /Code can be taken from/],
    ['https://github.com.evil.example/a/b', /Code can be taken from/],
    ['https://github.com/a/b?x=1', /query/],
    ['https://169.254.169.254/latest', /Code can be taken from/],
    ['https://localhost/a/b', /Code can be taken from/],
  ])('refuses %s', (url, why) => { expect(bad({ url })).toMatch(why); });
  it('refuses a ref or folder that could be read as an option or leave the repository', () => {
    for (const ref of ['--upload-pack=x', '-b', 'a..b', 'a b', 'x;rm', 'a//b', 'ref.lock']) expect(bad({ url: 'https://github.com/a/b', ref })).toMatch(/branch, tag or commit/);
    for (const subdir of ['../x', 'a/../b', '.git', 'a b', 'a;b', '/etc/passwd/..']) expect(bad({ url: 'https://github.com/a/b', subdir })).toMatch(/relative path/);
    expect(bad({ url: 'https://github.com/a/b', token: 'abc def' })).toMatch(/token/);
  });
  it('allows only the hosts the operator lists', () => {
    expect(gitPolicyFromEnv({} as never).allowedHosts).toEqual(DEFAULT_GIT_HOSTS);
    expect(gitPolicyFromEnv({ CLOUDBUILDER_GIT_ALLOWED_HOSTS: 'Git.Corp.Example, github.com' } as never).allowedHosts).toEqual(['git.corp.example', 'github.com']);
    expect(bad({ url: 'https://git.corp.example/a/b' }, { allowedHosts: ['git.corp.example'] })).toBeNull();
  });
  it('treats private and loopback addresses as private', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.5', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['140.82.112.3', '172.32.0.1', '8.8.8.8', '2606:4700::1']) expect(isPrivateAddress(ip)).toBe(false);
  });
  it('refuses a host that resolves to a private address, and one that cannot be found', async () => {
    await expect(fetchGitSource({ url: 'https://github.com/a/b' }, policy, { resolve: async () => ['140.82.112.3', '10.0.0.5'] })).rejects.toThrow(/public address/);
    await expect(fetchGitSource({ url: 'https://github.com/a/b' }, policy, { resolve: async () => { throw new Error('ENOTFOUND'); } })).rejects.toThrow(/could not be found/);
  });
});

describe('how git is run', () => {
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const fake = (failFetch?: string): GitRunner => async (args, opts) => {
    calls.push({ args, env: opts.env });
    if (args.includes('fetch') && failFetch) return { code: 128, stdout: '', stderr: failFetch, timedOut: false };
    return { code: 0, stdout: args.includes('rev-parse') ? 'a'.repeat(40) : '', stderr: '', timedOut: false };
  };
  beforeEach(() => { calls.length = 0; });

  it('keeps the token out of every argument and out of the error, passing it only through git\'s environment', async () => {
    const token = 'ghp_SECRETSECRETSECRET';
    await fetchGitSource({ url: 'https://github.com/a/b', token }, policy, { run: fake(`fatal: Authentication failed for https://x-access-token:${token}@github.com/a/b`), resolve: async () => ['140.82.112.3'] })
      .then(() => { throw new Error('should have failed'); }, (e: Error) => { expect(e.message).not.toContain(token); expect(e.message).toMatch(/access token/); });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.args.join(' ')).not.toContain(token);
    const env = calls[0]!.env;
    expect(env['GIT_CONFIG_KEY_0']).toBe('http.extraHeader');
    expect(Buffer.from(env['GIT_CONFIG_VALUE_0']!.replace('Authorization: Basic ', ''), 'base64').toString()).toBe(`x-access-token:${token}`);
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
  });

  it('turns off hooks, redirects, submodules and every protocol but https, and never uses a shell', async () => {
    await fetchGitSource({ url: 'https://github.com/a/b' }, policy, { run: fake('fatal: nope'), resolve: async () => ['140.82.112.3'] }).catch(() => undefined);
    const a = calls[0]!.args.join(' ');
    expect(a).toContain('core.hooksPath=/dev/null');
    expect(a).toContain('http.followRedirects=false');
    expect(a).toContain('submodule.recurse=false');
    expect(a).toContain('protocol.allow=never');
    expect(a).toContain('protocol.https.allow=always');
    expect(calls[0]!.env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(calls[0]!.env['GIT_CONFIG_COUNT']).toBeUndefined();
  });

  it('refuses to send a token through a git too old to take it (it would be dropped and look like a wrong token)', async () => {
    const old: GitRunner = async (args) => ({ code: 0, stdout: args.includes('--version') ? 'git version 2.25.1' : '', stderr: '', timedOut: false });
    await expect(fetchGitSource({ url: 'https://github.com/a/b', token: 'ghp_x' }, policy, { run: old, resolve: async () => ['140.82.112.3'] })).rejects.toThrow(/needs 2\.31 or newer/);
    // without a token, an old git is fine; and a current git with one is fine
    const calls: string[][] = [];
    const ok: GitRunner = async (args) => { calls.push(args); return { code: 0, stdout: args.includes('--version') ? 'git version 2.39.5' : args.includes('rev-parse') ? 'a'.repeat(40) : '', stderr: '', timedOut: false }; };
    await fetchGitSource({ url: 'https://github.com/a/b', token: 'ghp_x' }, policy, { run: ok, resolve: async () => ['140.82.112.3'] }).catch(() => undefined);
    expect(calls.some((a) => a.includes('init'))).toBe(true);
  });

  it('says when the repository cannot be read, without guessing why', async () => {
    await expect(fetchGitSource({ url: 'https://github.com/a/b' }, policy, { run: fake('remote: Repository not found.'), resolve: async () => ['140.82.112.3'] })).rejects.toThrow(/does not exist or needs an access token \(none was given\)/);
  });
});

describe('a real repository', () => {
  let remote: string; let first: string; let second: string;
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: remote, encoding: 'utf8' }).trim();
  const local: GitPolicy = { allowedHosts: [], allowFile: true, skipDns: true };
  const url = () => `file://${remote}`;
  const zipOf = (r: { zip: Buffer }) => readZip(r.zip).files.map((f) => f.path).sort();

  beforeAll(() => {
    remote = mkdtempSync(join(tmpdir(), 'cb-remote-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(join(remote, 'package.json'), '{"name":"shop"}');
    writeFileSync(join(remote, 'index.js'), 'console.log(1)');
    mkdirSync(join(remote, 'services/api'), { recursive: true });
    writeFileSync(join(remote, 'services/api/main.py'), 'print(1)');
    symlinkSync('/etc/passwd', join(remote, 'link-to-passwd'));
    git('add', '-A'); git('commit', '-q', '-m', 'one'); first = git('rev-parse', 'HEAD');
    git('tag', 'v1');
    writeFileSync(join(remote, 'second.txt'), 'two');
    git('checkout', '-q', '-b', 'feature');
    git('add', '-A'); git('commit', '-q', '-m', 'two'); second = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
  });
  afterAll(() => rmSync(remote, { recursive: true, force: true }));

  it('becomes a zip of the files, without the repository folder, and says which commit it is', async () => {
    const r = await fetchGitSource({ url: url() }, local);
    expect(r.commit).toBe(first);
    expect(zipOf(r)).toEqual(['index.js', 'link-to-passwd', 'package.json', 'services/api/main.py']);
    expect(zipOf(r).some((p) => p.startsWith('.git'))).toBe(false);
  });

  it('never follows a symbolic link: it arrives as a small text file holding the link\'s target, not the file it points to', async () => {
    const link = readZip((await fetchGitSource({ url: url() }, local)).zip).files.find((f) => f.path === 'link-to-passwd')!;
    expect(link.content.toString()).toBe('/etc/passwd');
  });

  it('takes a branch, a tag and a commit', async () => {
    const feature = await fetchGitSource({ url: url(), ref: 'feature' }, local);
    expect(feature.commit).toBe(second);
    expect(zipOf(feature)).toContain('second.txt');
    expect((await fetchGitSource({ url: url(), ref: 'v1' }, local)).commit).toBe(first);
    expect((await fetchGitSource({ url: url(), ref: first }, local)).commit).toBe(first);
  });

  it('takes one folder of a repository', async () => {
    const r = await fetchGitSource({ url: url(), subdir: 'services/api' }, local);
    expect(zipOf(r)).toEqual(['main.py']);
    await expect(fetchGitSource({ url: url(), subdir: 'nope' }, local)).rejects.toThrow(/does not exist/);
  });

  it('is deterministic: the same commit gives the same zip, so the approval hash is stable', async () => {
    const a = await fetchGitSource({ url: url() }, local); const b = await fetchGitSource({ url: url() }, local);
    expect(a.zip.equals(b.zip)).toBe(true);
  });

  it('refuses an unknown ref, and code over the size limit', async () => {
    await expect(fetchGitSource({ url: url(), ref: 'nonexistent' }, local)).rejects.toBeInstanceOf(GitSourceError);
    writeFileSync(join(remote, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 7));
    git('checkout', '-q', '-b', 'big'); git('add', '-A'); git('commit', '-q', '-m', 'big');
    await expect(fetchGitSource({ url: url(), ref: 'big' }, local)).rejects.toThrow(/larger than 5 MB/);
    git('checkout', '-q', 'main');
  });

  it('runs no hook from the repository', async () => {
    const marker = join(remote, 'hook-ran');
    mkdirSync(join(remote, '.githooks'), { recursive: true });
    writeFileSync(join(remote, '.githooks/post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    git('checkout', '-q', '-b', 'hooks'); git('add', '-A'); git('commit', '-q', '-m', 'hook');
    await fetchGitSource({ url: url(), ref: 'hooks' }, local);
    expect(() => execFileSync('test', ['-e', marker])).toThrow();
    git('checkout', '-q', 'main');
  });
});
