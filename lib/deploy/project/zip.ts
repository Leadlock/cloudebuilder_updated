/**
 * Reads a zip file somebody uploaded, safely: the source of a service that is built from their own code.
 *
 * The archive is untrusted, so nothing is extracted to a disk and nothing is trusted from it: every entry is checked before it is read, and a single
 * surprise refuses the whole archive. Refused: encrypted entries, ZIP64 (too large to be a source folder anyway), symbolic links, paths that are
 * absolute, contain "..", backslashes, a drive letter or a NUL, duplicate paths, an entry whose data lies outside the file, a size that does not
 * match what it says, a bad checksum, and anything over the limits (size, number of files, expanded size, compression ratio: a zip bomb). Only
 * "stored" and "deflate" entries are read.
 */
import { inflateRawSync } from 'zlib';

export interface ZipLimits {
  maxZipBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** An entry that expands to more than this many times its compressed size is refused (when it is also over a megabyte). */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxZipBytes: 5 * 1024 * 1024, maxFiles: 2000, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 30 * 1024 * 1024, maxRatio: 100 };

export interface ZipFile { path: string; content: Buffer }
export interface ZipContents { files: ZipFile[]; /** Entries that were left out on purpose (editor and system files), by name. */ skipped: string[] }

export class ZipError extends Error { constructor(message: string) { super(message); this.name = 'ZipError'; } }

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf: Buffer): number { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Left out without a word: what editors and operating systems add, and a repository's own folder. */
const SKIPPED = /(^|\/)(__MACOSX|\.git|\.DS_Store|Thumbs\.db|node_modules)(\/|$)/;

function safeName(raw: string): string {
  const name = raw;
  if (name === '' || name.length > 240) throw new ZipError('An entry has an empty or very long name.');
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ZipError(`An entry has a path that is not allowed: ${JSON.stringify(name.slice(0, 60))}`);
  if (name.split('/').some((p) => p === '..' || p === '.' || (p === '' && !name.endsWith('/')))) throw new ZipError(`An entry has a path that is not allowed: ${JSON.stringify(name.slice(0, 60))}`);
  return name;
}

export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipContents {
  if (buf.length > limits.maxZipBytes) throw new ZipError(`The zip is larger than ${Math.round(limits.maxZipBytes / 1024 / 1024)} MB.`);
  if (buf.length < 22) throw new ZipError('This is not a zip file.');

  // The end-of-central-directory record is at the end, before an optional comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('This is not a zip file.');
  const disk = buf.readUInt16LE(eocd + 4); const entriesOnDisk = buf.readUInt16LE(eocd + 8); const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12); const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || entriesOnDisk !== entries) throw new ZipError('A zip in several parts is not supported.');
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported: this one is too large for a source folder.');
  if (entries > limits.maxFiles * 2) throw new ZipError(`The zip has more than ${limits.maxFiles} files.`);
  if (cdOffset + cdSize > eocd) throw new ZipError('The zip is damaged.');

  const out: ZipFile[] = []; const skipped: string[] = []; const seen = new Set<string>();
  let total = 0; let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The zip is damaged.');
    const madeBy = buf.readUInt16LE(p + 4); const flags = buf.readUInt16LE(p + 8); const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16); const compSize = buf.readUInt32LE(p + 20); const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28); const extraLen = buf.readUInt16LE(p + 30); const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38); const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cdOffset + cdSize) throw new ZipError('The zip is damaged.');
    const name = safeName(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new ZipError('An encrypted zip is not supported.');
    if ((madeBy >> 8) === 3 && ((external >>> 16) & 0xf000) === 0xa000) throw new ZipError(`The zip contains a symbolic link (${JSON.stringify(name.slice(0, 60))}), which is not allowed.`);
    if (name.endsWith('/')) continue;                                  // a folder: its files carry the path
    if (SKIPPED.test(name)) { skipped.push(name); continue; }
    if (out.length >= limits.maxFiles) throw new ZipError(`The zip has more than ${limits.maxFiles} files.`);
    if (method !== 0 && method !== 8) throw new ZipError(`${JSON.stringify(name.slice(0, 60))} uses a compression this does not support.`);
    if (compSize === 0xffffffff || size === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
    if (size > limits.maxFileBytes) throw new ZipError(`${JSON.stringify(name.slice(0, 60))} is larger than ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB.`);
    if (size > 1024 * 1024 && compSize > 0 && size / compSize > limits.maxRatio) throw new ZipError(`${JSON.stringify(name.slice(0, 60))} expands too much (a zip bomb?).`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError(`The files add up to more than ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB.`);
    if (seen.has(name)) throw new ZipError(`The zip lists ${JSON.stringify(name.slice(0, 60))} twice.`);
    seen.add(name);

    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError('The zip is damaged.');
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compSize > cdOffset) throw new ZipError('The zip is damaged.');
    const data = buf.subarray(start, start + compSize);
    let content: Buffer;
    if (method === 0) { if (compSize !== size) throw new ZipError(`${JSON.stringify(name.slice(0, 60))} has a wrong size.`); content = Buffer.from(data); }
    else {
      try { content = inflateRawSync(data, { maxOutputLength: size + 1 }); }
      catch { throw new ZipError(`${JSON.stringify(name.slice(0, 60))} could not be read (damaged, or larger than it says).`); }
      if (content.length !== size) throw new ZipError(`${JSON.stringify(name.slice(0, 60))} has a wrong size.`);
    }
    if (crc32(content) !== crc) throw new ZipError(`${JSON.stringify(name.slice(0, 60))} is damaged (checksum).`);
    out.push({ path: name, content });
  }

  // A zip of a folder usually holds everything inside that folder: take the folder off.
  const tops = new Set(out.map((f) => f.path.split('/')[0]!));
  const strip = out.length > 0 && tops.size === 1 && out.every((f) => f.path.includes('/')) ? `${[...tops][0]}/` : '';
  const files = out.map((f) => ({ path: f.path.slice(strip.length), content: f.content }));
  if (files.length === 0) throw new ZipError('The zip has no files in it.');
  const paths = new Set<string>();
  for (const f of files) { if (paths.has(f.path)) throw new ZipError(`The zip lists ${JSON.stringify(f.path.slice(0, 60))} twice.`); paths.add(f.path); }
  return { files, skipped };
}
