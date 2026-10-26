/**
 * The code of a service taken from a Git repository, as the same kind of zip an upload gives (the route then reads it with the same strict checks,
 * stores it, and the approval covers its SHA-256). Nothing about the build changes: the generated Dockerfile is still used, not one from the repository.
 *
 * The repository is somebody else's input and the address is chosen by a person, so this is careful about what it will reach and what it will run:
 *  - only https, only hosts on an allow-list (CLOUDBUILDER_GIT_ALLOWED_HOSTS, default github.com, gitlab.com, bitbucket.org, dev.azure.com), no
 *    address inside the URL, and a host that resolves to a private, loopback or link-local address is refused (no reaching into the network);
 *  - git runs without a shell, with no hooks, no submodules, no redirects, no prompts, no user or system configuration and a time and size limit;
 *  - the access token for a private repository goes to git through its environment (never a command line, a file or a log) and is not stored;
 *  - symbolic links are not followed (they become plain text files), and a repository's own folder is never included.
 */
import { spawn } from 'child_process';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, posix } from 'path';
import { buildSourceZip, type ZipEntry } from './zipWriter';
import { DEFAULT_ZIP_LIMITS } from './zip';

export class GitSourceError extends Error { constructor(message: string) { super(message); this.name = 'GitSourceError'; } }

export interface GitSourceRequest { url: string; ref?: string; subdir?: string; token?: string }
export interface GitPolicy {
  allowedHosts: string[];
  timeoutMs?: number;
  /** Stop when what has been downloaded and checked out is bigger than this. */
  maxRepoBytes?: number;
}
export interface GitSourceResult { zip: Buffer; commit: string; files: number; ref: string; subdir: string; host: string; repo: string }

export const DEFAULT_GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org', 'dev.azure.com'];
export function gitPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): GitPolicy {
  const list = (env['CLOUDBUILDER_GIT_ALLOWED_HOSTS'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { allowedHosts: list.length > 0 ? list : DEFAULT_GIT_HOSTS };
}

/** The user name a host expects with a personal access token over HTTPS. */
const TOKEN_USER: Record<string, string> = { 'github.com': 'x-access-token', 'gitlab.com': 'oauth2', 'bitbucket.org': 'x-token-auth', 'dev.azure.com': '' };

export function isPrivateAddress(ip: string): boolean {
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

export interface CheckedRequest { url: URL; ref: string; subdir: string; token: string; host: string; repo: string }

/** Everything about the request that can be checked without touching the network. */
export function checkRequest(req: GitSourceRequest, policy: GitPolicy): CheckedRequest {
  let url: URL;
  try { url = new URL(String(req.url ?? '').trim()); } catch { throw new GitSourceError('The repository address is not a valid URL.'); }
  if (url.protocol !== 'https:') throw new GitSourceError('Use the https address of the repository (https://…).');
  if (url.username || url.password) throw new GitSourceError('Do not put a user name or password in the address: use the access token field for a private repository.');
  if (url.port && url.port !== '443') throw new GitSourceError('The repository address must use the standard https port.');
  const host = url.hostname.toLowerCase();
  if (!policy.allowedHosts.includes(host)) throw new GitSourceError(`Code can be taken from ${policy.allowedHosts.join(', ')}. Ask an administrator to allow ${host} (CLOUDBUILDER_GIT_ALLOWED_HOSTS), or upload a zip.`);
  if (url.search || url.hash) throw new GitSourceError('The repository address must not contain a query or a fragment.');
  const path = url.pathname.replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9._~%@:+/-]{1,300}$/.test(path) || path.split('/').some((p) => p === '..' || p === '.')) throw new GitSourceError('The repository path is not valid.');
  const token = req.token === undefined || req.token === '' ? '' : String(req.token);
  if (token && (token.length > 512 || /[\s\0]/.test(token))) throw new GitSourceError('The access token is not valid.');
  url.pathname = path;
  return { url, ref: checkRef(req.ref), subdir: checkSubdir(req.subdir), token, host, repo: path.replace(/^\//, '').replace(/\.git$/, '') };
}

function checkRef(ref: string | undefined): string {
  const r = (ref ?? '').trim();
  if (r === '') return 'HEAD';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(r) || r.includes('..') || r.includes('//') || r.endsWith('/') || r.endsWith('.lock')) throw new GitSourceError('The branch, tag or commit is not valid.');
  return r;
}

function checkSubdir(dir: string | undefined): string {
  const d = (dir ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (d === '') return '';
  if (d.length > 200 || d.split('/').some((p) => !/^[A-Za-z0-9._-]+$/.test(p) || p === '.' || p === '..' || p === '.git')) throw new GitSourceError('The folder must be a relative path such as services/api.');
  return d;
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type GitRunner = (args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number; watch: () => boolean }) => Promise<RunResult>;

export const runGit: GitRunner = (args, { cwd, env, timeoutMs, watch }) => new Promise((resolve) => {
  const child = spawn('git', args, { cwd, env: env as NodeJS.ProcessEnv, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let timedOut = false;
  const cap = (s: string, chunk: Buffer) => (s.length > 20_000 ? s : s + chunk.toString('utf8'));
  child.stdout.on('data', (d: Buffer) => { stdout = cap(stdout, d); });
  child.stderr.on('data', (d: Buffer) => { stderr = cap(stderr, d); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const guard = setInterval(() => { if (watch()) { timedOut = true; child.kill('SIGKILL'); } }, 1000);
  child.on('close', (code) => { clearTimeout(timer); clearInterval(guard); resolve({ code, stdout, stderr, timedOut }); });
  child.on('error', (e) => { clearTimeout(timer); clearInterval(guard); resolve({ code: 127, stdout, stderr: String(e.message), timedOut }); });
});

function dirBytes(dir: string, stopAt: number): number {
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name); const st = lstatSync(p);
      if (st.isDirectory()) walk(p); else total += st.size;
      if (total > stopAt) return;
    }
  };
  try { walk(dir); } catch { /* the folder is being written to: look again next time */ }
  return total;
}

/** Hides the token wherever git might echo it back. */
const redact = (text: string, token: string) => (token ? text.split(token).join('***') : text).replace(/(Authorization: Basic )\S+/gi, '$1***');

export async function fetchGitSource(
  request: GitSourceRequest,
  policy: GitPolicy,
  deps: { run?: GitRunner; resolve?: (host: string) => Promise<string[]> } = {},
): Promise<GitSourceResult> {
  const checked = checkRequest(request, policy);
  const run = deps.run ?? runGit;
  const limits = DEFAULT_ZIP_LIMITS;

  // The host must resolve to public addresses only (git then looks it up again itself: the allow-list is what pins the host).
  const resolve = deps.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));
  let addresses: string[];
  try { addresses = await resolve(checked.host); } catch { throw new GitSourceError(`The address ${checked.host} could not be found.`); }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new GitSourceError(`${checked.host} does not resolve to a public address, so it is not used.`);

  const work = mkdtempSync(join(tmpdir(), 'cb-git-'));
  const repoDir = join(work, 'repo');
  const home = join(work, 'home');
  try {
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GCM_INTERACTIVE: 'never',
    };
    if (checked.token) {
      const user = TOKEN_USER[checked.host] ?? 'x-access-token';
      env['GIT_CONFIG_COUNT'] = '1';
      env['GIT_CONFIG_KEY_0'] = 'http.extraHeader';
      env['GIT_CONFIG_VALUE_0'] = `Authorization: Basic ${Buffer.from(`${user}:${checked.token}`).toString('base64')}`;
    }
    const safe = [
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=false', '-c', 'http.followRedirects=false', '-c', 'submodule.recurse=false',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'advice.detachedHead=false', '-c', 'gc.auto=0',
    ];
    const limit = policy.maxRepoBytes ?? 200 * 1024 * 1024;
    const opts = { cwd: repoDir, env, timeoutMs: policy.timeoutMs ?? 120_000, watch: () => dirBytes(repoDir, limit) > limit };
    const step = async (args: string[], what: string): Promise<string> => {
      const r = await run([...safe, ...args], opts);
      if (r.timedOut) throw new GitSourceError(`Getting the code took too long or was too large (${what}). Use a smaller repository, a folder of it, or upload a zip.`);
      if (r.code !== 0) {
        const why = redact(`${r.stderr} ${r.stdout}`, checked.token).replace(/\s+/g, ' ').trim().slice(0, 300);
        const denied = /authentication|could not read|403|401|not found|repository .* not found|access denied/i.test(why);
        throw new GitSourceError(denied
          ? `The repository could not be read: it does not exist or needs an access token (${checked.token ? 'the token was refused or does not have read access' : 'none was given'}).`
          : `Getting the code failed (${what}): ${why || 'no detail from git'}`);
      }
      return r.stdout.trim();
    };
    // The folder must exist before git runs in it.
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    // The token reaches git through GIT_CONFIG_COUNT/KEY/VALUE, which git understands from 2.31. An older git would ignore it and fail as if the token were wrong.
    if (checked.token) {
      const v = await run(['--version'], opts);
      const m = /(\d+)\.(\d+)/.exec(v.stdout);
      if (m && (Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 31))) throw new GitSourceError(`The server's git (${m[0]}) is too old to pass an access token safely: it needs 2.31 or newer. Upgrade git on the server, or upload a zip.`);
    }
    await step(['init', '-q'], 'init');
    await step(['remote', 'add', 'origin', checked.url.toString()], 'remote');
    await step(['fetch', '-q', '--depth', '1', '--no-tags', '--no-recurse-submodules', 'origin', checked.ref], `fetch ${checked.ref}`);
    await step(['checkout', '-q', '--detach', 'FETCH_HEAD'], 'checkout');
    const commit = await step(['rev-parse', 'HEAD'], 'rev-parse');
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new GitSourceError('Git did not report a commit.');

    const root = checked.subdir ? join(repoDir, checked.subdir) : repoDir;
    let st;
    try { st = statSync(root); } catch { throw new GitSourceError(`The folder "${checked.subdir}" does not exist in the repository at ${checked.ref}.`); }
    if (!st.isDirectory()) throw new GitSourceError(`"${checked.subdir}" is not a folder.`);

    const entries: ZipEntry[] = []; let total = 0;
    const walk = (dir: string, rel: string) => {
      for (const name of readdirSync(dir).sort()) {
        if (name === '.git' && rel === '') continue;
        const path = join(dir, name); const relPath = rel ? `${rel}/${name}` : name;
        const l = lstatSync(path);
        if (l.isSymbolicLink()) continue; // a link is never followed
        if (l.isDirectory()) { walk(path, relPath); continue; }
        if (!l.isFile()) continue;
        if (name.includes('\\') || /[\0-\x1f]/.test(name)) throw new GitSourceError(`The file name ${JSON.stringify(relPath.slice(0, 60))} is not allowed.`);
        if (l.size > limits.maxFileBytes) throw new GitSourceError(`${relPath} is larger than ${limits.maxFileBytes / 1024 / 1024} MB.`);
        total += l.size;
        if (entries.length + 1 > limits.maxFiles || total > limits.maxTotalBytes) throw new GitSourceError(`The code is larger than the limit (${limits.maxFiles} files, ${limits.maxTotalBytes / 1024 / 1024} MB). Use a folder of the repository, or exclude build output.`);
        entries.push({ path: posix.normalize(relPath), content: readFileSync(path) });
      }
    };
    walk(root, '');
    if (entries.length === 0) throw new GitSourceError('The repository folder has no files.');
    const zip = buildSourceZip(entries);
    if (zip.length > limits.maxZipBytes) throw new GitSourceError(`The code is ${(zip.length / 1024 / 1024).toFixed(1)} MB zipped; the limit is ${limits.maxZipBytes / 1024 / 1024} MB. Use a folder of the repository, or exclude build output.`);
    return { zip, commit, files: entries.length, ref: checked.ref, subdir: checked.subdir, host: checked.host, repo: checked.repo };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
