import { createReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createInflateRaw } from 'node:zlib';
import { DEFAULT_LIMITS, type ArchiveLimits } from './limits.ts';

// A zip reader built for archives nobody has vetted. It never extracts to disk and never runs, opens or follows anything named inside: it reads bytes
// of the one file it is given (a temporary copy of the upload), at offsets it has checked, into memory it has bounded.
//
// What it refuses, and how:
//   * the archive as a whole (`ZipRefused`): not a zip, a comment or directory that does not fit the file, more entries than the limit, a directory larger
//     than the limit, several disks, or more inflated bytes in total than the limit;
//   * one entry (it is listed in `refused` with a reason, and never read): a name with a path out of the archive (`..`, a leading slash, a drive letter, a
//     backslash, a control character, an empty part), a symbolic link or any file that is not a plain file, encryption, a method other than stored and
//     deflate, a name that appears twice (both are refused: which one a reader sees must not depend on the reader), local data that overlaps another
//     entry's, a size over the per-entry limit, and a ratio of inflated to stored size over the limit.
//   * while reading: the inflated bytes must be exactly the size the directory declared, counted as they come. A zip bomb whose directory lies about
//     its size stops at the declared size plus one byte; one that tells the truth stops at the per-entry limit.

export type ZipRefusal =
  | 'not_a_zip'
  | 'corrupt'
  | 'multi_disk'
  | 'too_many_entries'
  | 'directory_too_large'
  | 'total_too_large'
  | 'unsafe_name'
  | 'symlink'
  | 'special_file'
  | 'encrypted'
  | 'unsupported_method'
  | 'duplicate_name'
  | 'overlapping_data'
  | 'entry_too_large'
  | 'compression_ratio'
  | 'size_mismatch';

export class ZipRefused extends Error {
  readonly code: ZipRefusal;
  constructor(code: ZipRefusal, message: string) {
    super(message);
    this.name = 'ZipRefused';
    this.code = code;
  }
}

export interface ZipEntry {
  /** The entry's name inside the archive, checked: relative, forward slashes, no `..`. */
  readonly name: string;
  readonly method: 0 | 8;
  readonly compressedSize: number;
  /** The size the directory declares after inflating; reading enforces it exactly. */
  readonly size: number;
  /** Offset of the entry's local header. */
  readonly offset: number;
}

export interface RefusedEntry {
  /** A name safe to show (control characters replaced, shortened); never used to open anything. */
  readonly name: string;
  readonly reason: ZipRefusal;
}

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOC_SIG = 0x07064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_NAME_BYTES = 512;
const MAX_NAME_DEPTH = 24;

// eslint-disable-next-line no-control-regex
const safeLabel = (name: string): string => name.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 80);

/** True for a name that stays inside the archive's own tree. Pure, so a test can hit it with every trick. */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || Buffer.byteLength(name) > MAX_NAME_BYTES) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  const parts = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
  if (parts.length > MAX_NAME_DEPTH) return false;
  return parts.every((p) => p !== '' && p !== '.' && p !== '..' && p.trim() === p && !/^\.+$/.test(p));
}

/** The names a Mac adds to an archive that carry nothing of the export: skipped without a word. */
const isJunk = (name: string): boolean => name.startsWith('__MACOSX/') || name.endsWith('/.DS_Store') || name === '.DS_Store' || name.endsWith('/Thumbs.db');

function decodeName(raw: Buffer, utf8Flag: boolean): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    // not UTF-8: only a name from an old tool without the UTF-8 flag may be read as Latin-1; with the flag it is corrupt
    if (utf8Flag) throw new ZipRefused('corrupt', 'An entry name is not valid text');
    return raw.toString('latin1');
  }
}

export class ZipArchive {
  readonly entries: readonly ZipEntry[];
  readonly refused: readonly RefusedEntry[];
  readonly #fh: FileHandle;
  readonly #path: string;
  readonly #size: number;
  readonly #limits: ArchiveLimits;
  readonly #byName: Map<string, ZipEntry>;
  /** Where the central directory starts: no entry's data may reach into it. */
  readonly #dirStart: number;

  private constructor(
    path: string,
    fh: FileHandle,
    size: number,
    limits: ArchiveLimits,
    entries: ZipEntry[],
    refused: RefusedEntry[],
    dirStart: number,
  ) {
    this.#path = path;
    this.#fh = fh;
    this.#size = size;
    this.#limits = limits;
    this.entries = entries;
    this.refused = refused;
    this.#byName = new Map(entries.map((e) => [e.name, e]));
    this.#dirStart = dirStart;
  }

  /** Opens and checks the archive at `path`. Throws `ZipRefused` when the archive as a whole cannot be trusted. */
  static async open(path: string, limits: ArchiveLimits = DEFAULT_LIMITS): Promise<ZipArchive> {
    const fh = await open(path, 'r');
    try {
      const size = (await fh.stat()).size;
      const parsed = await parseDirectory(fh, size, limits);
      return new ZipArchive(path, fh, size, limits, parsed.entries, parsed.refused, parsed.dirStart);
    } catch (err) {
      await fh.close().catch(() => undefined);
      throw err;
    }
  }

  find(name: string): ZipEntry | undefined {
    return this.#byName.get(name);
  }

  async close(): Promise<void> {
    await this.#fh.close().catch(() => undefined);
  }

  /** Where an entry's stored bytes start and end, after checking its local header against the directory. */
  async #dataRange(entry: ZipEntry): Promise<{ start: number; end: number }> {
    const head = Buffer.alloc(30);
    if (entry.offset + 30 > this.#size) throw new ZipRefused('corrupt', 'An entry starts outside the archive');
    const { bytesRead } = await this.#fh.read(head, 0, 30, entry.offset);
    if (bytesRead !== 30 || head.readUInt32LE(0) !== LOC_SIG) throw new ZipRefused('corrupt', 'An entry has no local header');
    const flags = head.readUInt16LE(6);
    if ((flags & 1) !== 0) throw new ZipRefused('encrypted', 'An entry is encrypted');
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    // the local name must be the directory's name: a reader that took one and a reader that took the other would see different files
    const nameBuf = Buffer.alloc(nameLen);
    const got = await this.#fh.read(nameBuf, 0, nameLen, entry.offset + 30);
    if (got.bytesRead !== nameLen || decodeName(nameBuf, (flags & 0x800) !== 0) !== entry.name) {
      throw new ZipRefused('corrupt', 'An entry has two different names');
    }
    const start = entry.offset + 30 + nameLen + extraLen;
    const end = start + entry.compressedSize;
    if (end > this.#dirStart || end > this.#size) throw new ZipRefused('corrupt', 'An entry runs past the end of the archive');
    return { start, end };
  }

  /**
   * The entry's inflated bytes, in chunks, as they are produced. At most `maxBytes` (default: the per-entry limit) and exactly the declared size:
   * anything else throws `ZipRefused` before more is held. Stop early by leaving the loop; the underlying streams are destroyed.
   */
  async *stream(entry: ZipEntry, maxBytes: number = this.#limits.maxEntryBytes): AsyncGenerator<Buffer> {
    if (entry.size > maxBytes) throw new ZipRefused('entry_too_large', 'An entry is larger than the limit');
    const { start, end } = await this.#dataRange(entry);
    if (entry.compressedSize === 0) {
      if (entry.size !== 0) throw new ZipRefused('size_mismatch', 'An entry is shorter than it says');
      return;
    }
    const raw = createReadStream(this.#path, { start, end: end - 1, highWaterMark: 256 * 1024 });
    const source = entry.method === 0 ? raw : raw.pipe(createInflateRaw());
    if (entry.method === 8) raw.on('error', (err) => source.destroy(err));
    let seen = 0;
    try {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        seen += chunk.length;
        // one byte past the declared size is enough to know the directory lied
        if (seen > entry.size) throw new ZipRefused('size_mismatch', 'An entry is longer than it says');
        yield chunk;
      }
    } catch (err) {
      if (err instanceof ZipRefused) throw err;
      throw new ZipRefused('corrupt', 'An entry could not be unpacked');
    } finally {
      raw.destroy();
      if (source !== raw) source.destroy();
    }
    if (seen !== entry.size) throw new ZipRefused('size_mismatch', 'An entry is shorter than it says');
  }

  /** The whole entry in memory (bounded by the per-entry limit and the declared size). */
  async read(entry: ZipEntry): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of this.stream(entry)) parts.push(chunk);
    return Buffer.concat(parts, entry.size);
  }
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new ZipRefused('corrupt', 'The archive is cut short');
  return buf;
}

async function parseDirectory(
  fh: FileHandle,
  fileSize: number,
  limits: ArchiveLimits,
): Promise<{ entries: ZipEntry[]; refused: RefusedEntry[]; dirStart: number }> {
  if (fileSize < 22) throw new ZipRefused('not_a_zip', 'That is not a zip file');
  // the end-of-directory record sits in the last 22 + 65535 bytes; a comment can contain the signature again, so take the one whose comment ends the file
  const tailLen = Math.min(fileSize, 22 + 0xffff);
  const tail = await readAt(fh, fileSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD_SIG && i + 22 + tail.readUInt16LE(i + 20) === tailLen) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipRefused('not_a_zip', 'That is not a zip file');
  const disk = tail.readUInt16LE(eocd + 4);
  const dirDisk = tail.readUInt16LE(eocd + 6);
  let count = tail.readUInt16LE(eocd + 10);
  let dirSize = tail.readUInt32LE(eocd + 12);
  let dirOffset = tail.readUInt32LE(eocd + 16);
  const eocdAt = fileSize - tailLen + eocd;
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    // zip64: a locator right before the record points at the 64-bit record
    if (eocdAt < 20) throw new ZipRefused('corrupt', 'The zip64 locator is missing');
    const loc = await readAt(fh, eocdAt - 20, 20);
    if (loc.readUInt32LE(0) !== EOCD64_LOC_SIG) throw new ZipRefused('corrupt', 'The zip64 locator is missing');
    const at64 = Number(loc.readBigUInt64LE(8));
    if (!Number.isSafeInteger(at64) || at64 + 56 > fileSize) throw new ZipRefused('corrupt', 'The zip64 record is outside the archive');
    const rec = await readAt(fh, at64, 56);
    if (rec.readUInt32LE(0) !== EOCD64_SIG) throw new ZipRefused('corrupt', 'The zip64 record is missing');
    if (rec.readUInt32LE(16) !== 0 || rec.readUInt32LE(20) !== 0) throw new ZipRefused('multi_disk', 'A zip in several parts is not supported');
    const c = rec.readBigUInt64LE(32);
    const s = rec.readBigUInt64LE(40);
    const o = rec.readBigUInt64LE(48);
    if (c > BigInt(limits.maxEntries)) throw new ZipRefused('too_many_entries', 'The archive has too many entries');
    if (s > BigInt(limits.maxDirectoryBytes)) throw new ZipRefused('directory_too_large', 'The archive directory is too large');
    if (o > BigInt(fileSize)) throw new ZipRefused('corrupt', 'The archive directory is outside the archive');
    count = Number(c);
    dirSize = Number(s);
    dirOffset = Number(o);
  } else if (disk !== 0 || dirDisk !== 0) {
    throw new ZipRefused('multi_disk', 'A zip in several parts is not supported');
  }
  if (count > limits.maxEntries) throw new ZipRefused('too_many_entries', 'The archive has too many entries');
  if (dirSize > limits.maxDirectoryBytes) throw new ZipRefused('directory_too_large', 'The archive directory is too large');
  if (dirOffset + dirSize > fileSize) throw new ZipRefused('corrupt', 'The archive directory is outside the archive');
  const dir = await readAt(fh, dirOffset, dirSize);

  const entries: ZipEntry[] = [];
  const refused: RefusedEntry[] = [];
  const nameCount = new Map<string, number>();
  const parsed: { name: string; label: string; entry: ZipEntry | null; reason: ZipRefusal | null }[] = [];
  let p = 0;
  let declaredTotal = 0;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== CEN_SIG) throw new ZipRefused('corrupt', 'The archive directory is damaged');
    const madeBy = dir.readUInt16LE(p + 4);
    const flags = dir.readUInt16LE(p + 8);
    const method = dir.readUInt16LE(p + 10);
    let compressed = dir.readUInt32LE(p + 20);
    let size = dir.readUInt32LE(p + 24);
    const nameLen = dir.readUInt16LE(p + 28);
    const extraLen = dir.readUInt16LE(p + 30);
    const commentLen = dir.readUInt16LE(p + 32);
    const externalAttr = dir.readUInt32LE(p + 38);
    let offset = dir.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > dir.length) throw new ZipRefused('corrupt', 'The archive directory is damaged');
    const nameRaw = dir.subarray(p + 46, p + 46 + nameLen);
    // zip64 sizes and offset live in the extra field, in the order size, compressed size, offset, for the fields that hold 0xFFFFFFFF
    if (size === 0xffffffff || compressed === 0xffffffff || offset === 0xffffffff) {
      let q = p + 46 + nameLen;
      const extraEnd = q + extraLen;
      while (q + 4 <= extraEnd) {
        const id = dir.readUInt16LE(q);
        const len = dir.readUInt16LE(q + 2);
        if (q + 4 + len > extraEnd) throw new ZipRefused('corrupt', 'The archive directory is damaged');
        if (id === 0x0001) {
          let r = q + 4;
          const take = (): number => {
            if (r + 8 > q + 4 + len) throw new ZipRefused('corrupt', 'The archive directory is damaged');
            const v = dir.readBigUInt64LE(r);
            r += 8;
            if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipRefused('corrupt', 'An entry is larger than any file');
            return Number(v);
          };
          if (size === 0xffffffff) size = take();
          if (compressed === 0xffffffff) compressed = take();
          if (offset === 0xffffffff) offset = take();
        }
        q += 4 + len;
      }
    }
    p = next;
    const name = decodeName(nameRaw, (flags & 0x800) !== 0);
    const label = safeLabel(name);
    const hostUnix = madeBy >>> 8 === 3;
    const mode = hostUnix ? (externalAttr >>> 16) & 0o170000 : 0;
    const isDir = name.endsWith('/');
    if (isDir || isJunk(name)) continue;
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
    let reason: ZipRefusal | null = null;
    if (!isSafeEntryName(name)) reason = 'unsafe_name';
    else if (mode === 0o120000) reason = 'symlink';
    else if (mode !== 0 && mode !== 0o100000) reason = 'special_file';
    else if ((flags & 0x41) !== 0) reason = 'encrypted';
    else if (method !== 0 && method !== 8) reason = 'unsupported_method';
    else if (size > limits.maxStreamEntryBytes) reason = 'entry_too_large';
    else if (method === 0 && compressed !== size) reason = 'size_mismatch';
    else if (size >= limits.ratioFloorBytes && size > Math.max(compressed, 1) * limits.maxRatio) reason = 'compression_ratio';
    else if (offset + 30 + nameLen + compressed > dirOffset) reason = 'corrupt';
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) throw new ZipRefused('total_too_large', 'The archive holds more than the limit once unpacked');
    parsed.push({
      name,
      label,
      reason,
      entry: reason ? null : { name, method: method as 0 | 8, compressedSize: compressed, size, offset },
    });
  }

  // a name that appears twice is refused in every copy; entries whose stored bytes overlap are refused too
  for (const e of parsed) if (e.reason === null && (nameCount.get(e.name) ?? 0) > 1) e.reason = 'duplicate_name';
  const live = parsed.filter((e) => e.reason === null && e.entry !== null).sort((a, b) => a.entry!.offset - b.entry!.offset);
  for (let i = 0; i < live.length; i += 1) {
    const cur = live[i]!.entry!;
    const next = live[i + 1]?.entry;
    if (next && next.offset < cur.offset + 30 + Buffer.byteLength(cur.name) + cur.compressedSize) {
      live[i]!.reason = 'overlapping_data';
      live[i + 1]!.reason = 'overlapping_data';
    }
  }
  for (const e of parsed) {
    if (e.reason !== null || e.entry === null) refused.push({ name: e.label, reason: e.reason ?? 'corrupt' });
    else entries.push(e.entry);
  }
  return { entries, refused, dirStart: dirOffset };
}
