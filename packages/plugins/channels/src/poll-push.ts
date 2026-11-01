// How often a poll's totals are pushed (PLAN P14-07). Pure: the clock, the timers and the push are handed in, so the rules are tested without a database.
//
// Why not push every vote at once: a page that sees the totals move the moment somebody votes learns who it was in a small group, however well the
// ballots are hidden. So the totals of an ANONYMOUS poll are never pushed at the moment of a vote: they are collected and sent once, a few seconds
// later, whatever number of votes came in between. A NAMED poll is pushed at once when it has been quiet and at most once a second after that (a
// burst of votes becomes one push with the final totals). A close is always pushed at once. The limit is per process: each server instance keeps
// its own pace, which only ever makes the pushes fewer than the rules allow per instance.

export const NAMED_GAP_MS = 1_000;
export const ANONYMOUS_GAP_MS = 4_000;
/** A later push is never set closer than this to the change, so the change is committed before the totals are read again. */
export const MIN_DELAY_MS = 250;

export interface PollPushClock {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface PollKey {
  id: string;
  anonymous: boolean;
}

/** `now`: the caller pushes the totals in its own transaction. `later`: a push is (or already was) scheduled and will read the totals when it runs. */
export type PushVerdict = 'now' | 'later';

export interface PollPushCoalescer {
  /** Decides what a change of this poll does. `immediate` is a close (or anything that must not wait) and always answers `now`. */
  decide(poll: PollKey, immediate: boolean): PushVerdict;
  /** Timers waiting right now (a test checks nothing is left behind). */
  pending(): number;
  /** Stops every waiting push. */
  stop(): void;
}

export function createPollPushCoalescer(clock: PollPushClock, flush: (pollId: string) => Promise<void>, onError?: (err: unknown) => void): PollPushCoalescer {
  const last = new Map<string, number>();
  const waiting = new Map<string, unknown>();

  const prune = (at: number): void => {
    if (last.size < 2_000) return;
    for (const [id, t] of last) if (at - t > 60_000 && !waiting.has(id)) last.delete(id);
  };

  const later = (poll: PollKey, at: number, delay: number): PushVerdict => {
    if (waiting.has(poll.id)) return 'later';
    const handle = clock.setTimer(() => {
      waiting.delete(poll.id);
      last.set(poll.id, clock.now());
      flush(poll.id).catch((err: unknown) => onError?.(err));
    }, Math.max(MIN_DELAY_MS, delay));
    waiting.set(poll.id, handle);
    prune(at);
    return 'later';
  };

  return {
    decide(poll, immediate) {
      const at = clock.now();
      if (immediate) {
        const handle = waiting.get(poll.id);
        if (handle !== undefined) clock.clearTimer(handle);
        waiting.delete(poll.id);
        last.set(poll.id, at);
        return 'now';
      }
      if (poll.anonymous) return later(poll, at, ANONYMOUS_GAP_MS);
      const since = at - (last.get(poll.id) ?? -Infinity);
      if (!waiting.has(poll.id) && since >= NAMED_GAP_MS) {
        last.set(poll.id, at);
        prune(at);
        return 'now';
      }
      return later(poll, at, NAMED_GAP_MS - since);
    },
    pending: () => waiting.size,
    stop() {
      for (const handle of waiting.values()) clock.clearTimer(handle);
      waiting.clear();
    },
  };
}
