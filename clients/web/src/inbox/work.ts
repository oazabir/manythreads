import { THREAD_BATCH_MAX, type ActiveChannelRun, type ActiveChannelRunsResponse, type Approval, type ChannelApprovalsResponse, type ChannelTodosResponse, type ThreadTodo } from '@manythreads/shared';

/*
 * What is going on in the threads the Threads view lists (P29, docs/plans/channel-task-view.md section 10c): for each listed root its to-do list, its going run and the questions
 * waiting on it. Three batched reads for the whole page (never one per row), made when the listed roots change, after a push (a run began or ended, a list changed, a question was
 * raised or answered; a burst makes one read) and every `SLOW_POLL_MS` while the page is visible, because a run's own steps reach a person only through a lease and the list holds none.
 * A read that fails keeps what is shown and is tried again at the next turn.
 */

export interface RowWork {
  todo: ThreadTodo | null;
  /** The newest run going in the thread, or null. */
  run: ActiveChannelRun | null;
  /** The questions waiting in the thread, oldest first. */
  questions: readonly Approval[];
}

export const NO_WORK: RowWork = { todo: null, run: null, questions: [] };

export interface InboxWorkDeps {
  runs(roots: readonly string[]): Promise<ActiveChannelRunsResponse>;
  todos(roots: readonly string[]): Promise<ChannelTodosResponse>;
  approvals(roots: readonly string[]): Promise<ChannelApprovalsResponse>;
}

/** A burst of pushes makes one read, this long after the first. */
export const WORK_DEBOUNCE_MS = 400;
/** While a run is going in a listed row and the list is visible, the three reads are repeated this often (the run's line moves without a push for the person). */
export const SLOW_POLL_MS = 20_000;

const chunks = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

const sameQuestions = (a: readonly Approval[], b: readonly Approval[]): boolean => a.length === b.length && a.every((x, i) => x === b[i] || (x.id === b[i]?.id && x.status === b[i]?.status && x.canDecide === b[i]?.canDecide));
const sameTodo = (a: ThreadTodo | null, b: ThreadTodo | null): boolean => a === b || (a !== null && b !== null && a.version === b.version && a.updatedAt === b.updatedAt);
const sameRun = (a: ActiveChannelRun | null, b: ActiveChannelRun | null): boolean =>
  a === b || (a !== null && b !== null && a.runId === b.runId && a.head?.seq === b.head?.seq && a.head?.state === b.head?.state && a.head?.now === b.head?.now);

export class InboxWork {
  private roots: string[] = [];
  private rootSet = new Set<string>();
  private work = new Map<string, RowWork>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  private again = false;
  private stopped = false;
  /** Goes up whenever any row's work changed, for `useSyncExternalStore`. */
  version = 0;

  constructor(private readonly deps: InboxWorkDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** The work of one root; the same object until it changes, the shared `NO_WORK` when there is none. */
  of = (root: string): RowWork => this.work.get(root) ?? NO_WORK;

  /** Is this root one the page lists (a push about another thread costs nothing)? */
  has = (root: string | null | undefined): boolean => root !== null && root !== undefined && this.rootSet.has(root);

  /** Is a run going in any listed row (only then does the page read on a clock: a run's line moves without a push for the person)? */
  anyRunning(): boolean {
    for (const w of this.work.values()) if (w.run !== null) return true;
    return false;
  }

  /** The roots the page lists now. A change reads at once (new rows must not wait for the next turn); no change reads nothing. */
  setRoots(next: readonly string[]): void {
    const same = next.length === this.roots.length && next.every((r, i) => r === this.roots[i]);
    if (same) return;
    this.roots = [...next];
    this.rootSet = new Set(next);
    this.work = new Map([...this.work].filter(([r]) => this.roots.includes(r)));
    if (this.roots.length > 0) void this.read();
  }

  /** Something may have changed: read all three again, once, soon. */
  refreshSoon(): void {
    if (this.stopped || this.roots.length === 0 || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.read();
    }, WORK_DEBOUNCE_MS);
  }

  /** The page is gone. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private async read(): Promise<void> {
    if (this.stopped) return;
    // one read at a time; a request that came while one was going runs once more after it
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    const roots = this.roots;
    try {
      const parts = chunks(roots, THREAD_BATCH_MAX);
      const [runs, todos, questions] = await Promise.all([
        Promise.all(parts.map((p) => this.deps.runs(p).then((r) => r.runs, () => null))),
        Promise.all(parts.map((p) => this.deps.todos(p).then((r) => r.todos, () => null))),
        Promise.all(parts.map((p) => this.deps.approvals(p).then((r) => r.items, () => null))),
      ]);
      if (this.stopped || roots !== this.roots) return;
      // a kind that failed (in any chunk) keeps what each row had of it
      const ok = (lists: Array<unknown[] | null>): boolean => lists.every((l) => l !== null);
      const runsOk = ok(runs);
      const todosOk = ok(todos);
      const questionsOk = ok(questions);
      const runBy = new Map<string, ActiveChannelRun>();
      for (const r of runs.flatMap((l) => l ?? []) as ActiveChannelRun[]) if (!runBy.has(r.threadRootId)) runBy.set(r.threadRootId, r);
      const todoBy = new Map((todos.flatMap((l) => l ?? []) as ThreadTodo[]).map((t) => [t.rootId as string, t]));
      const questionsBy = new Map<string, Approval[]>();
      for (const a of questions.flatMap((l) => l ?? []) as Approval[]) {
        if (a.threadRootId === null) continue;
        const list = questionsBy.get(a.threadRootId) ?? [];
        list.push(a);
        questionsBy.set(a.threadRootId, list);
      }
      let changed = false;
      const next = new Map<string, RowWork>();
      for (const root of roots) {
        const before = this.work.get(root) ?? NO_WORK;
        const w: RowWork = {
          todo: todosOk ? (todoBy.get(root) ?? null) : before.todo,
          run: runsOk ? (runBy.get(root) ?? null) : before.run,
          questions: questionsOk ? (questionsBy.get(root) ?? []) : before.questions,
        };
        const same = sameTodo(w.todo, before.todo) && sameRun(w.run, before.run) && sameQuestions(w.questions, before.questions);
        if (!same) changed = true;
        const keep = same ? before : w;
        if (keep.todo !== null || keep.run !== null || keep.questions.length > 0) next.set(root, keep);
        else if (before !== NO_WORK) changed = true;
      }
      if (changed || next.size !== this.work.size) {
        this.work = next;
        this.version += 1;
        for (const l of [...this.listeners]) l();
      }
    } finally {
      this.reading = false;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.read();
      }
    }
  }
}
