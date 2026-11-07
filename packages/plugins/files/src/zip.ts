import { crc32 } from 'node:zlib';

// A ZIP writer that streams: stored (no compression), each entry's size and checksum written after its bytes (a "data descriptor"), so no file is held in
// memory. Names are UTF-8. When the archive could pass the old format's limits (4 GiB, 65,535 entries) every entry is written in the "zip64" form.

export interface ZipEntry {
  /** Forward slashes, no leading slash, no `..`. A trailing slash makes an empty folder. */
  name: string;
  /** Size the bytes are expected to have; used only to choose between the plain and the zip64 form. */
  size: number;
  /** The bytes, opened when the entry is reached. Absent for a folder. */
  open?: () => Promise<AsyncIterable<Uint8Array>>;
  modified?: Date;
}

const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const MAX32 = 0xffffffff;

const dosTime = (d: Date): { time: number; date: number } => ({
  time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  date: (Math.max(d.getUTCFullYear() - 1980, 0) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
});

const u16 = (v: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const u32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const u64 = (v: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

/** True when the archive might not fit the plain form: the sum of sizes plus a generous allowance for headers is near 4 GiB, or too many entries. */
export function needsZip64(entries: ZipEntry[]): boolean {
  let total = 0;
  for (const e of entries) total += e.size + 200 + Buffer.byteLength(e.name) * 2;
  return entries.length >= 0xfff0 || total >= MAX32 - 1024 * 1024;
}

export async function* zipStream(entries: ZipEntry[], now: Date = new Date()): AsyncGenerator<Buffer> {
  const zip64 = needsZip64(entries);
  const central: Buffer[] = [];
  let offset = 0;
  const emit = (b: Buffer): Buffer => {
    offset += b.length;
    return b;
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const { time, date } = dosTime(entry.modified ?? now);
    const isFolder = entry.name.endsWith('/');
    const flags = isFolder ? 0x0800 : 0x0808; // bit 11: UTF-8 names; bit 3: the sizes follow the bytes (not for a folder)
    const localOffset = offset;
    const extra = zip64 ? Buffer.concat([u16(1), u16(16), u64(0), u64(0)]) : Buffer.alloc(0);
    yield emit(
      Buffer.concat([u32(LOCAL), u16(zip64 ? 45 : 20), u16(flags), u16(0), u16(time), u16(date), u32(0), u32(zip64 ? MAX32 : 0), u32(zip64 ? MAX32 : 0), u16(name.length), u16(extra.length), name, extra]),
    );
    let crc = 0;
    let size = 0;
    if (entry.open && !isFolder) {
      for await (const chunk of await entry.open()) {
        const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        crc = crc32(buf, crc);
        size += buf.length;
        yield emit(buf);
      }
    }
    if (!zip64 && size > MAX32) throw new Error('a file grew past the plain zip limit while it was being read');
    if (!isFolder) {
      yield emit(zip64 ? Buffer.concat([u32(DESCRIPTOR), u32(crc), u64(size), u64(size)]) : Buffer.concat([u32(DESCRIPTOR), u32(crc), u32(size), u32(size)]));
    }
    const centralExtra = zip64 ? Buffer.concat([u16(1), u16(24), u64(size), u64(size), u64(localOffset)]) : Buffer.alloc(0);
    central.push(
      Buffer.concat([
        u32(CENTRAL), u16(zip64 ? 45 : 20), u16(zip64 ? 45 : 20), u16(flags), u16(0), u16(time), u16(date), u32(crc),
        u32(zip64 ? MAX32 : size), u32(zip64 ? MAX32 : size), u16(name.length), u16(centralExtra.length), u16(0), u16(0), u16(0),
        u32(isFolder ? 0x10 : 0), u32(zip64 ? MAX32 : localOffset), name, centralExtra,
      ]),
    );
  }
  const centralStart = offset;
  for (const c of central) yield emit(c);
  const centralSize = offset - centralStart;
  if (zip64) {
    const end64At = offset;
    yield emit(Buffer.concat([u32(END64), u64(44), u16(45), u16(45), u32(0), u32(0), u64(central.length), u64(central.length), u64(centralSize), u64(centralStart)]));
    yield emit(Buffer.concat([u32(LOCATOR64), u32(0), u64(end64At), u32(1)]));
  }
  yield emit(
    Buffer.concat([u32(END), u16(0), u16(0), u16(zip64 ? 0xffff : central.length), u16(zip64 ? 0xffff : central.length), u32(zip64 ? MAX32 : centralSize), u32(zip64 ? MAX32 : centralStart), u16(0)]),
  );
}
