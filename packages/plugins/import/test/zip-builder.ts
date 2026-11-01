import { deflateRawSync } from 'node:zlib';

// A zip writer for tests. It writes ordinary archives for the fixtures and, by its options, the broken and hostile ones the reader must survive: a
// directory that lies about sizes, names that climb out of the archive, symbolic links, duplicate names, encrypted entries, a zip64 tail.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export interface ZipItem {
  name: string;
  data?: Uint8Array | string;
  /** 0 stored, 8 deflate (default). */
  method?: number;
  /** Unix file mode including the type bits (0o120777 is a symbolic link). Default 0o100644. */
  mode?: number;
  flags?: number;
  /** What the directory says the inflated size is, when it should lie. */
  declaredSize?: number;
  /** What the directory says the stored size is, when it should lie. */
  declaredCompressed?: number;
  /** The name written in the local header, when it should differ from the directory's. */
  localName?: string;
  /** Write the directory's offset as this value. */
  offset?: number;
  /** The name as raw bytes (for names that are not valid text). */
  rawName?: Buffer;
}

export interface ZipOptions {
  comment?: string;
  /** Write a zip64 end record and locator and put 0xFFFF / 0xFFFFFFFF in the ordinary one. */
  zip64?: boolean;
  /** Claim this many entries in the end record. */
  claimEntries?: number;
}

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export function buildZip(items: readonly ZipItem[], options: ZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const raw = item.data === undefined ? Buffer.alloc(0) : Buffer.from(item.data);
    const method = item.method ?? 8;
    const stored = method === 8 ? deflateRawSync(raw) : raw;
    const name = item.rawName ?? Buffer.from(item.name, 'utf8');
    const localName = item.localName !== undefined ? Buffer.from(item.localName, 'utf8') : name;
    const flags = item.flags ?? 0x800;
    const crc = crc32(raw);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0x21), u32(crc), u32(stored.length), u32(raw.length),
      u16(localName.length), u16(0), localName,
    ]);
    const at = item.offset ?? offset;
    central.push(
      Buffer.concat([
        u32(0x02014b50), u16((3 << 8) | 20), u16(20), u16(flags), u16(method), u16(0), u16(0x21), u32(crc),
        u32(item.declaredCompressed ?? stored.length), u32(item.declaredSize ?? raw.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(((item.mode ?? 0o100644) << 16) >>> 0), u32(at), name,
      ]),
    );
    parts.push(local, stored);
    offset += local.length + stored.length;
  }
  const dir = Buffer.concat(central);
  const comment = Buffer.from(options.comment ?? '', 'utf8');
  const count = options.claimEntries ?? items.length;
  const tail: Buffer[] = [];
  if (options.zip64) {
    const at64 = offset + dir.length;
    tail.push(
      Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(count), u64(count), u64(dir.length), u64(offset)]),
      Buffer.concat([u32(0x07064b50), u32(0), u64(at64), u32(1)]),
      Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff), u16(comment.length), comment]),
    );
  } else {
    tail.push(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(dir.length), u32(offset), u16(comment.length), comment]));
  }
  return Buffer.concat([...parts, dir, ...tail]);
}
