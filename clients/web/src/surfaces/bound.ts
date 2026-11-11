import { SURFACE_BIND_REFRESH_MIN_SECONDS, type SurfaceDataResponse } from '@manythreads/shared';

// How a bound part of a screen keeps its data fresh (PLAN P9-06), with no React in it so the rules can be tested with a fake clock:
//   * it reads once when it appears, again every `refreshSeconds` (never faster than 10 s) and again when told to (a new version of the screen, a press that went through);
//   * while the tab is hidden it does not read at all: the timer is cancelled, and when the tab is shown again it reads at once if a read was missed or the data is older than
//     its interval;
//   * a read in flight is never doubled up (a request that comes meanwhile is remembered and made once the first is back);
//   * after a failure it waits longer before the next try (at least 30 s, 60 s when the server said it was asked too often), so a broken or busy server is not hammered;
//   * a part with no `refreshSeconds` reads only when it appears or is told to: a failed read is not retried by itself.

/** What a bound part is showing. `last` is the values of the last good read, kept while a later read fails so the part does not go blank. */
export type BoundState =
  | { kind: 'loading' }
  | { kind: 'ok'; props: Record<string, unknown>; fetchedAt: string }
  | { kind: 'empty' }
  | { kind: 'error'; message: string; code: string; last?: Record<string, unknown> };

/** Why a read did not come back at all (the request was refused or never arrived). `retryMs` is how long to leave it alone. */
export interface BoundFailure {
  message: string;
  code: string;
  retryMs?: number;
  /** The screen has moved on: say nothing, a new version will read again by itself. */
  stale?: boolean;
}

export interface BoundDeps {
  read(): Promise<SurfaceDataResponse>;
  fail(e: unknown): BoundFailure;
  visible(): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onState(state: BoundState): void;
}

/** The pause between two reads on the clock: what the screen asked for, and never under the minimum. */
export const intervalMs = (refreshSeconds: number | undefined): number | null =>
  refreshSeconds === undefined ? null : Math.max(SURFACE_BIND_REFRESH_MIN_SECONDS, refreshSeconds) * 1000;

export const FAILURE_PAUSE_MS = 30_000;
export const BUSY_PAUSE_MS = 60_000;

export interface BoundController {
  /** Read now (and keep reading on the clock). */
  start(): void;
  /** Read again as soon as possible: the data may have changed. */
  refresh(): void;
  /** Tell it the tab was hidden or shown. */
  visibilityChanged(): void;
  /** Stop for good: no timer, and a read still in flight is ignored when it comes back. */
  stop(): void;
}

export function createBoundController(refreshSeconds: number | undefined, deps: BoundDeps): BoundController {
  const every = intervalMs(refreshSeconds);
  let stopped = false;
  let inFlight = false;
  let again = false;
  let missed = false;
  let timer: unknown = null;
  let lastReadAt: number | null = null;
  let pause = 0;
  let last: Record<string, unknown> | undefined;

  const clear = (): void => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };
  const schedule = (): void => {
    clear();
    if (stopped || every === null || !deps.visible()) return;
    timer = deps.setTimer(() => {
      timer = null;
      void run();
    }, Math.max(every, pause));
  };
  async function run(): Promise<void> {
    if (stopped) return;
    if (!deps.visible()) {
      missed = true;
      return;
    }
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    missed = false;
    clear();
    pause = 0;
    try {
      const answer = await deps.read();
      if (stopped) return;
      lastReadAt = deps.now();
      if (answer.state === 'ok') {
        last = answer.props;
        deps.onState({ kind: 'ok', props: answer.props, fetchedAt: answer.fetchedAt });
      } else if (answer.state === 'empty') {
        last = undefined;
        deps.onState({ kind: 'empty' });
      } else {
        pause = FAILURE_PAUSE_MS;
        deps.onState({ kind: 'error', message: answer.message, code: answer.code, ...(last ? { last } : {}) });
      }
    } catch (e) {
      if (stopped) return;
      const f = deps.fail(e);
      lastReadAt = deps.now();
      if (!f.stale) {
        pause = f.retryMs ?? FAILURE_PAUSE_MS;
        deps.onState({ kind: 'error', message: f.message, code: f.code, ...(last ? { last } : {}) });
      }
    } finally {
      inFlight = false;
      if (!stopped) {
        if (again) {
          again = false;
          void run();
        } else schedule();
      }
    }
  }

  return {
    start: () => void run(),
    refresh: () => void run(),
    visibilityChanged() {
      if (stopped) return;
      if (!deps.visible()) {
        clear();
        return;
      }
      const old = every !== null && lastReadAt !== null && deps.now() - lastReadAt >= Math.max(every, pause);
      if (missed || (old && !inFlight)) void run();
      else if (!inFlight) schedule();
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}

/** What the person is told when a read was refused before it got an answer. */
export function failureOf(e: unknown, status: (e: unknown) => number | null): BoundFailure {
  const s = status(e);
  if (s === 409) return { message: '', code: 'stale', stale: true };
  if (s === 429) return { message: 'Too many reads at once. Trying again in a minute.', code: 'busy', retryMs: BUSY_PAUSE_MS };
  if (s === 403 || s === 404) return { message: 'This data is not available to you.', code: 'forbidden', retryMs: BUSY_PAUSE_MS };
  return { message: 'Could not load this data.', code: 'unavailable' };
}
