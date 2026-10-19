/**
 * Terraform comes with CloudBuilder: it is found, or downloaded once, checked against the built-in checksum and kept. Everything here runs against
 * a local server and a fake "terraform" program, so nothing real is downloaded; scripts/install-terraform.ts (in CI) does the real download.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { deflateRawSync } from 'zlib';
import {
  _resetInstallStateForTests, TERRAFORM_SHA256, TERRAFORM_VERSION, TerraformDownloadError, ensureTerraform, extractZipEntry, fetchVerifiedTerraform,
  findOnPath, locateTerraform, managedBinaryPath, platformKey,
} from '@/lib/terraform/execution/binary';
import { runTerraform, TerraformNotInstalledError } from '@/lib/terraform/execution/cli';

// ─── a tiny zip writer, so the tests do not depend on a zip tool ───────────────
function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(entries: Array<{ name: string; data: Buffer; method?: 0 | 8 }>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc32(e.data), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc32(e.data), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); centrals.push(ch, name); offset += 30 + name.length + body.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

const FAKE = Buffer.from(`#!/bin/sh\nif [ "$1" = "version" ]; then echo "Terraform v${TERRAFORM_VERSION}"; else echo "ran: $@"; fi\n`);
const WRONG_VERSION = Buffer.from('#!/bin/sh\necho "Terraform v0.0.1"\n');
const BROKEN = Buffer.from('#!/bin/sh\nexit 3\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const KEY = platformKey()!;
const ZIP_NAME = KEY.startsWith('windows') ? 'terraform.exe' : 'terraform';

// ─── environment ──────────────────────────────────────────────────────────────
const ENV = ['TERRAFORM_BINARY_PATH', 'CLOUDBUILDER_TERRAFORM_DIR', 'CLOUDBUILDER_TERRAFORM_MIRROR', 'CLOUDBUILDER_TERRAFORM_DOWNLOAD', 'HOME', 'USERPROFILE', 'PATH'];
const saved: Record<string, string | undefined> = {};
const realSha = { ...TERRAFORM_SHA256 };
let root: string;
let server: http.Server | null = null;
let hits: string[] = [];
let served: Buffer | null = null;
let status = 200;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (status !== 200 || !served) { res.writeHead(status); res.end('nope'); return; }
      res.writeHead(200, { 'Content-Length': served.length }); res.end(served);
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`));
  });
}
const publish = (program: Buffer) => { served = makeZip([{ name: ZIP_NAME, data: program }, { name: 'LICENSE.txt', data: Buffer.from('license') }]); (TERRAFORM_SHA256 as Record<string, string>)[KEY] = sha(served); };

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfbin-'));
  process.env['CLOUDBUILDER_TERRAFORM_DIR'] = path.join(root, 'managed');
  process.env['HOME'] = path.join(root, 'home'); process.env['USERPROFILE'] = path.join(root, 'home');
  process.env['PATH'] = path.join(root, 'emptybin');
  delete process.env['TERRAFORM_BINARY_PATH']; delete process.env['CLOUDBUILDER_TERRAFORM_DOWNLOAD'];
  hits = []; status = 200; served = null;
  process.env['CLOUDBUILDER_TERRAFORM_MIRROR'] = await startServer();
  publish(FAKE);
  _resetInstallStateForTests();
});
afterEach(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  Object.assign(TERRAFORM_SHA256, realSha);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = null;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('which build, and the built-in checksums', () => {
  it('maps this machine to a published build, and refuses ones HashiCorp does not publish', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin_arm64');
    expect(platformKey('darwin', 'x64')).toBe('darwin_amd64');
    expect(platformKey('linux', 'x64')).toBe('linux_amd64');
    expect(platformKey('linux', 'arm64')).toBe('linux_arm64');
    expect(platformKey('win32', 'x64')).toBe('windows_amd64');
    expect(platformKey('win32', 'arm64')).toBeNull();
    expect(platformKey('freebsd', 'x64')).toBeNull();
    expect(KEY).toBeTruthy();
  });
  it('has a well-formed SHA-256 for every supported build', () => {
    for (const [k, v] of Object.entries(realSha)) { expect(k).toMatch(/^(darwin|linux|windows)_(amd64|arm64)$/); expect(v).toMatch(/^[0-9a-f]{64}$/); }
    expect(new Set(Object.values(realSha)).size).toBe(Object.keys(realSha).length);
    expect(TERRAFORM_VERSION).toBe('1.9.8');
  });
});

describe('reading a zip', () => {
  it('extracts a deflated file and a stored one, whichever order they are in', () => {
    const zip = makeZip([{ name: 'a.txt', data: Buffer.from('stored text'), method: 0 }, { name: 'terraform', data: Buffer.from('x'.repeat(5000)) }]);
    expect(extractZipEntry(zip, 'a.txt').toString()).toBe('stored text');
    expect(extractZipEntry(zip, 'terraform').toString()).toBe('x'.repeat(5000));
  });
  it('says plainly when the file is missing or the data is not a zip', () => {
    expect(() => extractZipEntry(makeZip([{ name: 'a', data: Buffer.from('1') }]), 'terraform')).toThrow(/not in the zip/);
    expect(() => extractZipEntry(Buffer.from('this is not a zip file at all, just text'), 'terraform')).toThrow(/not a zip/);
    const zip = makeZip([{ name: 'terraform', data: Buffer.from('hello') }]);
    zip.writeUInt32LE(99, zip.length - 22 + 16); // a directory offset that points nowhere
    expect(() => extractZipEntry(zip, 'terraform')).toThrow();
  });
});

describe('downloading safely', () => {
  it('returns the program only when the zip matches the built-in checksum', async () => {
    expect((await fetchVerifiedTerraform(KEY)).equals(FAKE)).toBe(true);
    expect(hits).toEqual([`/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_${KEY}.zip`]);
  });
  it('throws away a download that does not match (a tampered file or a hostile mirror)', async () => {
    served = makeZip([{ name: ZIP_NAME, data: Buffer.from('#!/bin/sh\necho evil\n') }]); // checksum still the old one
    await expect(fetchVerifiedTerraform(KEY)).rejects.toThrow(/does not match HashiCorp's published checksum.*Nothing was installed/);
  });
  it('explains a server error, an unreachable server and an oversized answer', async () => {
    status = 404;
    await expect(fetchVerifiedTerraform(KEY)).rejects.toThrow(/answered 404/);
    status = 200;
    await expect(fetchVerifiedTerraform(KEY, (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as unknown as typeof fetch)).rejects.toThrow(/Could not reach .*ENOTFOUND/);
    const huge = (async () => new Response('x', { headers: { 'content-length': String(500 * 1024 * 1024) } })) as unknown as typeof fetch;
    await expect(fetchVerifiedTerraform(KEY, huge)).rejects.toThrow(/far larger than expected/);
    await expect(fetchVerifiedTerraform('freebsd_amd64')).rejects.toThrow(/publishes no Terraform/);
  });
  it('a zip without the program in it is reported as unusable', async () => {
    served = makeZip([{ name: 'README', data: Buffer.from('nothing') }]);
    (TERRAFORM_SHA256 as Record<string, string>)[KEY] = sha(served);
    await expect(fetchVerifiedTerraform(KEY)).rejects.toThrow(/could not be unpacked/);
  });
});

describe('which Terraform is used', () => {
  const put = (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, FAKE, { mode: 0o755 }); return file; };
  it('is nothing at all on a clean machine, so it will be downloaded', () => {
    expect(locateTerraform()).toBeNull();
    expect(findOnPath('terraform', '')).toBeNull();
  });
  it('prefers the file you named, then the managed copy, then ~/bin, then the PATH', () => {
    const onPath = put(path.join(root, 'emptybin', 'terraform'));
    expect(locateTerraform()).toEqual({ path: onPath, source: 'path' });
    const homeBin = put(path.join(root, 'home', 'bin', 'terraform'));
    expect(locateTerraform()).toEqual({ path: homeBin, source: 'home-bin' });
    const managed = put(managedBinaryPath());
    expect(locateTerraform()).toEqual({ path: managed, source: 'managed' });
    const chosen = put(path.join(root, 'mine', 'terraform'));
    process.env['TERRAFORM_BINARY_PATH'] = chosen;
    expect(locateTerraform()).toEqual({ path: chosen, source: 'env' });
    process.env['TERRAFORM_BINARY_PATH'] = path.join(root, 'does-not-exist');
    expect(locateTerraform()?.source).toBe('managed'); // a path that is not a file is ignored
  });
  it('the managed copy lives under the pinned version, in the folder you can move', () => {
    expect(managedBinaryPath()).toBe(path.join(root, 'managed', TERRAFORM_VERSION, ZIP_NAME));
  });
});

describe('installing it once', () => {
  it('downloads, verifies it runs, installs it executable, and later calls do not download again', async () => {
    const logs: string[] = [];
    const p = await ensureTerraform({ log: (l) => logs.push(l) });
    expect(p).toBe(managedBinaryPath());
    expect(fs.statSync(p).mode & 0o111).not.toBe(0);
    expect(hits).toHaveLength(1);
    expect(logs[0]).toMatch(/Downloading Terraform 1\.9\.8 for .* \(first time only\)/);
    expect(logs.at(-1)).toMatch(/is ready/);
    expect(await ensureTerraform()).toBe(p);
    expect(hits).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(p))).toEqual([ZIP_NAME]);       // no temp files left behind
    expect(fs.existsSync(`${path.dirname(p)}.lock`)).toBe(false);       // and no lock
  });
  it('asks for it from several places at once and downloads it once', async () => {
    const all = await Promise.all([ensureTerraform(), ensureTerraform(), ensureTerraform()]);
    expect(new Set(all).size).toBe(1);
    expect(hits).toHaveLength(1);
  });
  it('another process holding the lock is waited for, and its result is used', async () => {
    const dir = path.dirname(managedBinaryPath());
    fs.mkdirSync(`${dir}.lock`, { recursive: true });
    const pending = ensureTerraform();
    setTimeout(() => { fs.writeFileSync(managedBinaryPath(), FAKE, { mode: 0o755 }); fs.rmSync(`${dir}.lock`, { recursive: true, force: true }); }, 700);
    expect(await pending).toBe(managedBinaryPath());
    expect(hits).toHaveLength(0);
  });
  it('a lock left behind by a crashed download is cleared', async () => {
    const dir = path.dirname(managedBinaryPath());
    fs.mkdirSync(`${dir}.lock`, { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(`${dir}.lock`, old, old);
    expect(await ensureTerraform()).toBe(managedBinaryPath());
    expect(hits).toHaveLength(1);
  });
  it('refuses a program that is the wrong version, or will not run, and leaves nothing installed', async () => {
    for (const [program, why] of [[WRONG_VERSION, /would not run on this machine/], [BROKEN, /would not run on this machine/]] as const) {
      publish(program); _resetInstallStateForTests(); hits = [];
      await expect(ensureTerraform()).rejects.toThrow(why);
      expect(fs.existsSync(managedBinaryPath())).toBe(false);
      expect(fs.readdirSync(path.dirname(managedBinaryPath()))).toEqual([]);
      expect(fs.existsSync(`${path.dirname(managedBinaryPath())}.lock`)).toBe(false);
    }
  });
  it('after a failed attempt the next call tries again (an outage does not stick)', async () => {
    status = 503;
    await expect(ensureTerraform()).rejects.toBeInstanceOf(TerraformDownloadError);
    status = 200;
    expect(await ensureTerraform()).toBe(managedBinaryPath());
  });
  it('never downloads when that is switched off, and says how to proceed', async () => {
    process.env['CLOUDBUILDER_TERRAFORM_DOWNLOAD'] = '0';
    await expect(ensureTerraform()).rejects.toThrow(/downloading it is switched off.*TERRAFORM_BINARY_PATH/);
    expect(hits).toHaveLength(0);
  });
  it('uses an installed Terraform without downloading anything', async () => {
    const installed = path.join(root, 'emptybin', 'terraform');
    fs.mkdirSync(path.dirname(installed), { recursive: true }); fs.writeFileSync(installed, FAKE, { mode: 0o755 });
    expect(await ensureTerraform()).toBe(installed);
    expect(hits).toHaveLength(0);
  });
});

describe('running Terraform with nothing installed', () => {
  it('downloads it first, tells the person what is happening, then runs the command', async () => {
    const out: string[] = [];
    const r = await runTerraform(['plan', '-out=x'], { cwd: root, env: {}, onOutput: (c) => out.push(c) });
    expect(r.stdout).toContain('ran: plan -out=x');
    expect(out.join('')).toMatch(/Downloading Terraform 1\.9\.8/);
    expect(hits).toHaveLength(1);
    const again = await runTerraform(['plan'], { cwd: root, env: {} });
    expect(again.stdout).toContain('ran: plan');
    expect(hits).toHaveLength(1); // the second run found it
  });
  it('without a progress listener it still just works', async () => {
    expect((await runTerraform(['version'], { cwd: root, env: {} })).stdout).toContain(`Terraform v${TERRAFORM_VERSION}`);
  });
  it('when the download fails the error says why, and it is the "not installed" error the app already handles', async () => {
    status = 404;
    const err = await runTerraform(['plan'], { cwd: root, env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(TerraformNotInstalledError);
    expect(err.message).toMatch(/could not be downloaded: Downloading Terraform failed: .* answered 404/);
  });
});
