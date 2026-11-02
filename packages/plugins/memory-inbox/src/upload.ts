// The streamed upload, as MISTAKES.md teaches it (the knowledge plugin's upload is the same shape): a body being read holds a connection, so each person and the
// process as a whole may have only a few at once, a sender that stalls or takes too long is cut off, the size cap is checked from the declared length before a
// byte is read and again while the stream is stored, and a refused body is drained (a little, and not for long) so the refusal can still be sent.

const intEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isSafeInteger(v) && v > 0 ? v : fallback;
};
export const uploadIdleMs = (): number => intEnv('MANYTHREADS_UPLOAD_IDLE_MS', 20_000);
export const uploadMaxMs = (): number => intEnv('MANYTHREADS_UPLOAD_MAX_MS', 600_000);
/** The server's own cap on one drop, in bytes: a team's `memory.inbox.maxBytes` can only lower it. */
export const inboxMaxBytes = (): number => intEnv('MANYTHREADS_INBOX_MAX_BYTES', 25 * 1024 * 1024);
/** Drops one person may make in a minute (in process memory, never in the database). */
export const dropsPerMinute = (): number => intEnv('MANYTHREADS_INBOX_DROPS_PER_MINUTE', 20);

const MAX_UPLOADS_PER_ACTOR = 2;
const MAX_UPLOADS_IN_FLIGHT = 4;

const uploadsByActor = new Map<string, number>();
let uploadsInFlight = 0;
export function takeUploadSlot(actorId: string): (() => void) | null {
  const mine = uploadsByActor.get(actorId) ?? 0;
  if (uploadsInFlight >= MAX_UPLOADS_IN_FLIGHT || mine >= MAX_UPLOADS_PER_ACTOR) return null;
  uploadsInFlight += 1;
  uploadsByActor.set(actorId, mine + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    uploadsInFlight -= 1;
    const left = (uploadsByActor.get(actorId) ?? 1) - 1;
    if (left <= 0) uploadsByActor.delete(actorId);
    else uploadsByActor.set(actorId, left);
  };
}

// A person's drops in the last minute, for the per-person rate limit. Process memory only: a restart forgets it, which is fine for a limit that
// protects the machine, not a quota that is billed.
const dropTimes = new Map<string, number[]>();
/** True when the person may drop now (and records the drop); false when they have made too many in the last minute. */
export function allowDrop(actorId: string, now: number = Date.now()): boolean {
  const limit = dropsPerMinute();
  const recent = (dropTimes.get(actorId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= limit) {
    dropTimes.set(actorId, recent);
    return false;
  }
  recent.push(now);
  dropTimes.set(actorId, recent);
  if (dropTimes.size > 5_000) {
    for (const [k, v] of dropTimes) if (v.every((t) => now - t >= 60_000)) dropTimes.delete(k);
  }
  return true;
}
/** For tests. */
export function resetDropLimits(): void {
  dropTimes.clear();
  uploadsByActor.clear();
  uploadsInFlight = 0;
}

export type ReadableLike = AsyncIterable<Uint8Array> & {
  iterator?: (options: { destroyOnReturn: boolean }) => AsyncIterator<Uint8Array>;
  resume?: () => unknown;
  destroy?: () => unknown;
};

export class UploadStalledError extends Error {
  constructor() {
    super('The upload stalled or took too long');
  }
}

/** The request body for the blob store: gives up when the sender stalls or takes too long, and does not destroy the socket when the reader stops early, so a refusal can still be sent. */
export function tapped(source: AsyncIterable<Uint8Array>): { stream: AsyncIterable<Uint8Array>; drain: () => void } {
  const src = source as ReadableLike;
  const deadline = Date.now() + uploadMaxMs();
  const idle = uploadIdleMs();
  const it = src.iterator ? src.iterator({ destroyOnReturn: false }) : source[Symbol.asyncIterator]();
  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        const wait = Math.min(idle, deadline - Date.now());
        let timer: NodeJS.Timeout | undefined;
        const stalled = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new UploadStalledError()), Math.max(wait, 0));
        });
        try {
          return await Promise.race([it.next(), stalled]);
        } catch (err) {
          if (err instanceof UploadStalledError) src.destroy?.();
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
      return: () => Promise.resolve({ done: true as const, value: undefined }),
    }),
  };
  return { stream, drain: () => void src.resume?.() };
}

/** The file name as the person gave it, made safe to show and to store: no folders, no control characters, at most 200 characters. */
export function cleanName(raw: string | undefined): string | null {
  if (!raw) return null;
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  // eslint-disable-next-line no-control-regex
  name = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (name.length > 200) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name.length > 0 && name !== '.' && name !== '..' ? name : null;
}
