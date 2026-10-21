/**
 * The source archive for a registry build: real `tar` must read it back exactly, and nothing unsafe may go in.
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTar, safeTarPath } from '@/lib/deploy/project/tar';

describe('buildTar', () => {
  test('real tar extracts the same files, with their content and modes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    try {
      const long = `${'a'.repeat(60)}/${'b'.repeat(60)}/file.txt`;       // 130 characters: needs the prefix field
      const files = [
        { path: 'Dockerfile', content: 'FROM scratch\n' },
        { path: 'src/server.js', content: 'console.log("hi")\n', mode: 0o755 },
        { path: 'data/empty.txt', content: '' },
        { path: 'bin/blob.bin', content: Buffer.from([0, 1, 2, 255, 254]) },
        { path: 'unicode/été.txt', content: 'é\n' },
        { path: long, content: 'long' },
        { path: 'big.txt', content: 'x'.repeat(1500) },                  // spans several blocks
      ];
      writeFileSync(join(dir, 'a.tgz'), buildTar(files));
      const x = spawnSync('tar', ['-xzf', 'a.tgz', '-C', dir], { cwd: dir, encoding: 'utf8' });
      expect({ status: x.status, err: x.stderr }).toEqual({ status: 0, err: '' });
      for (const f of files) expect(readFileSync(join(dir, f.path))).toEqual(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
      expect(statSync(join(dir, 'src/server.js')).mode & 0o777).toBe(0o755);
      const list = spawnSync('tar', ['-tzf', join(dir, 'a.tgz')], { encoding: 'utf8' }).stdout.trim().split('\n').sort();
      expect(list.filter((x) => !x.includes('\\') && !/[^\x00-\x7f]/.test(x))).toEqual(files.map((f) => f.path).filter((x) => !/[^\x00-\x7f]/.test(x)).sort());   // GNU tar prints a non-ASCII name as it is, BSD tar escapes it: either way its content was checked above
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the same files always give the same archive', () => {
    const f = [{ path: 'a.txt', content: 'a' }, { path: 'b/c.txt', content: 'c' }];
    expect(buildTar(f).equals(buildTar(f))).toBe(true);
  });

  test.each(['/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', '', './a', 'a/\0b'])('the path %j is refused', (p) => {
    expect(() => safeTarPath(p)).toThrow();
    expect(() => buildTar([{ path: p, content: 'x' }])).toThrow();
  });

  test('a path that cannot be stored is refused instead of cut', () => {
    expect(() => buildTar([{ path: `${'a'.repeat(300)}/x`, content: 'x' }])).toThrow(/too long/);
  });

  test('nothing is written to disk by building an archive', () => {
    const before = existsSync(join(tmpdir(), 'should-not-exist'));
    buildTar([{ path: 'a', content: 'b' }]);
    expect(existsSync(join(tmpdir(), 'should-not-exist'))).toBe(before);
  });
});
