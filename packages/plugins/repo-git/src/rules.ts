import { REPO_MAX_FILE_BYTES } from '@manythreads/shared';

// What the team repo holds (SPEC principle 8, section 5.1): text. Bytes that are not text, or are large, are attachments.

/** True when the bytes hold a NUL anywhere (a file is at most 1 MB, so the whole of it is looked at: 8 KB of text in front of binary data is still binary). */
export function hasNul(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

export type ContentVerdict = { ok: true } | { ok: false; reason: 'binary' | 'too_large' };

/** Not for the repo: larger than 1 MB, a NUL byte anywhere, or not valid UTF-8 (both linear). Callers check the size first, so the scan is bounded. */
export function checkRepoContent(bytes: Uint8Array): ContentVerdict {
  if (bytes.length > REPO_MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };
  if (hasNul(bytes)) return { ok: false, reason: 'binary' };
  if (!isUtf8(bytes)) return { ok: false, reason: 'binary' };
  return { ok: true };
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function isUtf8(bytes: Uint8Array): boolean {
  try {
    decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The text of a file for the search index, or null when it is not valid UTF-8, holds a NUL, or is over 1 MB. */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.length > REPO_MAX_FILE_BYTES) return null;
  try {
    const text = decoder.decode(bytes);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}
