/**
 * The zip CodeBuild is given: real unzip and the project's own reader must both read it back exactly, binary files included.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSourceZip } from '@/lib/deploy/project/zipWriter';
import { readZip } from '@/lib/deploy/project/zip';

const files = [
  { path: 'Dockerfile', content: 'FROM scratch\n' },
  { path: 'src/server.js', content: 'console.log("hi")\n'.repeat(200) },          // compresses
  { path: 'bin/blob.bin', content: Buffer.from([0, 1, 2, 255, 254, 128]) },        // does not
  { path: 'empty.txt', content: '' },
  { path: 'unicode/été.txt', content: 'é\n' },
];

describe('buildSourceZip', () => {
  test('the project\'s own reader gets every file back, byte for byte', () => {
    const r = readZip(buildSourceZip(files));
    expect(r.files.map((f) => f.path)).toEqual(files.map((f) => f.path));
    for (const f of files) expect(r.files.find((x) => x.path === f.path)!.content).toEqual(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
  });
  test('real unzip reads it and finds nothing wrong', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zw-'));
    try {
      writeFileSync(join(dir, 'a.zip'), buildSourceZip(files));
      const t = spawnSync('unzip', ['-tq', 'a.zip'], { cwd: dir, encoding: 'utf8' });
      if (t.error) return;                                                         // no unzip on this machine: the reader above covers the format
      expect(t.status).toBe(0);
      expect(spawnSync('unzip', ['-qo', 'a.zip', '-d', 'out'], { cwd: dir }).status).toBe(0);
      expect(readFileSync(join(dir, 'out/src/server.js'), 'utf8')).toBe('console.log("hi")\n'.repeat(200));
      expect(readFileSync(join(dir, 'out/bin/blob.bin'))).toEqual(Buffer.from([0, 1, 2, 255, 254, 128]));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('the same files give the same zip, and an unsafe path is refused', () => {
    expect(buildSourceZip(files).equals(buildSourceZip(files))).toBe(true);
    for (const path of ['../x', '/etc/x', 'a/../b', 'a\\b']) expect(() => buildSourceZip([{ path, content: 'x' }])).toThrow();
  });
});
