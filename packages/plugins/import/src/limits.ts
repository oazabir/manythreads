import { IMPORT_MAX_BYTES_DEFAULT } from '@manythreads/shared';

// Every bound the import reads an archive within. An archive is untrusted data from outside: a number here is a promise about how much memory, disk and
// time one upload can cost. They are plain constants (a test passes smaller ones) except the upload size, which an operator may set.

export interface ArchiveLimits {
  /** Entries in the zip's central directory. A Slack export of a large workspace has a few thousand (one file per channel and day). */
  maxEntries: number;
  /** Bytes of the central directory itself. */
  maxDirectoryBytes: number;
  /** One entry's text after inflating. A day of one channel is far below this. */
  maxEntryBytes: number;
  /** A line-based export inside a zip (Mattermost's one big file) may be larger than a day file. */
  maxStreamEntryBytes: number;
  /** Everything the archive says it holds after inflating, added up. */
  maxTotalBytes: number;
  /** An entry of at least `ratioFloorBytes` that inflates to more than this many times its stored size is a bomb. */
  maxRatio: number;
  ratioFloorBytes: number;
  /** Longest line of a JSON-lines archive; a longer one is dropped without being kept in memory. */
  maxLineBytes: number;
  /** Deepest nesting of arrays and objects in one JSON value. */
  maxJsonDepth: number;
  /** People, channels and channel memberships a Mattermost export may list before it is refused (they are kept in memory for the whole run). */
  maxPeople: number;
  maxChannels: number;
  maxMemberships: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: 200_000,
  maxDirectoryBytes: 64 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxStreamEntryBytes: 4 * 1024 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxRatio: 200,
  ratioFloorBytes: 1024 * 1024,
  maxLineBytes: 4 * 1024 * 1024,
  maxJsonDepth: 64,
  maxPeople: 200_000,
  maxChannels: 100_000,
  maxMemberships: 2_000_000,
};

/** The largest upload (bytes). `MANYTHREADS_IMPORT_MAX_BYTES` sets it per server, read per request so an operator or a test can change it. */
export function importMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env['MANYTHREADS_IMPORT_MAX_BYTES']);
  return Number.isSafeInteger(v) && v > 0 ? v : IMPORT_MAX_BYTES_DEFAULT;
}

/** Messages written in one database transaction. A job that is cut off loses at most this many and writes them again on the next attempt. */
export const BATCH_SIZE = 100;
/** The report lists at most this many channels by name. */
export const CHANNEL_LINES_MAX = 200;
