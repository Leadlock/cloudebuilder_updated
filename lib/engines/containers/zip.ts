/** Minimal ZIP writer (stored, no compression) so the generated files download as one archive without a dependency. */
import type { GeneratedFile } from './dockerTemplates';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function buildZip(files: GeneratedFile[], folder: string): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const f of files) {
    const name = enc.encode(`${folder}/${f.path}`);
    const data = enc.encode(f.content);
    const crc = crc32(data);
    // 0x0800: names and contents are UTF-8. Time/date fixed so the archive is reproducible.
    const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
    const local = new Uint8Array([0x50, 0x4b, 3, 4, ...common, ...name]);
    chunks.push(local, data);
    // Unix (3) made-by and the file mode in the high 16 bits of the external attributes, so scripts stay executable after unzip.
    const madeBy = f.executable ? (3 << 8) | 20 : 20;
    const external = f.executable ? (0o100755 << 16) >>> 0 : 0;
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(madeBy), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(external), ...u32(offset), ...name]));
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of all) { out.set(c, pos); pos += c.length; }
  return out;
}
