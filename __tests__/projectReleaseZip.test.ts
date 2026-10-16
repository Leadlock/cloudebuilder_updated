/**
 * The zip somebody uploads as the source of a service: read correctly when it is good, refused on any surprise when it is not. The bad ones are made
 * by hand here, byte by byte, because an ordinary zip tool will not write a path like "../x" or a symbolic link on purpose.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deflateRawSync } from 'zlib';
import { crc32, DEFAULT_ZIP_LIMITS, readZip, ZipError } from '@/lib/deploy/project/zip';

interface Entry { name: string; data?: Buffer; method?: 0 | 8; flags?: number; mode?: number; madeBy?: number; crc?: number; size?: number; comp?: Buffer }

/** A zip file written by hand, so each field can be made wrong. */
function makeZip(entries: Entry[], opts: { eocdEntries?: number; commentLen?: number } = {}): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const comp = e.comp ?? (method === 8 ? deflateRawSync(data) : data);
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(e.flags ?? 0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(e.crc ?? crc32(data), 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(e.size ?? data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(((e.madeBy ?? 3) << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(e.flags ?? 0, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(e.crc ?? crc32(data), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(e.size ?? data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(opts.eocdEntries ?? entries.length, 8); eocd.writeUInt16LE(opts.eocdEntries ?? entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(opts.commentLen ?? 0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}
const f = (name: string, text = 'x', over: Partial<Entry> = {}): Entry => ({ name, data: Buffer.from(text), ...over });

describe('a good zip', () => {
  test('is read back with its paths and content, deflated or stored', () => {
    const z = makeZip([f('package.json', '{"name":"a"}'), f('src/server.js', 'console.log(1)\n'), f('data/raw.bin', 'abc', { method: 0 }), f('empty.txt', '')]);
    const r = readZip(z);
    expect(r.files.map((x) => x.path)).toEqual(['package.json', 'src/server.js', 'data/raw.bin', 'empty.txt']);
    expect(r.files[1]!.content.toString()).toBe('console.log(1)\n');
    expect(r.files[2]!.content.toString()).toBe('abc');
  });

  test('a zip made by the real zip tool, with a folder around everything, comes out without the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    try {
      mkdirSync(join(dir, 'app/src'), { recursive: true });
      writeFileSync(join(dir, 'app/package.json'), '{"a":1}'); writeFileSync(join(dir, 'app/src/index.js'), 'x'.repeat(5000)); writeFileSync(join(dir, 'app/.DS_Store'), 'junk');
      const z = spawnSync('zip', ['-qr', 'a.zip', 'app'], { cwd: dir });
      if (z.status !== 0) return;      // no zip tool on this machine: the hand-made ones above cover the format
      const r = readZip(readFileSync(join(dir, 'a.zip')));
      expect(r.files.map((x) => x.path).sort()).toEqual(['package.json', 'src/index.js']);
      expect(r.skipped).toEqual(['app/.DS_Store']);
      expect(r.files.find((x) => x.path === 'src/index.js')!.content.length).toBe(5000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('editor, system and repository files are left out without an error', () => {
    const r = readZip(makeZip([f('a.js'), f('__MACOSX/._a.js'), f('.git/config'), f('sub/.DS_Store'), f('node_modules/x/index.js'), f('Thumbs.db')]));
    expect(r.files.map((x) => x.path)).toEqual(['a.js']);
    expect(r.skipped).toHaveLength(5);
  });

  test('folders are only containers; a single top folder is removed, several are kept', () => {
    expect(readZip(makeZip([f('proj/', '', { mode: 0o040755 }), f('proj/a.js'), f('proj/b/c.js')])).files.map((x) => x.path)).toEqual(['a.js', 'b/c.js']);
    expect(readZip(makeZip([f('one/a.js'), f('two/b.js')])).files.map((x) => x.path)).toEqual(['one/a.js', 'two/b.js']);
    expect(readZip(makeZip([f('a.js'), f('dir/b.js')])).files.map((x) => x.path)).toEqual(['a.js', 'dir/b.js']);
  });

  test('a comment after the end record is fine', () => {
    const z = makeZip([f('a.js')]);
    expect(readZip(Buffer.concat([z.subarray(0, z.length - 2), Buffer.from([4, 0]), Buffer.from('note')])).files).toHaveLength(1);
  });
});

describe('a zip that is refused', () => {
  const refuses = (z: Buffer, why: RegExp, limits = DEFAULT_ZIP_LIMITS) => { expect(() => readZip(z, limits)).toThrow(why); expect(() => readZip(z, limits)).toThrow(ZipError); };

  test.each([
    ['an absolute path', '/etc/cron.d/x'], ['a path that climbs out', '../evil.sh'], ['a path that climbs from inside', 'a/../../evil.sh'], ['a backslash path', 'a\\b.js'],
    ['a drive letter', 'C:/x.js'], ['a NUL in the name', 'a\0b.js'], ['an empty segment', 'a//b.js'], ['a dot segment', './a.js'], ['a name that is too long', `${'a'.repeat(250)}.js`],
  ])('%s', (_n, name) => { refuses(makeZip([f(name)]), /path that is not allowed|empty or very long/); });

  test('a symbolic link', () => { refuses(makeZip([f('link', '/etc/passwd', { mode: 0o120777 })]), /symbolic link/); });
  test('an encrypted entry', () => { refuses(makeZip([f('a.js', 'x', { flags: 1 })]), /encrypted/); });
  test('a compression it does not read (bzip2)', () => { refuses(makeZip([f('a.js', 'x', { method: 12 as never, comp: Buffer.from('x') })]), /does not support/); });
  test('the same path twice', () => { refuses(makeZip([f('a.js'), f('a.js', 'y')]), /twice/); });
  test('the same path twice once the folder is taken off', () => { refuses(makeZip([f('top/a.js'), f('top/', '', { mode: 0o040755 }), f('top/b.js'), f('top/a.js', 'y')]), /twice/); });
  test('a wrong checksum', () => { refuses(makeZip([f('a.js', 'hello', { crc: 123 })]), /checksum/); });
  test('a size that is not the real size', () => { refuses(makeZip([f('a.js', 'hello', { size: 99 })]), /wrong size|could not be read/); });
  test('stored data of the wrong length', () => { refuses(makeZip([f('a.js', 'hello', { method: 0, size: 3 })]), /wrong size/); });
  test('something that is not a zip, and one that is cut short', () => { refuses(Buffer.from('not a zip at all, just text'), /not a zip/); refuses(makeZip([f('a.js')]).subarray(0, 30), /not a zip|damaged/); refuses(Buffer.alloc(10), /not a zip/); });
  test('an empty zip, or one with only folders and skipped files', () => { refuses(makeZip([]), /no files/); refuses(makeZip([f('d/', '', { mode: 0o040755 }), f('.DS_Store')]), /no files/); });
  test('more entries than the end record says it has, and a damaged directory', () => { refuses(makeZip([f('a.js'), f('b.js')], { eocdEntries: 5 }), /damaged/); });
  test('an end record that points outside the file', () => {
    const z = makeZip([f('a.js')]); z.writeUInt32LE(0xfffffff0 >>> 0, z.length - 6);
    expect(() => readZip(z)).toThrow(/damaged|ZIP64/);
  });
  test('ZIP64', () => { const z = makeZip([f('a.js')]); z.writeUInt16LE(0xffff, z.length - 14); z.writeUInt16LE(0xffff, z.length - 12); refuses(z, /ZIP64/); });

  test('a zip bomb: a few kilobytes that expand to hundreds of megabytes', () => {
    const big = Buffer.alloc(4 * 1024 * 1024);                   // 4 MB of zeros deflates to a few kilobytes
    refuses(makeZip([f('zeros.txt', '', { data: big })]), /expands too much/);
  });
  test('an entry that is really bigger than it says', () => {
    const real = Buffer.alloc(3 * 1024 * 1024);
    refuses(makeZip([{ name: 'lie.txt', data: real, size: 10 }]), /wrong size|could not be read|checksum/);
  });
  test('an entry, a whole archive and a file count over the limits', () => {
    const limits = { ...DEFAULT_ZIP_LIMITS, maxFileBytes: 1000, maxTotalBytes: 2500, maxFiles: 3, maxZipBytes: 100_000 };
    refuses(makeZip([f('big.txt', 'x'.repeat(2000))]), /larger than/, limits);
    refuses(makeZip([f('a', 'x'.repeat(900)), f('b', 'x'.repeat(900)), f('c', 'x'.repeat(900))]), /add up to more than/, limits);
    refuses(makeZip([f('a'), f('b'), f('c'), f('d')]), /more than 3 files/, limits);
    refuses(Buffer.alloc(200_000, 1), /larger than/, limits);
  });
  test('data that lies outside the file', () => {
    const z = makeZip([f('a.js', 'hello')]);
    const cd = z.readUInt32LE(z.length - 6);
    z.writeUInt32LE(0x7fffff, cd + 42);
    refuses(z, /damaged/);
  });
});

describe('what it reads is checked as it goes', () => {
  test('a real symlink made by the zip tool is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zipl-'));
    try {
      mkdirSync(join(dir, 'app'));
      writeFileSync(join(dir, 'app/a.js'), 'x'); symlinkSync('/etc/passwd', join(dir, 'app/link'));
      const z = spawnSync('zip', ['-qry', 'a.zip', 'app'], { cwd: dir });      // -y keeps the link as a link
      if (z.status !== 0) return;
      expect(() => readZip(readFileSync(join(dir, 'a.zip')))).toThrow(/symbolic link/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('crc32 matches the known value', () => { expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926); });
});
