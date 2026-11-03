import { crc32, inflateRawSync } from 'node:zlib';
import type { DigestImportRefusal } from '@manythreads/shared';

// A zip read for a bundle another party made (PLAN P8-25). Nothing here trusts the file: every offset and length is bounds-checked before it is used, sizes are capped
// before anything is inflated, and the inflated size must equal the size the file declares. The reader refuses what a bundle of Markdown never needs: encrypted entries,
// zip64, a method that is not "stored" or "deflated", a link or a device file, a name that is not UTF-8, two entries with one name, and a local header that disagrees with
// the central directory (the usual way to show one file to a scanner and another to a reader). It is written here, and does not use the inbox's own reader, because that one
// hides the entry's file type and so cannot see a symbolic link.

export interface ZipLimits {
  /** The most entries (files and folders) the archive may list. */
  maxEntries: number;
  /** The most bytes in all the files once inflated. */
  maxTotalBytes: number;
  /** The most bytes in one file once inflated. */
  maxFileBytes: number;
}

export class ZipRefusal extends Error {
  readonly code: DigestImportRefusal;
  constructor(code: DigestImportRefusal, message: string) {
    super(message);
    this.name = 'ZipRefusal';
    this.code = code;
  }
}

const refuse = (code: DigestImportRefusal, message: string): never => {
  throw new ZipRefusal(code, message);
};

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_FIXED = 46;
const LOCAL_FIXED = 30;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeName(raw: Uint8Array): string {
  try {
    return utf8.decode(raw);
  } catch {
    return refuse('not_utf8', 'A file name in the zip is not valid UTF-8.');
  }
}

interface CentralEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  csize: number;
  usize: number;
  localOffset: number;
  isDir: boolean;
}

/** Reads the files of a zip as text, or throws a `ZipRefusal` that says why the whole archive is refused. A folder entry is skipped; nothing else is dropped silently. */
export function readZipText(bytes: Uint8Array, limits: ZipLimits): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = bytes.byteLength;
  if (total < EOCD_SIZE) return refuse('not_a_bundle', 'The file is not a zip.');

  // the end-of-central-directory record: the last 22 bytes plus a comment of up to 65535 bytes
  let eocd = -1;
  for (let i = total - EOCD_SIZE; i >= Math.max(0, total - EOCD_SIZE - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return refuse('not_a_bundle', 'The file is not a zip.');
  const diskNo = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const entriesHere = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return refuse('not_a_bundle', 'Zip64 archives are not accepted.');
  if (diskNo !== 0 || cdDisk !== 0 || entriesHere !== entryCount) return refuse('not_a_bundle', 'A zip in several parts is not accepted.');
  if (entryCount > limits.maxEntries) return refuse('too_many_files', `The zip lists ${entryCount} entries; the most is ${limits.maxEntries}.`);
  if (cdOffset + cdSize > eocd) return refuse('not_a_bundle', 'The zip’s directory is damaged.');

  // the central directory
  const entries: CentralEntry[] = [];
  let pos = cdOffset;
  let declaredTotal = 0;
  const seen = new Set<string>();
  for (let n = 0; n < entryCount; n += 1) {
    if (pos + CENTRAL_FIXED > cdOffset + cdSize || view.getUint32(pos, true) !== CENTRAL_SIG) return refuse('not_a_bundle', 'The zip’s directory is damaged.');
    const madeBy = view.getUint16(pos + 4, true);
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const csize = view.getUint32(pos + 20, true);
    const usize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const extAttr = view.getUint32(pos + 38, true);
    const localOffset = view.getUint32(pos + 42, true);
    const end = pos + CENTRAL_FIXED + nameLen + extraLen + commentLen;
    if (end > cdOffset + cdSize) return refuse('not_a_bundle', 'The zip’s directory is damaged.');
    const name = decodeName(bytes.subarray(pos + CENTRAL_FIXED, pos + CENTRAL_FIXED + nameLen));
    pos = end;

    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) return refuse('encrypted', 'The zip has an encrypted file, which cannot be read.');
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) return refuse('not_a_bundle', 'Zip64 archives are not accepted.');
    if (seen.has(name)) return refuse('unsafe_path', 'Two files in the zip have the same name.');
    seen.add(name);

    // the file type, when the archive was made on a Unix system (host 3): the top 16 bits of the external attributes are st_mode
    const host = madeBy >> 8;
    const type = host === 3 ? (extAttr >>> 16) & S_IFMT : 0;
    const isDir = name.endsWith('/');
    if (host === 3 && type !== 0 && type !== S_IFREG && type !== S_IFDIR) return refuse('link_entry', `“${name.slice(0, 80)}” is a link or a special file, which a bundle may not contain.`);
    if (type === S_IFDIR && !isDir) return refuse('link_entry', `“${name.slice(0, 80)}” is not a plain file.`);
    // a Windows reparse point (a link) is marked in the low attribute bits of an archive made there
    if (host === 10 && (extAttr & 0x400) !== 0) return refuse('link_entry', `“${name.slice(0, 80)}” is a link, which a bundle may not contain.`);
    if (isDir) continue;

    if (method !== 0 && method !== 8) return refuse('not_a_bundle', 'The zip uses a compression method that is not accepted.');
    if (usize > limits.maxFileBytes) return refuse('too_large', `“${name.slice(0, 80)}” is larger than ${limits.maxFileBytes} bytes.`);
    declaredTotal += usize;
    if (declaredTotal > limits.maxTotalBytes) return refuse('too_large', `The files in the zip add up to more than ${limits.maxTotalBytes} bytes.`);
    if (method === 0 && csize !== usize) return refuse('not_a_bundle', 'The zip is damaged: a stored file has two sizes.');
    entries.push({ name, method, flags, crc, csize, usize, localOffset, isDir });
  }

  const out = new Map<string, string>();
  for (const entry of entries) {
    const at = entry.localOffset;
    if (at + LOCAL_FIXED > cdOffset || view.getUint32(at, true) !== LOCAL_SIG) return refuse('not_a_bundle', 'The zip is damaged: a file’s header is missing.');
    const localFlags = view.getUint16(at + 6, true);
    if ((localFlags & 0x1) !== 0 || (localFlags & 0x40) !== 0) return refuse('encrypted', 'The zip has an encrypted file, which cannot be read.');
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const nameEnd = at + LOCAL_FIXED + nameLen;
    if (nameEnd + extraLen > cdOffset) return refuse('not_a_bundle', 'The zip is damaged: a file’s header is cut short.');
    // the name in the local header must be the name in the directory: otherwise two readers would see two different files
    const localName = decodeName(bytes.subarray(at + LOCAL_FIXED, nameEnd));
    if (localName !== entry.name) return refuse('unsafe_path', 'A file’s name in the zip does not match its directory entry.');
    const dataStart = nameEnd + extraLen;
    const dataEnd = dataStart + entry.csize;
    if (dataEnd > cdOffset) return refuse('not_a_bundle', 'The zip is damaged: a file’s data runs past the end.');
    const raw = bytes.subarray(dataStart, dataEnd);
    let data: Uint8Array;
    if (entry.method === 0) data = raw;
    else {
      try {
        // never more than the size the file declares: a bomb is stopped at that size, not after it has filled the memory
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.usize) });
      } catch {
        return refuse('too_large', `“${entry.name.slice(0, 80)}” does not inflate to the size it declares.`);
      }
    }
    if (data.byteLength !== entry.usize) return refuse('not_a_bundle', `“${entry.name.slice(0, 80)}” does not have the size it declares.`);
    if (crc32(data) !== entry.crc) return refuse('not_a_bundle', `“${entry.name.slice(0, 80)}” is damaged (its checksum does not match).`);
    let text: string;
    try {
      text = utf8.decode(data);
    } catch {
      return refuse('not_utf8', `“${entry.name.slice(0, 80)}” is not valid UTF-8 text.`);
    }
    if (text.includes('\0')) return refuse('not_utf8', `“${entry.name.slice(0, 80)}” holds a NUL character, so it is not text.`);
    out.set(entry.name, text);
  }
  return out;
}
