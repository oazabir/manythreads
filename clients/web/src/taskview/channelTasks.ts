import {
  approvalChangedPushType,
  ApprovalChangedPush,
  RunActivityPush,
  RunEndedPush,
  RunStartedPush,
  THREAD_WATCH_RENEW_SECONDS,
  TodoChangedPush,
  WS_RUN_ACTIVITY,
  WS_RUN_ENDED,
  WS_RUN_STARTED,
  WS_TODO_CHANGED,
  type ActiveChannelRunsResponse,
  type Approval,
  type ChannelApprovalsResponse,
  type ChannelTodosResponse,
  type RunActivityItem,
  type RunActivityResponse,
  type RunHead,
  type ThreadTodo,
} from '@manythreads/shared';
import type { Push, RealtimeClient } from '../realtime/socket';
import { isApiError } from '../api/client';
import { runEnded } from '../channels/run-card/words';

/*
 * The task view of a channel (P29, docs/plans/channel-task-view.md): for each thread root of the page, its run head, the last steps of that run, its to-do list and the
 * questions waiting on it, held in ONE place and read in batches, never per row.
 *
 *  * One lease for the whole channel (`PUT /api/channels/:id/watch/:leaseId`, renewed every 20 s, deleted when the page leaves; paused while the tab is hidden). It is what makes
 *    the server send `run.activity` (the folded state of every run of the channel, about once a second). Thread leases are not used here: they also pull the words of the
 *    answer (about 12 frames a second).
 *  * Three batched reads when the channel opens: the active runs (with the head of the newest 30, and the heads of runs that ended lately), the open to-do lists, and the
 *    pending questions. After that only pushes: `run.activity` moves a head we hold; `run.started` / `run.ended` / a run we do not know make ONE debounced read of the
 *    channel's runs (never a read per thread); `todo.changed` and `approval.changed` (filtered by the channel the push names) make one debounced read of the list.
 *  * The last steps of a run are read once when its head first shows and again when its `seq` moves, at most once per `STEPS_EVERY_MS` per run.
 *  * A row with nothing to show reads the shared `EMPTY`: a virtual list mounts rows by the dozen and a row must not re-render for a thread it has nothing for.
 */

export interface TaskViewState {
  /** The run going now (the newest), or null. */
  run: RunHead | null;
  /** How many other runs of the thread are going. */
  moreRuns: number;
  /** The run that ended lately (the newest), or null. */
  ended: RunHead | null;
  /** The last lines of the going (or just ended) run, oldest first. */
  lines: readonly RunActivityItem[];
  todo: ThreadTodo | null;
  /** The pending questions of the thread, oldest first. */
  questions: readonly Approval[];
}

export const EMPTY_TASK_VIEW: TaskViewState = { run: null, moreRuns: 0, ended: null, lines: [], todo: null, questions: [] };

export interface ChannelTasksDeps {
  activeRuns(channelId: string): Promise<ActiveChannelRunsResponse>;
  todos(channelId: string): Promise<ChannelTodosResponse>;
  approvals(channelId: string): Promise<ChannelApprovalsResponse>;
  activity(runId: string, after: number): Promise<RunActivityResponse>;
  watch(channelId: string, leaseId: string): Promise<unknown>;
  unwatch(channelId: string, leaseId: string): Promise<unknown>;
  newLeaseId?(): string;
  now?(): number;
}

/** A burst of pushes makes one read, this long after the first. */
export const READ_DEBOUNCE_MS = 300;
/** The steps of one run are read at most this often. */
export const STEPS_EVERY_MS = 3000;
/** A lease call that has not answered by now is given up on, so the chain of lease calls never stalls. */
export const LEASE_TIMEOUT_MS = 10_000;
/** A channel that holds no lease (the server's limit of leases per person was reached) reads its heads this often instead of waiting for the pushes. */
export const SLOW_POLL_MS = 30_000;
/** A run that was asked about and is not among the channel's going runs is not asked about again for this long (a run beyond the head cap would read the channel on every push). */
const IGNORE_UNKNOWN_MS = 60_000;
/** Lines behind the newest one that are read for the last steps (enough for three or four rows). */
const LINES_BEHIND = 40;

interface Entry {
  refs: number;
  timer: ReturnType<typeof setInterval> | null;
  /** Going runs of the channel, by run id. */
  going: Map<string, RunHead>;
  /** Runs that ended lately, by run id. */
  recent: Map<string, RunHead>;
  todos: Map<string, ThreadTodo>;
  questions: Map<string, Approval[]>;
  lines: Map<string, readonly RunActivityItem[]>;
  /** Keys whose state changed, to tell their listeners once. */
  views: Map<string, TaskViewState>;
  loadedRuns: boolean;
  debounce: Partial<Record<'runs' | 'todos' | 'questions', ReturnType<typeof setTimeout>>>;
  stepsAt: Map<string, number>;
  stepsSeq: Map<string, number>;
  stepsTimer: Map<string, ReturnType<typeof setTimeout>>;
  paused: boolean;
  /** Runs a push named that the page did not know, waiting for the next read to say whether they are going. */
  asked: Set<string>;
  /** Runs the last read did not list among the going ones: their pushes are ignored for a while. */
  ignored: Map<string, number>;
  /** The slow poll of a channel without a lease. */
  poll: ReturnType<typeof setInterval> | null;
}

let warnedNoLease = false;

const sameQuestions = (a: readonly Approval[], b: readonly Approval[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export class ChannelTasksStore {
  private readonly entries = new Map<string, Entry>();
  /** The channel each root belongs to, so a root's state is found without the channel. */
  private readonly channelOf = new Map<string, string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly leaseId: string;
  private chain: Promise<unknown> = Promise.resolve();
  private detach: Array<() => void> = [];

  constructor(private readonly deps: ChannelTasksDeps) {
    this.leaseId = deps.newLeaseId?.() ?? globalThis.crypto.randomUUID();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ---- reading -----------------------------------------------------------------------------------------------------------------

  subscribe = (rootId: string, listener: () => void): (() => void) => {
    let set = this.listeners.get(rootId);
    if (!set) this.listeners.set(rootId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(rootId);
    };
  };

  /** What a root shows. The same object until something about the root changes; the shared `EMPTY_TASK_VIEW` when it has nothing. */
  stateOf = (rootId: string): TaskViewState => {
    const channelId = this.channelOf.get(rootId);
    const e = channelId === undefined ? undefined : this.entries.get(channelId);
    return e?.views.get(rootId) ?? EMPTY_TASK_VIEW;
  };

  /** The channel's roots that have something now (for tests and for the page's one live region). */
  rootsWithSomething(channelId: string): string[] {
    return [...(this.entries.get(channelId)?.views.keys() ?? [])];
  }

  /** A person answered a question here (or lost the race to answer it): read the channel's questions again now, not after the push. */
  refreshQuestions(channelId: string): void {
    this.later(channelId, 'questions');
  }

  /** A second answer lost the race (409): every open channel reads its questions again now. */
  refreshAllQuestions(): void {
    for (const channelId of this.entries.keys()) this.later(channelId, 'questions');
  }

  private readonly said = new Map<string, string>();

  /** The channel's one spoken line for a screen reader ("1 question is waiting for an answer"); empty when nothing waits. The cards themselves are not live regions. `said` holds who waits, to tell when it changes. */
  announcementOf = (channelId: string, exceptRoot: string | null = null): string => {
    const e = this.entries.get(channelId);
    if (!e) return '';
    let waiting = 0;
    // a thread open in the side panel speaks for itself (its own strip and live region): it is not counted again here
    for (const [root, v] of e.views) if (root !== exceptRoot) waiting += v.questions.length;
    return waiting === 0 ? '' : waiting === 1 ? '1 question is waiting for an answer' : `${waiting} questions are waiting for an answer`;
  };

  subscribeChannel = (channelId: string, listener: () => void): (() => void) => this.subscribe(`channel:${channelId}`, listener);

  private emit(rootId: string): void {
    for (const l of [...(this.listeners.get(rootId) ?? [])]) l();
  }

  // ---- opening a channel -------------------------------------------------------------------------------------------------------

  /** A page shows the channel: hold its lease and keep its task view. Call the returned function when the page leaves the channel. */
  track(channelId: string): () => void {
    let e = this.entries.get(channelId);
    if (!e) {
      e = {
        refs: 0,
        timer: null,
        going: new Map(),
        recent: new Map(),
        todos: new Map(),
        questions: new Map(),
        lines: new Map(),
        views: new Map(),
        loadedRuns: false,
        debounce: {},
        stepsAt: new Map(),
        stepsSeq: new Map(),
        stepsTimer: new Map(),
        paused: typeof document !== 'undefined' && document.visibilityState === 'hidden',
        asked: new Set(),
        ignored: new Map(),
        poll: null,
      };
      this.entries.set(channelId, e);
      this.renew(channelId);
      e.timer = setInterval(() => this.renew(channelId), THREAD_WATCH_RENEW_SECONDS * 1000);
      void this.readRuns(channelId);
      void this.readTodos(channelId);
      void this.readQuestions(channelId);
    }
    e.refs += 1;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const cur = this.entries.get(channelId);
      if (!cur) return;
      cur.refs -= 1;
      if (cur.refs > 0) return;
      this.close(channelId, cur);
    };
  }

  private close(channelId: string, e: Entry): void {
    if (e.timer) clearInterval(e.timer);
    if (e.poll) clearInterval(e.poll);
    for (const t of Object.values(e.debounce)) if (t) clearTimeout(t);
    for (const t of e.stepsTimer.values()) clearTimeout(t);
    this.entries.delete(channelId);
    const roots = [...e.views.keys()];
    for (const r of roots) {
      this.channelOf.delete(r);
      this.emit(r);
    }
    this.lease(() => this.deps.unwatch(channelId, this.leaseId));
  }

  private renew(channelId: string): void {
    const e = this.entries.get(channelId);
    if (!e || e.paused) return;
    this.lease(async () => {
      if (this.entries.get(channelId) !== e) return;
      try {
        await this.deps.watch(channelId, this.leaseId);
        if (e.poll) {
          clearInterval(e.poll);
          e.poll = null;
        }
      } catch (err) {
        // the server holds a few leases per person (8): the ninth is refused. Without a lease there are no `run.activity` pushes, so the channel's heads are read on a slow clock instead
        if (isApiError(err) && err.status === 429) this.slowPoll(channelId, e);
      }
    });
  }

  private slowPoll(channelId: string, e: Entry): void {
    if (e.poll) return;
    if (!warnedNoLease) {
      warnedNoLease = true;
      console.warn('The channel task view has no live lease (too many channels watched); it reads every 30 seconds instead.');
    }
    e.poll = setInterval(() => {
      if (e.paused || this.entries.get(channelId) !== e) return;
      this.resyncChannel(channelId);
    }, SLOW_POLL_MS);
  }

  /** One lease call after the other (a close never overtakes the open before it); each is given up on after LEASE_TIMEOUT_MS, a failure is the next renewal's to mend. */
  private lease(call: () => Promise<unknown>): void {
    const timed = (): Promise<unknown> =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, LEASE_TIMEOUT_MS);
        call().then(
          () => {
            clearTimeout(t);
            resolve(undefined);
          },
          () => {
            clearTimeout(t);
            resolve(undefined);
          },
        );
      });
    this.chain = this.chain.then(timed);
  }

  // ---- the batched reads -------------------------------------------------------------------------------------------------------

  private readonly reading = new Set<string>();

  private async readRuns(channelId: string): Promise<void> {
    const e = this.entries.get(channelId);
    if (!e) return;
    const key = `runs:${channelId}`;
    if (this.reading.has(key)) {
      this.later(channelId, 'runs');
      return;
    }
    this.reading.add(key);
    try {
      const res = await this.deps.activeRuns(channelId);
      if (this.entries.get(channelId) !== e) return;
      const going = new Map<string, RunHead>();
      const recent = new Map<string, RunHead>();
      for (const r of res.runs) {
        const head = r.head ?? e.going.get(r.runId);
        if (!head) continue;
        // a read that was answered before a newer push is not allowed to take a run back: the higher `seq` wins
        const held = e.going.get(r.runId);
        going.set(r.runId, held !== undefined && held.seq > head.seq ? held : head);
      }
      for (const h of res.recent ?? []) recent.set(h.runId, h);
      e.going = going;
      e.recent = recent;
      e.loadedRuns = true;
      // what a push named and this read did not list among the going runs is left alone for a while (a run beyond the cap would read the channel again on every push)
      for (const id of e.asked) if (!going.has(id)) e.ignored.set(id, this.now());
      e.asked.clear();
      // nothing is kept for a run that is no longer shown
      for (const id of [...e.lines.keys()]) if (!going.has(id) && !recent.has(id)) e.lines.delete(id);
      for (const id of [...e.stepsAt.keys()]) if (!going.has(id) && !recent.has(id)) e.stepsAt.delete(id);
      for (const id of [...e.stepsSeq.keys()]) if (!going.has(id) && !recent.has(id)) e.stepsSeq.delete(id);
      for (const [id, t] of [...e.stepsTimer]) {
        if (going.has(id) || recent.has(id)) continue;
        clearTimeout(t);
        e.stepsTimer.delete(id);
      }
      this.rebuild(channelId, e);
      // the last steps are read for the runs that are going, never for the ended ones (their lines are not drawn)
      for (const h of going.values()) this.wantSteps(channelId, e, h);
    } catch {
      // what is held stays; the next push or reconnect reads again
    } finally {
      this.reading.delete(key);
    }
  }

  private async readTodos(channelId: string): Promise<void> {
    const e = this.entries.get(channelId);
    if (!e) return;
    const key = `todos:${channelId}`;
    if (this.reading.has(key)) return void this.later(channelId, 'todos');
    this.reading.add(key);
    try {
      const res = await this.deps.todos(channelId);
      if (this.entries.get(channelId) !== e) return;
      e.todos = new Map(res.todos.map((t) => [t.rootId, t]));
      this.rebuild(channelId, e);
    } catch {
      // as above
    } finally {
      this.reading.delete(key);
    }
  }

  private async readQuestions(channelId: string): Promise<void> {
    const e = this.entries.get(channelId);
    if (!e) return;
    const key = `questions:${channelId}`;
    if (this.reading.has(key)) return void this.later(channelId, 'questions');
    this.reading.add(key);
    try {
      const res = await this.deps.approvals(channelId);
      if (this.entries.get(channelId) !== e) return;
      const next = new Map<string, Approval[]>();
      for (const a of res.items) {
        if (a.threadRootId === null || a.threadRootId === undefined) continue;
        next.set(a.threadRootId, [...(next.get(a.threadRootId) ?? []), a]);
      }
      e.questions = next;
      this.rebuild(channelId, e);
    } catch {
      // as above
    } finally {
      this.reading.delete(key);
    }
  }

  /** Ask for a read after a short wait; a burst of pushes makes one read. */
  private later(channelId: string, what: 'runs' | 'todos' | 'questions'): void {
    const e = this.entries.get(channelId);
    if (!e || e.debounce[what]) return;
    e.debounce[what] = setTimeout(() => {
      delete e.debounce[what];
      if (this.entries.get(channelId) !== e) return;
      void (what === 'runs' ? this.readRuns(channelId) : what === 'todos' ? this.readTodos(channelId) : this.readQuestions(channelId));
    }, READ_DEBOUNCE_MS);
  }

  // ---- the last steps ----------------------------------------------------------------------------------------------------------

  /** Read the last lines of a run when its head first shows and when its `seq` moved, at most once per STEPS_EVERY_MS. */
  private wantSteps(channelId: string, e: Entry, head: RunHead): void {
    if (this.stepsFresh(e, head)) return;
    const wait = Math.max(0, (e.stepsAt.get(head.runId) ?? 0) + STEPS_EVERY_MS - this.now());
    if (wait > 0) {
      if (e.stepsTimer.has(head.runId)) return;
      e.stepsTimer.set(
        head.runId,
        setTimeout(() => {
          e.stepsTimer.delete(head.runId);
          const cur = e.going.get(head.runId) ?? e.recent.get(head.runId);
          if (cur && this.entries.get(channelId) === e) this.wantSteps(channelId, e, cur);
        }, wait),
      );
      return;
    }
    void this.readSteps(channelId, e, head);
  }

  private stepsFresh(e: Entry, head: RunHead): boolean {
    return e.stepsSeq.get(head.runId) === head.seq;
  }

  private async readSteps(channelId: string, e: Entry, head: RunHead): Promise<void> {
    e.stepsAt.set(head.runId, this.now());
    e.stepsSeq.set(head.runId, head.seq);
    try {
      const res = await this.deps.activity(head.runId, Math.max(-1, head.seq - LINES_BEHIND));
      if (this.entries.get(channelId) !== e) return;
      e.lines.set(head.runId, res.items.slice(-LINES_BEHIND));
      this.rebuild(channelId, e);
    } catch {
      e.stepsSeq.delete(head.runId); // tried again at the next move
    }
  }

  // ---- building each root's state ----------------------------------------------------------------------------------------------

  /** Make each root's state from what is held, keeping the old object when it did not change, and tell the roots that did. */
  private rebuild(channelId: string, e: Entry): void {
    const roots = new Set<string>();
    for (const h of e.going.values()) if (h.threadRootId) roots.add(h.threadRootId);
    for (const h of e.recent.values()) if (h.threadRootId) roots.add(h.threadRootId);
    for (const r of e.todos.keys()) roots.add(r);
    for (const r of e.questions.keys()) roots.add(r);
    const next = new Map<string, TaskViewState>();
    for (const root of roots) {
      const running = [...e.going.values()].filter((h) => h.threadRootId === root).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      const run = running[0] ?? null;
      const lately = [...e.recent.values()].filter((h) => h.threadRootId === root).sort((a, b) => Date.parse(b.endedAt ?? '') - Date.parse(a.endedAt ?? ''))[0] ?? null;
      const shown = run ?? lately;
      const view: TaskViewState = {
        run,
        moreRuns: Math.max(0, running.length - 1),
        ended: run === null ? lately : null,
        lines: shown ? (e.lines.get(shown.runId) ?? []) : [],
        todo: e.todos.get(root) ?? null,
        questions: e.questions.get(root) ?? [],
      };
      const old = e.views.get(root);
      if (old && sameView(old, view)) {
        next.set(root, old);
        continue;
      }
      next.set(root, view);
      this.channelOf.set(root, channelId);
      this.emit(root);
    }
    for (const root of e.views.keys()) {
      if (next.has(root)) continue;
      this.emit(root);
    }
    e.views = next;
    // the channel's live region listens to who waits (it leaves out the thread open in the side panel), so it is told whenever that changes
    const key = [...next].filter(([, v]) => v.questions.length > 0).map(([r, v]) => `${r}:${v.questions.length}`).sort().join(',');
    if ((this.said.get(channelId) ?? '') !== key) {
      this.said.set(channelId, key);
      this.emit(`channel:${channelId}`);
    }
    for (const root of [...this.channelOf.keys()]) if (this.channelOf.get(root) === channelId && !next.has(root)) this.channelOf.delete(root);
  }

  // ---- pushes ------------------------------------------------------------------------------------------------------------------

  attach(client: RealtimeClient): void {
    this.detach.forEach((d) => d());
    this.detach = [client.onPush((p) => this.handlePush(p)), client.onReconnected(() => this.resync())];
    if (typeof document !== 'undefined') {
      const onVisible = (): void => {
        const visible = document.visibilityState === 'visible';
        for (const [channelId, e] of this.entries) {
          e.paused = !visible;
          if (visible) {
            this.renew(channelId);
            this.resyncChannel(channelId);
          }
        }
      };
      document.addEventListener('visibilitychange', onVisible);
      this.detach.push(() => document.removeEventListener('visibilitychange', onVisible));
    }
  }

  /** The socket was down or the tab was hidden: take the lease again and read everything of each open channel again. */
  resync(): void {
    for (const channelId of this.entries.keys()) {
      this.renew(channelId);
      this.resyncChannel(channelId);
    }
  }

  private resyncChannel(channelId: string): void {
    void this.readRuns(channelId);
    void this.readTodos(channelId);
    void this.readQuestions(channelId);
  }

  handlePush(push: Push): void {
    switch (push.type) {
      case WS_RUN_STARTED: {
        const p = RunStartedPush.safeParse(push.payload);
        if (p.success && this.entries.has(p.data.channelId)) this.later(p.data.channelId, 'runs');
        return;
      }
      case WS_RUN_ENDED: {
        const p = RunEndedPush.safeParse(push.payload);
        if (p.success && this.entries.has(p.data.channelId)) this.later(p.data.channelId, 'runs');
        return;
      }
      case WS_RUN_ACTIVITY: {
        const p = RunActivityPush.safeParse(push.payload);
        if (p.success) this.activity(p.data);
        return;
      }
      case WS_TODO_CHANGED: {
        const p = TodoChangedPush.safeParse(push.payload);
        if (!p.success) return;
        const e = this.entries.get(p.data.channelId);
        if (!e) return;
        if ((e.todos.get(p.data.rootId)?.version ?? 0) < p.data.version) this.later(p.data.channelId, 'todos');
        return;
      }
      case approvalChangedPushType: {
        const p = ApprovalChangedPush.safeParse(push.payload);
        // an approval that names no channel, or one this page does not show, costs nothing here
        if (p.success && p.data.channelId && this.entries.has(p.data.channelId)) this.later(p.data.channelId, 'questions');
        return;
      }
      default:
    }
  }

  private activity(p: RunActivityPush): void {
    const e = this.entries.get(p.channelId);
    if (!e) return;
    const head = e.going.get(p.runId);
    if (head === undefined) {
      // a run this page does not know (it began before the page, or its start was missed): one debounced read of the channel's runs, never a read per thread; one the last read did
      // not list (beyond the cap) is left alone for a while
      const at = e.ignored.get(p.runId);
      if (at !== undefined && this.now() - at < IGNORE_UNKNOWN_MS) return;
      e.ignored.delete(p.runId);
      e.asked.add(p.runId);
      this.later(p.channelId, 'runs');
      return;
    }
    if (head.seq === p.seq && head.state === p.state && head.now === p.now) return;
    // a late line of an older read never takes the head back
    if (p.seq < head.seq) return;
    const next: RunHead = { ...head, state: p.state, now: p.now, counts: p.counts, plan: p.plan, planVersion: p.planVersion, helpers: p.helpers, seq: p.seq, stoppedBy: p.stoppedBy };
    e.going.set(p.runId, next);
    this.rebuild(p.channelId, e);
    // the run has ended (this push came after `run.ended`, or without it): the channel's runs are read again to move it from the going to the recent
    if (runEnded(p.state)) {
      this.later(p.channelId, 'runs');
      return;
    }
    this.wantSteps(p.channelId, e, next);
  }

  /** For tests. */
  reset(): void {
    for (const [id, e] of [...this.entries]) this.close(id, e);
    this.entries.clear();
    this.channelOf.clear();
    this.reading.clear();
  }
}

function sameView(a: TaskViewState, b: TaskViewState): boolean {
  return a.run === b.run && a.moreRuns === b.moreRuns && a.ended === b.ended && a.lines === b.lines && a.todo === b.todo && sameQuestions(a.questions, b.questions);
}
