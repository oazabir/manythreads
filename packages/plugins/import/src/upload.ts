import { HttpError } from '@manythreads/sdk';

// The upload of an archive is the one request in this plugin that lasts minutes and holds a database connection while it does. Three bounds keep one
// admin (or a stolen admin session) from pinning the pool: at most one archive in flight per person and two per server process (429 beyond), a stall
// limit (no bytes for `idleMs`) and a total time. Read per request so an operator or a test can change them.

const intEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isSafeInteger(v) && v > 0 ? v : fallback;
};
export const importIdleMs = (): number => intEnv('MANYTHREADS_IMPORT_IDLE_MS', 30_000);
export const importMaxMs = (): number => intEnv('MANYTHREADS_IMPORT_MAX_MS', 3_600_000);
const MAX_UPLOADS_PER_PROCESS = 2;

const byActor = new Set<string>();
let inFlight = 0;
/** Takes an upload slot for `actorId`, or null when this person already has an archive on its way or the process is full. Call the result when done. */
export function takeUploadSlot(actorId: string): (() => void) | null {
  if (inFlight >= MAX_UPLOADS_PER_PROCESS || byActor.has(actorId)) return null;
  inFlight += 1;
  byActor.add(actorId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight -= 1;
    byActor.delete(actorId);
  };
}

export class UploadStalledError extends Error {
  constructor() {
    super('The upload stalled or took too long');
  }
}

type ReadableLike = AsyncIterable<Uint8Array> & {
  iterator?: (options: { destroyOnReturn: boolean }) => AsyncIterator<Uint8Array>;
  resume?: () => unknown;
  destroy?: () => unknown;
};

/** How much of a refused upload is read and thrown away so the refusal can be heard, how long the answer then has to go out, and the longest the connection is kept. */
export const DRAIN_BYTES = 1024 * 1024;
export const DRAIN_ANSWER_MS = 1_000;
export const DRAIN_MAX_MS = 10_000;

/**
 * Reads and throws a little of a request body away (at most `maxBytes`), so a refusal can be sent on a connection that is still open and the client can
 * read it. Then it stops reading (the client is held back by the socket), and a second later the connection is cut: it never reads a refused upload to the
 * end. `maxMs` bounds the whole thing for a client that sends slowly.
 */
export function drain(source: unknown, maxBytes = DRAIN_BYTES, answerMs = DRAIN_ANSWER_MS, maxMs = DRAIN_MAX_MS): void {
  const s = source as ReadableLike & { on?: (event: string, fn: (...args: unknown[]) => void) => unknown; pause?: () => unknown };
  if (!s.on) {
    s.resume?.();
    return;
  }
  let seen = 0;
  let cut: NodeJS.Timeout | undefined;
  const last = setTimeout(() => s.destroy?.(), maxMs);
  last.unref();
  s.on('close', () => {
    clearTimeout(last);
    if (cut) clearTimeout(cut);
  });
  s.on('data', (chunk: unknown) => {
    seen += (chunk as Uint8Array).length;
    if (seen > maxBytes && !cut) {
      s.pause?.();
      cut = setTimeout(() => s.destroy?.(), answerMs);
      cut.unref();
    }
  });
  s.resume?.();
}

export const tooLarge = (message: string): HttpError => new HttpError(413, 'validation_failed', message);

/**
 * The request body for the blob store: remembers the first bytes (for the file-type check) and, unlike iterating a Node stream directly, does not
 * destroy the socket when the reader stops early, so a refusal can still be sent. A peer that sends nothing for `idleMs` is cut.
 */
export function tapped(
  source: AsyncIterable<Uint8Array>,
  limits: { idleMs: number; maxMs: number } = { idleMs: importIdleMs(), maxMs: importMaxMs() },
): { stream: AsyncIterable<Uint8Array>; head: () => Uint8Array; drain: () => void } {
  const src = source as ReadableLike;
  const deadline = Date.now() + limits.maxMs;
  const it = src.iterator ? src.iterator({ destroyOnReturn: false }) : source[Symbol.asyncIterator]();
  const HEAD = 4096;
  let head = new Uint8Array(0);
  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        const wait = Math.min(limits.idleMs, deadline - Date.now());
        let timer: NodeJS.Timeout | undefined;
        const stalled = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new UploadStalledError()), Math.max(wait, 0));
        });
        let r: IteratorResult<Uint8Array>;
        try {
          r = await Promise.race([it.next(), stalled]);
        } catch (err) {
          if (err instanceof UploadStalledError) src.destroy?.();
          throw err;
        } finally {
          clearTimeout(timer);
        }
        if (!r.done && head.length < HEAD) {
          const chunk = r.value;
          const merged = new Uint8Array(Math.min(HEAD, head.length + chunk.length));
          merged.set(head);
          merged.set(chunk.subarray(0, merged.length - head.length), head.length);
          head = merged;
        }
        return r;
      },
      return: () => Promise.resolve({ done: true as const, value: undefined }),
    }),
  };
  return { stream, head: () => head, drain: () => drain(source) };
}
