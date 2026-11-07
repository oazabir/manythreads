import { crc32, inflateRawSync } from 'node:zlib';

// A small reader for the zips the files plugin writes (stored or deflated entries, plain or zip64), for tests: it checks every checksum.

export interface ReadEntry {
  name: string;
  data: Buffer;
}

export function readZip(zip: Buffer): ReadEntry[] {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('no end-of-archive record');
  let count = zip.readUInt16LE(end + 10);
  let centralStart = zip.readUInt32LE(end + 16);
  if (count === 0xffff || centralStart === 0xffffffff) {
    const locator = end - 20;
    if (zip.readUInt32LE(locator) !== 0x07064b50) throw new Error('zip64 locator missing');
    const rec = Number(zip.readBigUInt64LE(locator + 8));
    if (zip.readUInt32LE(rec) !== 0x06064b50) throw new Error('zip64 end record missing');
    count = Number(zip.readBigUInt64LE(rec + 32));
    centralStart = Number(zip.readBigUInt64LE(rec + 48));
  }
  const out: ReadEntry[] = [];
  let p = centralStart;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header ${i}`);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    let csize = zip.readUInt32LE(p + 20);
    let usize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    let offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const extra = zip.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    if (usize === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) {
      let q = 0;
      while (q + 4 <= extra.length) {
        const id = extra.readUInt16LE(q);
        const len = extra.readUInt16LE(q + 2);
        if (id === 1) {
          let r = q + 4;
          if (usize === 0xffffffff) { usize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (csize === 0xffffffff) { csize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (offset === 0xffffffff) offset = Number(extra.readBigUInt64LE(r));
        }
        q += 4 + len;
      }
    }
    if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const dataStart = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const raw = zip.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== usize) throw new Error(`${name}: size ${data.length} is not ${usize}`);
    if (crc32(data) !== crc) throw new Error(`${name}: checksum mismatch`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
