/**
 * Terraform comes with CloudCraft: nothing to install.
 *
 * The first time Terraform is needed and none is found, this downloads the pinned release for this machine from HashiCorp, checks it against
 * the official SHA-256 checksum that is built into this file, and keeps it under the CloudCraft data folder. Anything that does not match is
 * thrown away, so a tampered download or a hostile mirror cannot put a program on the server.
 *
 * Which Terraform is used, in order:
 *   1. TERRAFORM_BINARY_PATH, when set to a file that exists (you chose it);
 *   2. the copy CloudCraft manages (the pinned version);
 *   3. ~/bin/terraform, then `terraform` on the PATH (what was there before this existed).
 * If none exists, step 2 is created. Settings, all optional:
 *   CLOUDCRAFT_TERRAFORM_DIR       where the managed copy lives (default ~/.cloudcraft/terraform)
 *   CLOUDCRAFT_TERRAFORM_MIRROR    where releases are fetched from (default https://releases.hashicorp.com/terraform); it must serve the same
 *                                  files, because they are still checked against the built-in checksums
 *   CLOUDCRAFT_TERRAFORM_DOWNLOAD=0   never download (for machines with no internet: install Terraform yourself or set TERRAFORM_BINARY_PATH)
 *
 * Terraform is licensed by HashiCorp under the Business Source License. CloudCraft does not redistribute it: each server downloads its own copy
 * from HashiCorp, the same way `hashicorp/setup-terraform` does.
 */
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { inflateRawSync } from 'zlib';

/** The version CloudCraft runs. The generated Terraform is validated against this one in CI. */
export const TERRAFORM_VERSION = '1.9.8';

/** SHA-256 of each release zip, from https://releases.hashicorp.com/terraform/1.9.8/terraform_1.9.8_SHA256SUMS. */
export const TERRAFORM_SHA256: Readonly<Record<string, string>> = {
  darwin_amd64: 'be591e8c59c49d0cfbc7664d24910a4b43840b89d0a4bbca662149bbf0397e91',
  darwin_arm64: '873d7b925d08578fb6bb9c12c7cd92ae73e289e07c360f2fdd69f9036b7baaab',
  linux_amd64: '186e0145f5e5f2eb97cbd785bc78f21bae4ef15119349f6ad4fa535b83b10df8',
  linux_arm64: 'f85868798834558239f6148834884008f2722548f84034c9b0f62934b2d73ebb',
  windows_amd64: '2667de56106bc6707968286357e29c20f8dbbb2f429ef57099b04994f82d9684',
};

const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const exeName = (platform = process.platform) => (platform === 'win32' ? 'terraform.exe' : 'terraform');

/** "linux_amd64" for this machine, or null when HashiCorp publishes no build of this version for it. */
export function platformKey(platform: string = process.platform, arch: string = process.arch): string | null {
  const os_ = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'x64' ? 'amd64' : arch;
  const key = `${os_}_${cpu}`;
  return key in TERRAFORM_SHA256 ? key : null;
}

export const managedRoot = (): string => process.env['CLOUDCRAFT_TERRAFORM_DIR'] || path.join(os.homedir(), '.cloudcraft', 'terraform');
export const managedBinaryPath = (): string => path.join(managedRoot(), TERRAFORM_VERSION, exeName());
export const mirrorBase = (): string => (process.env['CLOUDCRAFT_TERRAFORM_MIRROR'] || 'https://releases.hashicorp.com/terraform').replace(/\/+$/, '');
export const downloadAllowed = (): boolean => process.env['CLOUDCRAFT_TERRAFORM_DOWNLOAD'] !== '0';

const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

export function findOnPath(name: string = exeName(), pathVar: string = process.env['PATH'] ?? ''): string | null {
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

export type TerraformSource = 'env' | 'managed' | 'home-bin' | 'path';

/** The Terraform that would be used right now, or null when there is none (it would be downloaded). */
export function locateTerraform(): { path: string; source: TerraformSource } | null {
  const fromEnv = process.env['TERRAFORM_BINARY_PATH'];
  if (fromEnv && isFile(fromEnv)) return { path: fromEnv, source: 'env' };
  if (isFile(managedBinaryPath())) return { path: managedBinaryPath(), source: 'managed' };
  const home = process.env['USERPROFILE'] || process.env['HOME'] || '';
  if (home) { const c = path.join(home, 'bin', exeName()); if (isFile(c)) return { path: c, source: 'home-bin' }; }
  const onPath = findOnPath();
  return onPath ? { path: onPath, source: 'path' } : null;
}

// ─── zip ─────────────────────────────────────────────────────────────────────

/** The bytes of one file in a zip (stored or deflated). Reads the central directory, so it needs no external tool. */
export function extractZipEntry(zip: Buffer, name: string): Buffer {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) { if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (entry === name) {
      if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('damaged zip entry');
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + csize);
      const out = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
      if (!out) throw new Error(`unsupported zip method ${method}`);
      if (out.length !== usize) throw new Error('zip entry has the wrong size');
      return out;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${name} is not in the zip`);
}

// ─── download ────────────────────────────────────────────────────────────────

export class TerraformDownloadError extends Error {
  constructor(message: string) { super(message); this.name = 'TerraformDownloadError'; }
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Fetches the zip for this machine and returns the program inside it, only if the zip matches the built-in checksum. */
export async function fetchVerifiedTerraform(key: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const expected = TERRAFORM_SHA256[key];
  if (!expected) throw new TerraformDownloadError(`HashiCorp publishes no Terraform ${TERRAFORM_VERSION} for ${key}.`);
  const url = `${mirrorBase()}/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_${key}.zip`;
  let res: Response;
  try { res = await fetchImpl(url, { redirect: 'follow' }); } catch (e) { throw new TerraformDownloadError(`Could not reach ${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`); }
  if (!res.ok) throw new TerraformDownloadError(`Downloading Terraform failed: ${new URL(url).host} answered ${res.status}.`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_ZIP_BYTES) throw new TerraformDownloadError('The Terraform download is far larger than expected, so it was refused.');
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.length > MAX_ZIP_BYTES) throw new TerraformDownloadError('The Terraform download is far larger than expected, so it was refused.');
  if (sha256(zip) !== expected) throw new TerraformDownloadError('The downloaded Terraform does not match HashiCorp\'s published checksum, so it was thrown away. Nothing was installed.');
  try { return extractZipEntry(zip, key.startsWith('windows') ? 'terraform.exe' : 'terraform'); }
  catch (e) { throw new TerraformDownloadError(`The Terraform download could not be unpacked: ${e instanceof Error ? e.message : String(e)}`); }
}

const LOCK_STALE_MS = 10 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let inFlight: Promise<string> | null = null;

/**
 * The Terraform to run: the one that is already there, or the managed copy after downloading it. One download at a time per machine (the web
 * server and the worker may ask together); everyone else waits for it. Throws TerraformDownloadError with a reason a person can act on.
 */
export function ensureTerraform(opts: { log?: (line: string) => void; fetchImpl?: typeof fetch } = {}): Promise<string> {
  const found = locateTerraform();
  if (found) return Promise.resolve(found.path);
  if (!downloadAllowed()) return Promise.reject(new TerraformDownloadError('Terraform is not installed, and downloading it is switched off (CLOUDCRAFT_TERRAFORM_DOWNLOAD=0). Install it, or set TERRAFORM_BINARY_PATH.'));
  inFlight ??= install(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function install(opts: { log?: (line: string) => void; fetchImpl?: typeof fetch }): Promise<string> {
  const log = opts.log ?? (() => undefined);
  const key = platformKey();
  if (!key) throw new TerraformDownloadError(`HashiCorp publishes no Terraform ${TERRAFORM_VERSION} for ${process.platform} on ${process.arch}. Install Terraform yourself, or set TERRAFORM_BINARY_PATH.`);
  const target = managedBinaryPath();
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const lock = `${dir}.lock`;

  // Take the lock (a directory: creating it is atomic). Someone else holding it means they are downloading: wait for their result.
  for (let waited = 0; ; waited += 500) {
    try { fs.mkdirSync(lock); break; } catch {
      if (isFile(target)) return target;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch { /* it just went away */ }
      if (waited >= LOCK_STALE_MS) throw new TerraformDownloadError('Another process has been downloading Terraform for too long. Try again in a few minutes.');
      await sleep(500);
    }
  }
  try {
    if (isFile(target)) return target;
    log(`Downloading Terraform ${TERRAFORM_VERSION} for ${key} (first time only)…`);
    const program = await fetchVerifiedTerraform(key, opts.fetchImpl);
    const temp = path.join(dir, `.download-${process.pid}-${Date.now()}`);
    fs.writeFileSync(temp, program, { mode: 0o755 });
    fs.chmodSync(temp, 0o755);
    const probe = spawnSync(temp, ['version'], { encoding: 'utf8', timeout: 30_000 });
    if (probe.status !== 0 || !probe.stdout.includes(`Terraform v${TERRAFORM_VERSION}`)) {
      fs.rmSync(temp, { force: true });
      throw new TerraformDownloadError(`The downloaded Terraform would not run on this machine${probe.stderr ? `: ${probe.stderr.trim().slice(0, 200)}` : ''}.`);
    }
    fs.renameSync(temp, target);
    log(`Terraform ${TERRAFORM_VERSION} is ready.`);
    return target;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** For tests. */
export function _resetInstallStateForTests(): void { inFlight = null; }
