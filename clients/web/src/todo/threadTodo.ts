import { TodoChangedPush, WS_TODO_CHANGED, type GetThreadTodoResponse, type ThreadTodo } from '@manythreads/shared';
import type { Push, RealtimeClient } from '../realtime/socket';

/*
 * The to-do list of a thread, live (PLAN P25-10). The data layer only: the card that draws it is P25-11.
 *
 * The truth is the server's. The list is read when a thread panel opens and after a socket reconnect. A `todo.changed` push carries only the channel, the thread root and the
 * new version, never the items (the push may reach people on other devices, and the read is the one place that checks who may see the list): when the version is newer than the
 * one held, the list is read again. Reads can finish out of order, so a read that brings an older version than the one held is dropped.
 */

export interface ThreadTodoState {
  /** The first answer has come. */
  loaded: boolean;
  /** Null: the thread has no list (or this person may not read it). */
  todo: ThreadTodo | null;
}

export interface ThreadTodoDeps {
  read(rootId: string): Promise<GetThreadTodoResponse>;
}

const EMPTY: ThreadTodoState = { loaded: false, todo: null };

interface Opened {
  refs: number;
  state: ThreadTodoState;
  /** The newest version a push has named: a read that comes back older than this is read again. */
  seen: number;
  reading: boolean;
  again: boolean;
  /** Reads in a row that came back older than a push named: they back off, and stop after a few (the next push or reconnect reads again). */
  stale: number;
  /** Reads since the list last caught up with the newest version a push named: a burst of pushes reads at most `BURST_READS` times. */
  burst: number;
  /** When the burst began: a push ten seconds later starts a new one. */
  burstAt: number;
}

/** At most this many reads in a row for a version a push named and the server does not have yet. */
const STALE_TRIES = 3;
/** At most this many reads for one burst of pushes before the list has caught up; the next reconnect reads again. */
const BURST_READS = 8;

export class ThreadTodoStore {
  private readonly opened = new Map<string, Opened>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private detach: Array<() => void> = [];

  constructor(private readonly deps: ThreadTodoDeps) {}

  /** A thread panel shows the list: read it, and keep it fresh until the returned function is called. */
  open(rootId: string): () => void {
    let entry = this.opened.get(rootId);
    if (!entry) {
      entry = { refs: 0, state: EMPTY, seen: 0, reading: false, again: false, stale: 0, burst: 0, burstAt: 0 };
      this.opened.set(rootId, entry);
    }
    entry.refs += 1;
    if (entry.refs === 1) void this.read(rootId);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const e = this.opened.get(rootId);
      if (!e) return;
      e.refs -= 1;
      if (e.refs <= 0) this.opened.delete(rootId);
    };
  }

  stateOf(rootId: string): ThreadTodoState {
    return this.opened.get(rootId)?.state ?? EMPTY;
  }

  subscribe(rootId: string, listener: () => void): () => void {
    let set = this.listeners.get(rootId);
    if (!set) {
      set = new Set();
      this.listeners.set(rootId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(rootId);
    };
  }

  attach(client: RealtimeClient): void {
    this.detach.forEach((d) => d());
    this.detach = [client.onPush((p) => this.handlePush(p)), client.onReconnected(() => this.resync())];
  }

  handlePush(push: Push): void {
    if (push.type !== WS_TODO_CHANGED) return;
    const parsed = TodoChangedPush.safeParse(push.payload);
    if (!parsed.success) return;
    const { rootId, version } = parsed.data;
    const entry = this.opened.get(rootId);
    if (!entry) return;
    entry.seen = Math.max(entry.seen, version);
    entry.stale = 0;
    if (Date.now() - entry.burstAt > 10_000) entry.burst = 0;
    if ((entry.state.todo?.version ?? 0) < version) void this.read(rootId);
  }

  /** The socket was down: what changed meanwhile is unknown. */
  resync(): void {
    for (const [rootId, entry] of this.opened) {
      entry.burst = 0;
      void this.read(rootId);
    }
  }

  private emit(rootId: string): void {
    for (const l of [...(this.listeners.get(rootId) ?? [])]) l();
  }

  /** One read at a time per thread; a push that comes during a read makes one more read after it. */
  private async read(rootId: string): Promise<void> {
    const entry = this.opened.get(rootId);
    if (!entry) return;
    if (entry.reading) {
      entry.again = true;
      return;
    }
    if (entry.burst >= BURST_READS) return;
    if (entry.burst === 0) entry.burstAt = Date.now();
    entry.burst += 1;
    entry.reading = true;
    try {
      const { todo } = await this.deps.read(rootId);
      const now = this.opened.get(rootId);
      if (now !== entry) return;
      const heldTodo = entry.state.todo;
      const held = heldTodo?.version ?? 0;
      // another list (made again after the first was removed) starts its versions at 1: it is newer however small its number is
      const another = heldTodo !== null && todo !== null && (todo.messageId !== heldTodo.messageId || Date.parse(todo.updatedAt) > Date.parse(heldTodo.updatedAt)) && todo.version < held;
      if (another) entry.seen = todo.version;
      // a read that finished late must not bring an older list back
      if (todo === null || todo.version >= held || another) {
        entry.state = { loaded: true, todo };
        this.emit(rootId);
      }
      // a push named a newer version than this read brought (the read began before the write finished): read again, a little later each time, a few times at most
      if (todo !== null && entry.seen > todo.version) {
        entry.stale += 1;
        if (entry.stale <= STALE_TRIES && !entry.again) {
          const wait = 250 * 2 ** (entry.stale - 1);
          setTimeout(() => {
            if (this.opened.get(rootId) === entry) void this.read(rootId);
          }, wait);
        }
      } else entry.stale = 0;
      if (todo === null || entry.seen <= todo.version) entry.burst = 0;
    } catch {
      // the list stays as it was; the next push or reconnect reads again
    } finally {
      entry.reading = false;
      if (entry.again && this.opened.get(rootId) === entry) {
        entry.again = false;
        // the read a push asked for during this one: at once, unless reads keep coming back stale, then with the same growing wait
        const wait = entry.stale > 1 ? 250 * 2 ** Math.min(entry.stale - 1, STALE_TRIES) : 0;
        if (wait === 0) void this.read(rootId);
        else
          setTimeout(() => {
            if (this.opened.get(rootId) === entry) void this.read(rootId);
          }, wait);
      }
    }
  }
}
