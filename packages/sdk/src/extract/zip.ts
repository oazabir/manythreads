import { inflateRawSync } from 'node:zlib';
import { ExtractError } from './types.ts';

// A zip reader for Office files, in memory and bounded (PLAN P8-16). A .docx, .pptx or .xlsx is a zip of XML parts; this reads the central directory and
// inflates only the few parts a reader asks for by exact name. It never writes to disk, never follows a name anywhere (names are only looked up, not used
// as paths), and refuses what looks like a bomb:
//   * more than `MAX_ENTRIES` entries or a central directory over `MAX_DIRECTORY_BYTES` (the archive as a whole);
//   * an encrypted entry, a method other than stored and deflate, local data that lies outside the file;
//   * an entry whose declared size is over `maxEntryBytes`, or whose ratio of inflated to stored size is over `MAX_RATIO` (checked before inflating);
//   * an entry that inflates to more than it declared (the inflater is given the declared size as its output cap, so it stops there);
//   * more than `maxTotalBytes` inflated across all the parts read from one archive.
// It runs inside the extraction worker, so a part that is slow to inflate costs that thread only and the host stops it at the time limit.

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_ENTRIES = 10_000;
const MAX_DIRECTORY_BYTES = 4 * 1024 * 1024;
const MAX_RATIO = 400;
const MAX_NAME_BYTES = 512;

export interface ZipLimits {
  /** Most bytes one part may inflate to. */
  maxEntryBytes: number;
  /** Most bytes all parts read from one archive may inflate to. */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntryBytes: 24 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };

interface Entry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

export class ZipArchive {
  private readonly view: DataView;
  private readonly entries = new Map<string, Entry>();
  private total = 0;
  private readonly bytes: Uint8Array;
  private readonly limits: ZipLimits;

  constructor(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS) {
    this.bytes = bytes;
    this.limits = limits;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.readDirectory();
  }

  private readDirectory(): void {
    const len = this.bytes.length;
    if (len < 22) throw new ExtractError('This file is not a readable Office document.');
    // the end-of-directory record sits in the last 64 KB plus 22 bytes (a comment may follow it)
    let eocd = -1;
    const stop = Math.max(0, len - 22 - 65_535);
    for (let i = len - 22; i >= stop; i--) {
      if (this.view.getUint32(i, true) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new ExtractError('This file is not a readable Office document.');
    if (this.view.getUint16(eocd + 4, true) !== 0 || this.view.getUint16(eocd + 6, true) !== 0) throw new ExtractError('This file is spread over several parts, which cannot be read.');
    const count = this.view.getUint16(eocd + 10, true);
    const size = this.view.getUint32(eocd + 12, true);
    const start = this.view.getUint32(eocd + 16, true);
    if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ExtractError('This file is too large or too complex to read.');
    if (count > MAX_ENTRIES) throw new ExtractError('This file holds too many parts to read.');
    if (size > MAX_DIRECTORY_BYTES || start + size > eocd) throw new ExtractError('This file is not a readable Office document.');
    let p = start;
    const end = start + size;
    for (let i = 0; i < count; i++) {
      if (p + 46 > end || this.view.getUint32(p, true) !== CEN_SIG) throw new ExtractError('This file is not a readable Office document.');
      const flags = this.view.getUint16(p + 8, true);
      const method = this.view.getUint16(p + 10, true);
      const compressed = this.view.getUint32(p + 20, true);
      const size32 = this.view.getUint32(p + 24, true);
      const nameLen = this.view.getUint16(p + 28, true);
      const extraLen = this.view.getUint16(p + 30, true);
      const commentLen = this.view.getUint16(p + 32, true);
      const offset = this.view.getUint32(p + 42, true);
      if (nameLen > MAX_NAME_BYTES || p + 46 + nameLen + extraLen + commentLen > end) throw new ExtractError('This file is not a readable Office document.');
      const name = new TextDecoder('utf-8').decode(this.bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;
      // the first entry of a name wins, and a repeated name is refused: which one a reader sees must not depend on the reader
      if (this.entries.has(name)) throw new ExtractError('This file is not a readable Office document.');
      this.entries.set(name, { name, method: flags & 1 ? -1 : method, compressed, size: size32, offset });
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** The names that start with `prefix`, sorted in plain code-unit order. */
  names(prefix: string): string[] {
    return [...this.entries.keys()].filter((n) => n.startsWith(prefix)).sort();
  }

  /** The inflated bytes of one part, or null when the archive has no such part. Refuses a bomb with a plain reason. */
  read(name: string): Uint8Array | null {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.method === -1) throw new ExtractError('This file is protected with a password.');
    if (e.method !== 0 && e.method !== 8) throw new ExtractError('This file uses a compression this reader does not know.');
    if (e.size > this.limits.maxEntryBytes) throw new ExtractError('A part of this file is too large to read.');
    if (this.total + e.size > this.limits.maxTotalBytes) throw new ExtractError('This file expands to too much text to read.');
    if (e.compressed > 0 && e.size / e.compressed > MAX_RATIO && e.size > 1024 * 1024) throw new ExtractError('This file is packed in a way that looks like a zip bomb, so it was not opened.');
    const o = e.offset;
    if (o + 30 > this.bytes.length || this.view.getUint32(o, true) !== LOC_SIG) throw new ExtractError('This file is not a readable Office document.');
    const nameLen = this.view.getUint16(o + 26, true);
    const extraLen = this.view.getUint16(o + 28, true);
    const dataStart = o + 30 + nameLen + extraLen;
    if (dataStart + e.compressed > this.bytes.length) throw new ExtractError('This file is not a readable Office document.');
    const stored = this.bytes.subarray(dataStart, dataStart + e.compressed);
    let out: Uint8Array;
    if (e.method === 0) {
      if (stored.length !== e.size) throw new ExtractError('This file is not a readable Office document.');
      out = stored;
    } else {
      try {
        // the declared size is the output cap: an entry that inflates to more throws instead of growing
        out = inflateRawSync(stored, { maxOutputLength: Math.max(1, e.size) });
      } catch {
        throw new ExtractError('This file is damaged or is packed in a way that looks like a zip bomb, so it was not opened.');
      }
      if (out.length !== e.size) throw new ExtractError('This file is not a readable Office document.');
    }
    this.total += out.length;
    return out;
  }
}
