import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ImportSource } from '@manythreads/shared';
import { DEFAULT_LIMITS, type ArchiveLimits } from './limits.ts';
import { MattermostReader } from './mattermost.ts';
import { ArchiveError, type ArchiveReader } from './model.ts';
import { SlackReader } from './slack.ts';
import { ZipArchive } from './zip.ts';

export { ArchiveError };

const isZipHead = (h: Uint8Array): boolean => h.length >= 4 && h[0] === 0x50 && h[1] === 0x4b && (h[2] === 0x03 || h[2] === 0x05) && (h[3] === 0x04 || h[3] === 0x06);
const isJsonLinesHead = (h: Uint8Array): boolean => {
  let i = h.length >= 3 && h[0] === 0xef && h[1] === 0xbb && h[2] === 0xbf ? 3 : 0;
  while (i < h.length && (h[i] === 0x20 || h[i] === 0x0a || h[i] === 0x0d || h[i] === 0x09)) i += 1;
  return h[i] === 0x7b;
};

/**
 * Whether the first bytes of an upload fit the chosen source: a zip for Slack; a zip or bare JSON lines for Mattermost. The upload route asks this
 * before the archive is kept, so a wrong file is refused at once. (The name and the content type the browser sent are never looked at.)
 */
export function looksLikeArchive(source: ImportSource, head: Uint8Array): boolean {
  return source === 'slack' ? isZipHead(head) : isZipHead(head) || isJsonLinesHead(head);
}

/** Opens the archive stored at `path` for reading. Throws `ArchiveError` (plain words) or `ZipRefused` for an archive that cannot be trusted. */
export async function openArchive(path: string, source: ImportSource, limits: ArchiveLimits = DEFAULT_LIMITS, now: () => number = Date.now): Promise<ArchiveReader> {
  const fh = await open(path, 'r');
  const head = Buffer.alloc(4096);
  let bytes: number;
  try {
    bytes = (await fh.read(head, 0, head.length, 0)).bytesRead;
  } finally {
    await fh.close();
  }
  const h = head.subarray(0, bytes);
  if (isZipHead(h)) {
    const zip = await ZipArchive.open(path, limits);
    if (source === 'slack') return new SlackReader(zip, limits, now);
    const lines = zip.entries
      .filter((e) => /\.jsonl?$/i.test(e.name) && e.name.split('/').length <= 2)
      .sort((a, b) => b.size - a.size)[0];
    if (!lines) {
      await zip.close();
      throw new ArchiveError('The zip has no JSON-lines file in it. A Mattermost export has one (usually export.jsonl).');
    }
    const names = new Set(zip.entries.map((e) => e.name));
    return new MattermostReader(() => zip.stream(lines, limits.maxStreamEntryBytes), () => zip.close(), {
      limits,
      now,
      hasFile: (p) => names.has(p) || names.has(`data/${p}`),
    });
  }
  if (source === 'mattermost' && isJsonLinesHead(h)) {
    return new MattermostReader(() => createReadStream(path, { highWaterMark: 256 * 1024 }), () => Promise.resolve(), { limits, now });
  }
  throw new ArchiveError(source === 'slack' ? 'That is not a Slack export: a Slack export is a zip file.' : 'That is not a Mattermost export: it is a JSON-lines file, or a zip with one.');
}
