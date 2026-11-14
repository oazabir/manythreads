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
  type ActiveChannelRunsResponse,
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
 *  * Watching. While a thread panel is open the store holds a lease on the server (`PUT /api/threads/:rootId/watch/:leaseId`, renewed every 20 s, deleted when the last panel
 *    of that thread closes). The lease id is this tab's own, so another tab of the same person keeps its lease when this one closes. The lease calls of one thread go one at a
 *    time (a close never overtakes the open before it), and the lease is renewed and the runs read again when the tab comes back into view (a hidden tab's timers are
 *    slowed down by the browser, and the lease may have lapsed). Only watchers receive the steps of a run; everybody who can read the channel receives `run.started` and
 *    `run.ended`, which the store keeps as the "Coder is working" chips of thread roots (`workingOn`). A page that has just been opened (or a socket that has just come back)
 *    missed some of those: `trackChannel` reads the active runs of a channel from the server, and a chip that has outlived any run (its `run.ended` was lost) goes by itself.
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
  watch(rootId: string, leaseId: string): Promise<unknown>;
  unwatch(rootId: string, leaseId: string): Promise<unknown>;
  stop(runId: string): Promise<{ stopped: boolean }>;
  /** The runs going in a channel's threads (optional: a store without it keeps only what the pushes told it). */
  activeRuns?(channelId: string): Promise<ActiveChannelRunsResponse>;
  /** This tab's lease id (default: a random UUID). */
  newLeaseId?(): string;
  /** The time, for the chips' expiry (default: `Date.now`). */
  now?(): number;
}

const EMPTY: ThreadRunsState = { loaded: false, runs: [], answers: {} };
const NO_LINES: RunLines = { items: [], plan: [], loading: false };
const ENDED: readonly RunViewState[] = ['done', 'failed', 'stopped'];
export const isEnded = (state: RunViewState): boolean => ENDED.includes(state);
/** Pages of lines read at once, at most (a run keeps 2000). */
const MAX_PAGES = 20;
/** A "working" chip older than this is dropped: no run lasts so long, so its `run.ended` was lost. */
export const CHIP_TTL_MS = 3 * 60 * 60 * 1000;
/** Runs known to have ended, kept so that a late `run.started` or a stale list does not bring a chip back. */
const ENDED_MEMORY = 500;

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
  /** This tab's lease id: one per tab, whatever threads it opens. */
  private readonly leaseId: string;
  /** Per thread: the lease calls in order (the last one on the chain). */
  private readonly chain = new Map<string, Promise<unknown>>();
  /** Lines that were asked for again while they were being read. */
  private readonly rereads = new Set<string>();
  private readonly chipTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly endedRuns = new Set<string>();
  /** The channels a page shows chips for (a count each), to read their active runs again after a reconnect. */
  private readonly channels = new Map<string, number>();
  private readonly activeReads = new Map<string, number>();

  constructor(private readonly deps: ThreadRunsDeps) {
    this.leaseId = deps.newLeaseId?.() ?? globalThis.crypto.randomUUID();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

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
      this.lease(rootId, () => this.deps.unwatch(rootId, this.leaseId));
      this.emit(rootId);
    };
  }

  private renew(rootId: string): void {
    // a thread that was closed meanwhile is not watched again by a renewal that was already queued
    this.lease(rootId, () => (this.opened.has(rootId) ? this.deps.watch(rootId, this.leaseId) : Promise.resolve()));
  }

  /** One lease call after the other for a thread: a close never overtakes the open (or renewal) before it, and a failure is the next renewal's to mend. */
  private lease(rootId: string, call: () => Promise<unknown>): void {
    const prev = this.chain.get(rootId) ?? Promise.resolve();
    const next = prev.then(call).catch(() => undefined);
    this.chain.set(rootId, next);
    void next.then(() => {
      if (this.chain.get(rootId) === next) this.chain.delete(rootId);
    });
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

  /**
   * Answers of runs that are still working stay; those of ended runs (the message has arrived) and of runs the list no longer has go, and so do their offsets and their holes:
   * the three always say the same runs.
   */
  private keepAnswers(o: Opened, runs: readonly RunHead[]): Record<string, string> {
    const out: Record<string, string> = {};
    const live = new Set<string>();
    for (const r of runs) {
      if (isEnded(r.state)) this.remember(r.runId);
      else live.add(r.runId);
      const text = o.state.answers[r.runId];
      if (text !== undefined && !isEnded(r.state)) out[r.runId] = text;
    }
    for (const id of [...o.lengths.keys()]) if (!live.has(id) || out[id] === undefined) o.lengths.delete(id);
    for (const id of [...o.broken]) if (!live.has(id)) o.broken.delete(id);
    return out;
  }

  private remember(runId: string): void {
    this.endedRuns.add(runId);
    if (this.endedRuns.size > ENDED_MEMORY) this.endedRuns.delete(this.endedRuns.values().next().value as string);
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
      client.onReconnected(() => this.resync()),
    ];
    if (typeof document !== 'undefined') {
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') this.resync();
      };
      document.addEventListener('visibilitychange', onVisible);
      this.detach.push(() => document.removeEventListener('visibilitychange', onVisible));
    }
  }

  /**
   * Something may have been missed (the socket was down, the tab was hidden): take every lease again, read every open thread's runs again, forget the chips (they are
   * read again for the channels a page shows).
   */
  resync(): void {
    for (const rootId of this.opened.keys()) {
      this.renew(rootId);
      void this.load(rootId);
    }
    const roots = [...this.working.keys()];
    this.working.clear();
    for (const t of this.chipTimers.values()) clearTimeout(t);
    this.chipTimers.clear();
    for (const r of roots) this.emit(r);
    for (const channelId of this.channels.keys()) void this.loadActive(channelId);
  }

  // ---- the chips of a channel -----------------------------------------------------------------------------------------------------

  /** A page shows the "working" chips of this channel: read its active runs now and after every reconnect. Call the returned function when the page leaves the channel. */
  trackChannel(channelId: string): () => void {
    this.channels.set(channelId, (this.channels.get(channelId) ?? 0) + 1);
    void this.loadActive(channelId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.channels.get(channelId) ?? 1) - 1;
      if (n <= 0) this.channels.delete(channelId);
      else this.channels.set(channelId, n);
    };
  }

  /** Replace what the store knows of a channel's working runs with what the server says (a run that began before the page loaded sent its `run.started` to nobody). */
  async loadActive(channelId: string): Promise<void> {
    const read = this.deps.activeRuns;
    if (!read) return;
    const token = (this.activeReads.get(channelId) ?? 0) + 1;
    this.activeReads.set(channelId, token);
    const seen = new Set<string>();
    let res: ActiveChannelRunsResponse;
    try {
      res = await read(channelId);
    } catch {
      return; // the chips stay as they were
    }
    if (this.activeReads.get(channelId) !== token) return; // a newer read is on its way
    const touched = new Set<string>();
    for (const [root, list] of [...this.working]) {
      const keep = list.filter((r) => r.channelId !== channelId);
      if (keep.length === list.length) continue;
      for (const r of list) if (r.channelId === channelId) this.clearChipTimer(r.runId);
      touched.add(root);
      if (keep.length > 0) this.working.set(root, keep);
      else this.working.delete(root);
    }
    for (const r of res.runs) {
      if (seen.has(r.runId) || this.endedRuns.has(r.runId)) continue; // a run.ended came while the answer was on its way
      seen.add(r.runId);
      touched.add(r.threadRootId);
      this.addChip(r);
    }
    for (const root of touched) this.emit(root);
  }

  private addChip(p: RunStartedPush): void {
    const age = this.now() - Date.parse(p.startedAt);
    if (Number.isFinite(age) && age >= CHIP_TTL_MS) return; // no run lasts so long: its end was lost
    const list = this.working.get(p.threadRootId) ?? [];
    if (list.some((r) => r.runId === p.runId)) return;
    this.working.set(p.threadRootId, [...list, p]);
    const left = Number.isFinite(age) ? CHIP_TTL_MS - Math.max(0, age) : CHIP_TTL_MS;
    this.chipTimers.set(
      p.runId,
      setTimeout(() => {
        this.chipTimers.delete(p.runId);
        this.dropChip(p.threadRootId, p.runId);
        this.emit(p.threadRootId);
      }, left),
    );
  }

  private clearChipTimer(runId: string): void {
    const t = this.chipTimers.get(runId);
    if (t !== undefined) clearTimeout(t);
    this.chipTimers.delete(runId);
  }

  private dropChip(rootId: string, runId: string): void {
    this.clearChipTimer(runId);
    const left = (this.working.get(rootId) ?? []).filter((r) => r.runId !== runId);
    if (left.length > 0) this.working.set(rootId, left);
    else this.working.delete(rootId);
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
    if (!this.endedRuns.has(p.runId)) this.addChip(p);
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
    if (!o || o.broken.has(p.runId) || this.endedRuns.has(p.runId)) return;
    const run = o.state.runs.find((r) => r.runId === p.runId);
    if (run === undefined) {
      // a run the store does not know yet (its head is on its way): the list is read again, the preview starts with the next piece it can place
      if (o.state.loaded) void this.load(p.threadRootId);
      return;
    }
    if (isEnded(run.state)) return;
    const have = o.lengths.get(p.runId) ?? 0;
    if (p.offset < have) return; // a piece already held
    if (p.offset > have) {
      // a hole: the preview stops here, the message will have the whole answer
      o.broken.add(p.runId);
      return;
    }
    // a piece that was redacted for this reader says how much of the answer it covers; the next piece starts there
    o.lengths.set(p.runId, have + (p.span ?? p.text.length));
    this.put(p.threadRootId, o, { ...o.state, answers: { ...o.state.answers, [p.runId]: (o.state.answers[p.runId] ?? '') + p.text } });
  }

  private ended(p: RunEndedPush): void {
    this.remember(p.runId);
    this.dropChip(p.threadRootId, p.runId);
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

  /**
   * Read the lines of a run past the last one held (all of them the first time). A call while a read is going shares it, and asks for one more pass after it: the lines
   * that were written since the page that is now being read was cut are not lost (the shared read returns when it has caught up).
   */
  loadActivity(runId: string): Promise<void> {
    const going = this.reading.get(runId);
    if (going) {
      this.rereads.add(runId);
      return going;
    }
    const job = (async () => {
      const key = `lines:${runId}`;
      this.lines.set(runId, { ...this.linesOf(runId), loading: true });
      this.emit(key);
      try {
        do {
          this.rereads.delete(runId);
          for (let page = 0; page < MAX_PAGES; page += 1) {
            const held = this.linesOf(runId);
            const after = held.items.length === 0 ? -1 : held.items[held.items.length - 1]!.seq;
            const res = await this.deps.activity(runId, after);
            this.lines.set(runId, { items: [...held.items, ...res.items], plan: res.plan, loading: true });
            this.emit(key);
            if (!res.hasMore) break;
          }
        } while (this.rereads.has(runId));
      } catch {
        // what was read stays
      } finally {
        this.rereads.delete(runId);
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
    for (const t of this.chipTimers.values()) clearTimeout(t);
    this.chipTimers.clear();
    this.opened.clear();
    this.chain.clear();
    this.rereads.clear();
    this.endedRuns.clear();
    this.channels.clear();
    this.activeReads.clear();
    this.working.clear();
    this.lines.clear();
    this.reading.clear();
    const all = [...this.listeners.values()];
    for (const set of all) for (const l of [...set]) l();
  }
}

const NONE_WORKING: readonly RunStartedPush[] = [];
