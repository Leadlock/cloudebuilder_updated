/**
 * A gzip-compressed tar archive built in memory: the source a registry build is given. Only what is needed: regular files with a path, content
 * and a mode, written in the POSIX ustar format (paths up to 255 characters, split at a "/" when over 100). No symlinks, no directories (a file's
 * path creates them), nothing from the host's file system.
 */
import { gzipSync } from 'zlib';

export interface TarFile { path: string; content: string | Buffer; mode?: number }

const BLOCK = 512;

function field(value: string, length: number): Buffer {
  const b = Buffer.alloc(length);
  b.write(value, 0, 'utf8');
  return b;
}
const octal = (n: number, length: number) => field(n.toString(8).padStart(length - 1, '0'), length);

function splitPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i); const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`The path is too long for an archive: ${path.slice(0, 60)}…`);
}

/** Rejects anything that could land outside the build folder. */
export function safeTarPath(path: string): string {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    throw new Error(`Not a safe path for an archive: ${JSON.stringify(path.slice(0, 80))}`);
  }
  return path;
}

export function buildTar(files: TarFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const content = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
    const { name, prefix } = splitPath(safeTarPath(f.path));
    const h = Buffer.alloc(BLOCK);
    field(name, 100).copy(h, 0);
    octal(f.mode ?? 0o644, 8).copy(h, 100);
    octal(0, 8).copy(h, 108);                 // uid
    octal(0, 8).copy(h, 116);                 // gid
    octal(content.length, 12).copy(h, 124);   // size
    octal(0, 12).copy(h, 136);                // mtime: fixed, so the same files always give the same archive
    h.fill(0x20, 148, 156);                   // checksum is computed with this field as spaces
    h.write('0', 156);                        // regular file
    h.write('ustar\0', 257);
    h.write('00', 263);
    field(prefix, 155).copy(h, 345);
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(h, content, Buffer.alloc((BLOCK - (content.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));        // end of archive
  return gzipSync(Buffer.concat(parts), { level: 9 });
}
