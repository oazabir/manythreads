import { REPO_BINARY_SNIFF_BYTES, REPO_MAX_FILE_BYTES } from '@manythreads/shared';

// What the team repo holds (SPEC principle 8, section 5.1): text. Bytes that are not text, or are large, are attachments.

/** True when the first 8 KB hold a NUL byte, the usual sign of binary data. */
export function hasNul(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, REPO_BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) if (bytes[i] === 0) return true;
  return false;
}

export type ContentVerdict = { ok: true } | { ok: false; reason: 'binary' | 'too_large' };

/** Binary (a NUL byte in the first 8 KB) or larger than 1 MB: not for the repo. */
export function checkRepoContent(bytes: Uint8Array): ContentVerdict {
  if (bytes.length > REPO_MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };
  if (hasNul(bytes)) return { ok: false, reason: 'binary' };
  return { ok: true };
}

const decoder = new TextDecoder('utf-8', { fatal: true });

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
