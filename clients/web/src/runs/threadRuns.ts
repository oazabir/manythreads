import {
  RunActivityPush,
  RunDeltaPush,
  RunEndedPush,
  RunStartedPush,
  THREAD_WATCH_RENEW_SECONDS,
  WS_RUN_ACTIVITY,
  WS_RUN_DELTA,
  WS_RUN_ENDED,
  WS_RUN_STARTED,
  type ListThreadRunsResponse,
  type RunActivityItem,
  type RunActivityResponse,
  type RunHead,
  type RunPlanEntry,
  type RunViewState,
} from '@manythreads/shared';
import type { Push, RealtimeClient } from '../realtime/socket';

/*
 * The runs of a thread, live (PLAN P25-07, docs/plans/acp.md §3.4). The data layer of the run card; the card itself draws from `stateOf(rootId)`.
 *
 *  * Watching. While a thread panel is open the store holds a lease on the server (`PUT /api/threads/:rootId/watch`, renewed every 30 s, deleted when the last panel of that
 *    thread closes). Only watchers receive the steps of a run; everybody who can read the channel receives `run.started` and `run.ended`, which the store keeps as the
 *    "Coder is working" chips of thread roots (`workingOn`).
 *  * The truth is the server's. The list of runs (`GET /api/threads/:rootId/runs`) is read when the panel opens, after a reconnect, when a push names a run the store does
 *    not know, and when a run ends (its final head carries the cost and the end time). A `run.activity` push replaces the folded part of a head; a `run.delta` adds
 *    the next piece of the answer to the preview, if it is the next piece (a hole stops the preview: the answer is the message the run posts).
 *  * The steps of a run are read lazily (`loadActivity`), only past the last one the store holds.
 */

export interface ThreadRunsState {
  /** The first answer has come. */
  loaded: boolean;
  /** Oldest first. */
  runs: readonly RunHead[];
  /** The words of each run's answer as they are written, by run id (gone when the run ends: the answer is then a message). */
  answers: Readonly<Record<string, string>>;
}

export interface RunLines {
  items: readonly RunActivityItem[];
  plan: readonly RunPlanEntry[];
  /** The lines are being read. */
  loading: boolean;
}

export interface ThreadRunsDeps {
  listRuns(rootId: string): Promise<ListThreadRunsResponse>;
  activity(runId: string, after: number): Promise<RunActivityResponse>;
  watch(rootId: string): Promise<unknown>;
  unwatch(rootId: string): Promise<unknown>;
  stop(runId: string): Promise<{ stopped: boolean }>;
}

const EMPTY: ThreadRunsState = { loaded: false, runs: [], answers: {} };
const NO_LINES: RunLines = { items: [], plan: [], loading: false };
const ENDED: readonly RunViewState[] = ['done', 'failed', 'stopped'];
export const isEnded = (state: RunViewState): boolean => ENDED.includes(state);
/** Pages of lines read at once, at most (a run keeps 2000). */
const MAX_PAGES = 20;

interface Opened {
  refs: number;
  state: ThreadRunsState;
  timer: ReturnType<typeof setInterval> | null;
  loading: Promise<void> | null;
  again: boolean;
  /** How much of each run's answer the preview holds, to place the next piece. */
  lengths: Map<string, number>;
  /** Runs whose preview has a hole. */
  broken: Set<string>;
}

export class ThreadRunsStore {
  private readonly opened = new Map<string, Opened>();
  private readonly working = new Map<string, readonly RunStartedPush[]>();
  private readonly lines = new Map<string, RunLines>();
  private readonly reading = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private detach: Array<() => void> = [];

  constructor(private readonly deps: ThreadRunsDeps) {}

  // ---- reading ------------------------------------------------------------------------------------------------------------------

  subscribe = (rootId: string, listener: () => void): (() => void) => {
    let set = this.listeners.get(rootId);
    if (!set) this.listeners.set(rootId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(rootId);
    };
  };

  /** The runs of an open thread (the same object until something changes). */
  stateOf = (rootId: string): ThreadRunsState => this.opened.get(rootId)?.state ?? EMPTY;

  /** The runs of a thread root that are working now, for its chip: known from `run.started` and `run.ended` to every reader of the channel, open thread or not. */
  workingOn = (rootId: string): readonly RunStartedPush[] => this.working.get(rootId) ?? NONE_WORKING;

  /** The lines read so far for a run (the same object until something changes). */
  linesOf = (runId: string): RunLines => this.lines.get(runId) ?? NO_LINES;

  subscribeLines = (runId: string, listener: () => void): (() => void) => this.subscribe(`lines:${runId}`, listener);

  // ---- opening a thread ----------------------------------------------------------------------------------------------------------

  /** A thread panel is open: hold the lease and keep the runs. Call the returned function when the panel closes. */
  open(rootId: string): () => void {
    let o = this.opened.get(rootId);
    if (!o) {
      o = { refs: 0, state: EMPTY, timer: null, loading: null, again: false, lengths: new Map(), broken: new Set() };
      this.opened.set(rootId, o);
      this.renew(rootId);
      o.timer = setInterval(() => this.renew(rootId), THREAD_WATCH_RENEW_SECONDS * 1000);
      void this.load(rootId);
    }
    o.refs += 1;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const cur = this.opened.get(rootId);
      if (!cur) return;
      cur.refs -= 1;
      if (cur.refs > 0) return;
      if (cur.timer) clearInterval(cur.timer);
      this.opened.delete(rootId);
      void this.deps.unwatch(rootId).catch(() => undefined);
      this.emit(rootId);
    };
  }

  private renew(rootId: string): void {
    void this.deps.watch(rootId).catch(() => undefined);
  }

  /** Read the runs again (coalesced: a call while a read is on its way asks for one more read after it). */
  load(rootId: string): Promise<void> {
    const o = this.opened.get(rootId);
    if (!o) return Promise.resolve();
    if (o.loading) {
      o.again = true;
      return o.loading;
    }
    o.loading = (async () => {
      try {
        for (;;) {
          o.again = false;
          try {
            const res = await this.deps.listRuns(rootId);
            if (this.opened.get(rootId) !== o) return;
            this.put(rootId, o, { loaded: true, runs: res.runs, answers: this.keepAnswers(o, res.runs) });
          } catch {
            // the rows stay as they were; the next push or reconnect asks again
            if (this.opened.get(rootId) === o && !o.state.loaded) this.put(rootId, o, { ...o.state, loaded: true });
          }
          if (!o.again) return;
        }
      } finally {
        o.loading = null;
      }
    })();
    return o.loading;
  }

  /** Answers of runs that are still working stay; those of ended runs go (the message has arrived). */
  private keepAnswers(o: Opened, runs: readonly RunHead[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of runs) {
      const text = o.state.answers[r.runId];
      if (text !== undefined && !isEnded(r.state)) out[r.runId] = text;
    }
    return out;
  }

  private put(rootId: string, o: Opened, next: ThreadRunsState): void {
    o.state = next;
    this.emit(rootId);
  }

  private emit(key: string): void {
    for (const l of [...(this.listeners.get(key) ?? [])]) l();
  }

  // ---- pushes -----------------------------------------------------------------------------------------------------------------

  attach(client: RealtimeClient): void {
    this.detach.forEach((d) => d());
    this.detach = [
      client.onPush((p) => this.handlePush(p)),
      // what was missed while the socket was down is unknown: take the lease again and read the runs again
      client.onReconnected(() => {
        for (const rootId of this.opened.keys()) {
          this.renew(rootId);
          void this.load(rootId);
        }
      }),
    ];
  }

  handlePush(push: Push): void {
    switch (push.type) {
      case WS_RUN_STARTED: {
        const p = RunStartedPush.safeParse(push.payload);
        if (p.success) this.started(p.data);
        return;
      }
      case WS_RUN_ACTIVITY: {
        const p = RunActivityPush.safeParse(push.payload);
        if (p.success) this.activityPush(p.data);
        return;
      }
      case WS_RUN_DELTA: {
        const p = RunDeltaPush.safeParse(push.payload);
        if (p.success) this.delta(p.data);
        return;
      }
      case WS_RUN_ENDED: {
        const p = RunEndedPush.safeParse(push.payload);
        if (p.success) this.ended(p.data);
        return;
      }
      default:
    }
  }

  private started(p: RunStartedPush): void {
    const now = this.working.get(p.threadRootId) ?? [];
    if (!now.some((r) => r.runId === p.runId)) this.working.set(p.threadRootId, [...now, p]);
    this.emit(p.threadRootId);
    if (this.opened.has(p.threadRootId)) void this.load(p.threadRootId);
  }

  private activityPush(p: RunActivityPush): void {
    const o = this.opened.get(p.threadRootId);
    if (!o) return;
    const at = o.state.runs.findIndex((r) => r.runId === p.runId);
    const head = o.state.runs[at];
    if (head === undefined) {
      void this.load(p.threadRootId);
      return;
    }
    // a run that has ended is not moved back by a push that arrived late
    if (isEnded(head.state) && !isEnded(p.state)) return;
    const progress = { state: p.state, now: p.now, counts: p.counts, plan: p.plan, planVersion: p.planVersion, helpers: p.helpers, seq: p.seq, stoppedBy: p.stoppedBy };
    const runs = o.state.runs.map((r, i) => (i === at ? { ...r, ...progress } : r));
    this.put(p.threadRootId, o, { ...o.state, runs });
  }

  private delta(p: RunDeltaPush): void {
    const o = this.opened.get(p.threadRootId);
    if (!o || o.broken.has(p.runId)) return;
    const have = o.lengths.get(p.runId) ?? 0;
    if (p.offset < have) return; // a piece already held
    if (p.offset > have) {
      // a hole: the preview stops here, the message will have the whole answer
      o.broken.add(p.runId);
      return;
    }
    o.lengths.set(p.runId, have + p.text.length);
    this.put(p.threadRootId, o, { ...o.state, answers: { ...o.state.answers, [p.runId]: (o.state.answers[p.runId] ?? '') + p.text } });
  }

  private ended(p: RunEndedPush): void {
    const left = (this.working.get(p.threadRootId) ?? []).filter((r) => r.runId !== p.runId);
    if (left.length > 0) this.working.set(p.threadRootId, left);
    else this.working.delete(p.threadRootId);
    this.emit(p.threadRootId);
    const o = this.opened.get(p.threadRootId);
    if (!o) return;
    o.lengths.delete(p.runId);
    o.broken.delete(p.runId);
    const answers = { ...o.state.answers };
    delete answers[p.runId];
    const runs = o.state.runs.map((r) => (r.runId === p.runId && !isEnded(r.state) ? { ...r, state: p.status, now: null, canStop: false } : r));
    this.put(p.threadRootId, o, { ...o.state, runs, answers });
    // the final head has the cost, the end time and why the agent stopped
    void this.load(p.threadRootId);
  }

  // ---- the lines of a run -------------------------------------------------------------------------------------------------------

  /** Read the lines of a run past the last one held (all of them the first time). Safe to call again while it reads. */
  loadActivity(runId: string): Promise<void> {
    const going = this.reading.get(runId);
    if (going) return going;
    const job = (async () => {
      const key = `lines:${runId}`;
      const first = this.linesOf(runId);
      this.lines.set(runId, { ...first, loading: true });
      this.emit(key);
      try {
        let held = first;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const after = held.items.length === 0 ? -1 : held.items[held.items.length - 1]!.seq;
          const res = await this.deps.activity(runId, after);
          held = { items: [...held.items, ...res.items], plan: res.plan, loading: true };
          this.lines.set(runId, held);
          this.emit(key);
          if (!res.hasMore) break;
        }
      } catch {
        // what was read stays
      } finally {
        this.lines.set(runId, { ...this.linesOf(runId), loading: false });
        this.reading.delete(runId);
        this.emit(key);
      }
    })();
    this.reading.set(runId, job);
    return job;
  }

  // ---- Stop -----------------------------------------------------------------------------------------------------------------------

  /** Stop the run. The card says "stopping" at once; if the server refuses, it goes back and the error is thrown. */
  async stop(rootId: string, runId: string): Promise<void> {
    const o = this.opened.get(rootId);
    const before = o?.state;
    if (o && before) {
      const runs = before.runs.map((r) => (r.runId === runId && !isEnded(r.state) ? { ...r, state: 'stopping' as const } : r));
      this.put(rootId, o, { ...before, runs });
    }
    try {
      const res = await this.deps.stop(runId);
      if (!res.stopped) void this.load(rootId); // it had ended by then: show how
    } catch (e) {
      const now = this.opened.get(rootId);
      if (now && before) {
        // only this run goes back; the rest may have moved meanwhile
        const old = before.runs.find((r) => r.runId === runId);
        if (old) this.put(rootId, now, { ...now.state, runs: now.state.runs.map((r) => (r.runId === runId ? old : r)) });
      }
      throw e;
    }
  }

  reset(): void {
    for (const o of this.opened.values()) if (o.timer) clearInterval(o.timer);
    this.opened.clear();
    this.working.clear();
    this.lines.clear();
    this.reading.clear();
    const all = [...this.listeners.values()];
    for (const set of all) for (const l of [...set]) l();
  }
}

const NONE_WORKING: readonly RunStartedPush[] = [];
