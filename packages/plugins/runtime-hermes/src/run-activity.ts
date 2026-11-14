import type { BotPlanEntry, BotRuntimeEvent, BotStepDiff, BotStepKind } from '@manythreads/sdk';
import type { RunActivityKind, RunActivityPayload, RunCost, RunCounts, RunHelper, RunNow, RunPlanEntry, RunPlanSummary, RunProgress, RunViewState } from '@manythreads/shared';

// What a run did, folded (P25-06, docs/plans/acp.md §3). The run job feeds every runtime event of a run into one `ActivityFold`. The fold keeps two things and nothing else:
//
//   * the lines to write down (`run_activity`): one per step, per change of a helper's state, per plan, per stretch of thinking and per question to a person. A line is a
//     step's kind, one line of title and at most five paths. Never a tool's input or output, a file's content or the agent's reasoning: the fold is handed a "slim" copy
//     of each event (`slimOf`) that has none of them, so they cannot leak by accident;
//   * the folded state (`run_view` and the live `run.activity` push): what the run is doing now, the counts, the plan, the helpers.
//
// The fold is pure: no clock, no database, no push. `run-recorder.ts` redacts the words, writes the lines and sends the pushes.

/** A run keeps at most this many lines; after that steps are counted in the folded state only. */
export const MAX_ROWS = 2000;
// Every limit of a word is in UTF-8 BYTES, not characters: the table's CHECKs bound the size of the stored jsonb (`pg_column_size`), and Arabic is two bytes a letter,
// Chinese three. A title of 400 bytes, five paths of 300 and a helper's name of 100 keep `now_step` under 2500 bytes; thirty plan lines of 400 keep `plan` under 16000.
const MAX_TITLE = 400;
const MAX_PATH = 300;
const MAX_PATHS = 5;
const MAX_PLAN = 30;
const MAX_PLAN_TEXT = 400;
const MAX_NAME = 100;
const MAX_ID = 200;
/** The helpers kept in the folded state (the newest); a push shows the newest five. */
const MAX_HELPERS_KEPT = 12;
const MAX_HELPERS_PUSHED = 5;
const MAX_STEPS_KEPT = 1000;
const MAX_CHANGED_FILES = 2000;
/** A thought shorter than this is counted in the folded state but not written as a line of its own. */
const MIN_THOUGHT_LINE_SECONDS = 1;

// ---- the slim event ---------------------------------------------------------------------------------------------------------------

export type SlimEvent =
  | { t: 'tool'; name: string; stepId?: string; parentStepId?: string; kind: BotStepKind; title?: string; paths?: string[] }
  | { t: 'result'; name: string; stepId?: string; ok: boolean; diff?: BotStepDiff; seconds?: number }
  | { t: 'step'; stepId: string; title?: string; paths?: string[] }
  | { t: 'agent'; agentId: string; name: string; status: 'working' | 'done' | 'failed'; steps: number; parentStepId?: string }
  | { t: 'plan'; entries: BotPlanEntry[] }
  | { t: 'thinking'; seconds: number }
  | { t: 'answering' }
  | { t: 'approval'; phase: 'asked' | 'approved' | 'denied' | 'ended'; stepId?: string; kind?: BotStepKind; title?: string; paths?: string[]; diff?: BotStepDiff };

/** At most `n` UTF-8 bytes of `s`, never ending in the middle of a character (nor of a surrogate pair), and never holding a lone surrogate (which Postgres refuses in a jsonb). */
export function clip(s: string, n: number): string {
  const text = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD').replaceAll('\u0000', '');
  if (text.length * 3 <= n || Buffer.byteLength(text) <= n) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (used + size > n) break;
    out += ch;
    used += size;
  }
  return out;
}
/** One line: line breaks and runs of spaces become one space. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const cleanTitle = (v: unknown): string | undefined => (typeof v === 'string' && oneLine(v) !== '' ? clip(oneLine(v), MAX_TITLE) : undefined);
function cleanPaths(v: readonly string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const out: string[] = [];
  for (const p of v) {
    const t = typeof p === 'string' ? clip(oneLine(p), MAX_PATH) : '';
    if (t !== '' && !out.includes(t) && out.length < MAX_PATHS) out.push(t);
  }
  return out;
}
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** The part of a runtime event the record may hold; null for the events it has no use for (`result`, and a `text` is only the fact that the answer began). */
export function slimOf(event: BotRuntimeEvent): SlimEvent | null {
  switch (event.type) {
    case 'text':
      return event.text.trim() === '' ? null : { t: 'answering' };
    case 'tool': {
      const title = cleanTitle(event.title);
      const paths = cleanPaths(event.paths);
      return {
        t: 'tool',
        name: clip(String(event.name), 120),
        ...(event.stepId !== undefined ? { stepId: clip(event.stepId, 200) } : {}),
        ...(event.parentStepId !== undefined ? { parentStepId: clip(event.parentStepId, 200) } : {}),
        kind: event.kind ?? 'other',
        ...(title !== undefined ? { title } : {}),
        ...(paths !== undefined ? { paths } : {}),
      };
    }
    case 'tool_result': {
      const added = num(event.diff?.added);
      const removed = num(event.diff?.removed);
      const seconds = num(event.seconds);
      return {
        t: 'result',
        name: clip(String(event.name), 120),
        ...(event.stepId !== undefined ? { stepId: clip(event.stepId, 200) } : {}),
        ok: event.ok,
        ...(added !== undefined && removed !== undefined ? { diff: { added: Math.floor(added), removed: Math.floor(removed) } } : {}),
        ...(seconds !== undefined ? { seconds: Math.round(seconds * 10) / 10 } : {}),
      };
    }
    case 'step': {
      const title = cleanTitle(event.title);
      const paths = cleanPaths(event.paths);
      if (title === undefined && paths === undefined) return null;
      return { t: 'step', stepId: clip(event.stepId, 200), ...(title !== undefined ? { title } : {}), ...(paths !== undefined ? { paths } : {}) };
    }
    case 'agent':
      return {
        t: 'agent',
        agentId: clip(event.agentId, 200),
        name: clip(oneLine(event.name) || 'Helper', MAX_NAME),
        status: event.status,
        steps: Math.max(0, Math.floor(event.steps)),
        ...(event.parentStepId !== undefined ? { parentStepId: clip(event.parentStepId, 200) } : {}),
      };
    case 'plan':
      return {
        t: 'plan',
        entries: event.entries.slice(0, MAX_PLAN).map((e) => ({ content: clip(oneLine(e.content), MAX_PLAN_TEXT), status: e.status })).filter((e) => e.content !== ''),
      };
    case 'thinking':
      return { t: 'thinking', seconds: Math.round((num(event.seconds) ?? 0) * 10) / 10 };
    case 'approval': {
      const title = cleanTitle(event.title);
      const paths = cleanPaths(event.paths);
      const added = num(event.diff?.added);
      const removed = num(event.diff?.removed);
      return {
        t: 'approval',
        phase: 'asked',
        ...(event.stepId !== undefined ? { stepId: clip(event.stepId, 200) } : {}),
        ...(event.kind !== undefined ? { kind: event.kind } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(paths !== undefined ? { paths } : {}),
        ...(added !== undefined && removed !== undefined ? { diff: { added: Math.floor(added), removed: Math.floor(removed) } } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * The words of a slim event cut to the limits again, by bytes. A redaction can make a word longer ("[redacted:...]") or a gateway's word can be anything, so the fold does not
 * trust what it is handed: whatever reaches the table is within its CHECKs.
 */
export function bound(event: SlimEvent): SlimEvent {
  const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  const one = (t: string | undefined, n: number): string | undefined => (t === undefined || clip(oneLine(t), n) === '' ? undefined : clip(oneLine(t), n));
  const id = (t: string | undefined): string | undefined => (t === undefined ? undefined : clip(t, MAX_ID));
  const list = (p: string[] | undefined): string[] | undefined => (p === undefined ? undefined : cleanPaths(p));
  switch (event.t) {
    case 'tool':
      return defined({ ...event, stepId: id(event.stepId), parentStepId: id(event.parentStepId), title: one(event.title, MAX_TITLE), paths: list(event.paths) }) as SlimEvent;
    case 'step':
      return defined({ ...event, stepId: clip(event.stepId, MAX_ID), title: one(event.title, MAX_TITLE), paths: list(event.paths) }) as SlimEvent;
    case 'approval':
      return defined({ ...event, stepId: id(event.stepId), title: one(event.title, MAX_TITLE), paths: list(event.paths) }) as SlimEvent;
    case 'result':
      return event.stepId === undefined ? event : { ...event, stepId: clip(event.stepId, MAX_ID) };
    case 'agent':
      return { ...event, agentId: clip(event.agentId, MAX_ID), name: clip(oneLine(event.name), MAX_NAME) || 'Helper', ...(event.parentStepId === undefined ? {} : { parentStepId: clip(event.parentStepId, MAX_ID) }) };
    case 'plan':
      return { ...event, entries: event.entries.slice(0, MAX_PLAN).map((e) => ({ ...e, content: clip(oneLine(e.content), MAX_PLAN_TEXT) })).filter((e) => e.content !== '') };
    default:
      return event;
  }
}

/**
 * Every string of the slim event that a person will read (the words the recorder redacts), with `fn` applied; the rest is passed through. A word `fn` answers with ''
 * is dropped (a title or a path), so a redaction that cannot vouch for a word leaves it out instead of showing it.
 */
export function mapWords(event: SlimEvent, fn: (s: string) => string): SlimEvent {
  const paths = (p: string[] | undefined): { paths?: string[] } => (p === undefined ? {} : { paths: p.map(fn).filter((x) => x !== '') });
  const title = (t: string | undefined): { title?: string } => {
    const v = t === undefined ? '' : fn(t);
    return v === '' ? {} : { title: v };
  };
  switch (event.t) {
    case 'tool': {
      const rest = { ...event };
      delete rest.title;
      delete rest.paths;
      return { ...rest, ...title(event.title), ...paths(event.paths) };
    }
    case 'step': {
      const rest = { ...event };
      delete rest.title;
      delete rest.paths;
      return { ...rest, ...title(event.title), ...paths(event.paths) };
    }
    case 'approval': {
      const rest = { ...event };
      delete rest.title;
      delete rest.paths;
      return { ...rest, ...title(event.title), ...paths(event.paths) };
    }
    case 'agent':
      return { ...event, name: fn(event.name) || 'Helper' };
    case 'plan':
      return { ...event, entries: event.entries.map((e) => ({ ...e, content: fn(e.content) })).filter((e) => e.content !== '') };
    default:
      return event;
  }
}

/** "Plan 3 of 5 · Write the e2e test": how many entries are done, and the one in progress (else the first waiting). */
export function summarizePlan(plan: readonly RunPlanEntry[]): RunPlanSummary {
  const done = plan.filter((e) => e.status === 'completed').length;
  const current = plan.find((e) => e.status === 'in_progress') ?? plan.find((e) => e.status === 'pending');
  return { done, total: plan.length, current: current?.content ?? null };
}

// ---- the fold ---------------------------------------------------------------------------------------------------------------------

export interface FoldRow {
  seq: number;
  kind: RunActivityKind;
  payload: RunActivityPayload;
}

interface Step {
  id: string;
  name: string;
  kind: BotStepKind;
  parentId: string | undefined;
  open: boolean;
  title: string | undefined;
  paths: string[] | undefined;
  /** What the line already written says, so the closing line repeats the title and paths only when they changed. */
  shownTitle: string | undefined;
  shownPaths: string[] | undefined;
}

const EDIT_KINDS: readonly BotStepKind[] = ['edit', 'delete', 'move'];
const same = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => (a ?? []).join('\n') === (b ?? []).join('\n');

export class ActivityFold {
  private readonly steps = new Map<string, Step>();
  private readonly helperMap = new Map<string, RunHelper>();
  private readonly changed = new Set<string>();
  private plan: RunPlanEntry[] = [];
  private planVersion = 0;
  private seq = -1;
  private autoId = 0;
  private started = false;
  private waiting = false;
  private stopper: string | null = null;
  private ended: RunViewState | null = null;
  private phase: 'idle' | 'thinking' | 'answering' = 'idle';
  private cost: RunCost | null = null;
  private stopReason: string | null = null;
  private readonly c = { steps: 0, failed: 0, commands: 0, added: 0, removed: 0, helpers: 0, thinkingSeconds: 0, omitted: 0 };

  constructor(private readonly maxRows: number = MAX_ROWS) {}

  /** Take one slim event; answers the lines to write down for it (none, one, or two). */
  apply(raw: SlimEvent): FoldRow[] {
    if (this.ended !== null) return [];
    const ev = bound(raw);
    this.started = true;
    switch (ev.t) {
      case 'answering':
        this.phase = 'answering';
        return [];
      case 'thinking':
        this.c.thinkingSeconds = Math.round((this.c.thinkingSeconds + ev.seconds) * 10) / 10;
        if (this.phase !== 'answering') this.phase = 'thinking';
        return ev.seconds >= MIN_THOUGHT_LINE_SECONDS ? this.row('thinking', { kind: 'thinking', seconds: ev.seconds }) : [];
      case 'plan': {
        const entries = ev.entries;
        if (JSON.stringify(entries) === JSON.stringify(this.plan)) return [];
        this.plan = entries;
        this.planVersion += 1;
        return this.row('plan', { kind: 'plan', entries });
      }
      case 'agent': {
        const prior = this.helperMap.get(ev.agentId);
        const helper: RunHelper = { id: ev.agentId, name: ev.name, status: ev.status, steps: ev.steps };
        this.helperMap.delete(ev.agentId);
        this.helperMap.set(ev.agentId, helper);
        if (prior === undefined) this.c.helpers += 1;
        while (this.helperMap.size > MAX_HELPERS_KEPT) this.helperMap.delete(this.helperMap.keys().next().value as string);
        // only a new helper or a change of its state is a line: its step count moves in the folded state
        if (prior !== undefined && prior.status === ev.status) return [];
        return this.row('agent', { kind: 'agent', agentId: ev.agentId, name: ev.name, status: ev.status, steps: ev.steps, ...(ev.parentStepId !== undefined ? { parentStepId: ev.parentStepId } : {}) });
      }
      case 'tool': {
        this.phase = 'idle';
        const id = ev.stepId ?? `auto-${(this.autoId += 1)}`;
        const step: Step = { id, name: ev.name, kind: ev.kind, parentId: ev.parentStepId, open: true, title: ev.title, paths: ev.paths, shownTitle: ev.title, shownPaths: ev.paths };
        this.steps.delete(id);
        this.steps.set(id, step);
        this.trimSteps();
        this.c.steps += 1;
        if (ev.kind === 'execute') this.c.commands += 1;
        return this.row('tool', {
          kind: 'tool',
          stepId: id,
          ...(ev.parentStepId !== undefined ? { parentStepId: ev.parentStepId } : {}),
          stepKind: ev.kind,
          ...(ev.title !== undefined ? { title: ev.title } : {}),
          ...(ev.paths !== undefined ? { paths: ev.paths } : {}),
        });
      }
      case 'step': {
        const step = this.steps.get(ev.stepId);
        if (step === undefined) return [];
        if (ev.title !== undefined) step.title = ev.title;
        if (ev.paths !== undefined) step.paths = ev.paths;
        return [];
      }
      case 'result': {
        const step = this.stepOfResult(ev);
        if (step === undefined) return [];
        step.open = false;
        if (!ev.ok) this.c.failed += 1;
        if (ev.diff) {
          this.c.added += ev.diff.added;
          this.c.removed += ev.diff.removed;
        }
        if (ev.ok && EDIT_KINDS.includes(step.kind) && this.changed.size < MAX_CHANGED_FILES) {
          if (step.paths !== undefined && step.paths.length > 0) for (const p of step.paths) this.changed.add(p);
          else this.changed.add(`step:${step.id}`);
        }
        const titleChanged = step.title !== step.shownTitle;
        const pathsChanged = !same(step.paths, step.shownPaths);
        return this.row('tool_result', {
          kind: 'tool_result',
          stepId: step.id,
          ok: ev.ok,
          ...(titleChanged && step.title !== undefined ? { title: step.title } : {}),
          ...(pathsChanged && step.paths !== undefined ? { paths: step.paths } : {}),
          ...(ev.seconds !== undefined ? { seconds: ev.seconds } : {}),
          ...(ev.diff !== undefined ? { diff: ev.diff } : {}),
        });
      }
      case 'approval': {
        if (ev.phase === 'asked') this.waiting = true;
        else this.waiting = false;
        return this.row('approval', {
          kind: 'approval',
          outcome: ev.phase,
          ...(ev.stepId !== undefined ? { stepId: ev.stepId } : {}),
          ...(ev.kind !== undefined ? { stepKind: ev.kind } : {}),
          ...(ev.title !== undefined ? { title: ev.title } : {}),
          ...(ev.paths !== undefined ? { paths: ev.paths } : {}),
          ...(ev.diff !== undefined ? { diff: ev.diff } : {}),
        });
      }
    }
  }

  /** A person's question was answered (or the run went on): the run is no longer waiting. */
  settle(outcome: 'approved' | 'denied' | 'ended'): FoldRow[] {
    if (this.ended !== null) return [];
    this.waiting = false;
    return this.row('approval', { kind: 'approval', outcome });
  }

  /** Somebody asked for the stop; the run says `stopping` until it ends. */
  markStopping(by: string | null): void {
    if (this.ended === null) this.stopper = by ?? 'Someone';
  }

  /** The run is over. Open steps are closed; the folded state keeps what it had. */
  finish(state: 'done' | 'failed' | 'stopped', extra: { stopReason?: string | null; cost?: RunCost | null } = {}): void {
    this.ended = state;
    for (const s of this.steps.values()) s.open = false;
    this.phase = 'idle';
    this.waiting = false;
    this.stopReason = extra.stopReason ?? null;
    this.cost = extra.cost ?? null;
    for (const [id, h] of this.helperMap) if (h.status === 'working') this.helperMap.set(id, { ...h, status: state === 'failed' ? 'failed' : 'done' });
  }

  get state(): RunViewState {
    if (this.ended !== null) return this.ended;
    if (this.stopper !== null) return 'stopping';
    if (this.waiting) return 'waiting';
    return this.started ? 'working' : 'starting';
  }
  get lastSeq(): number {
    return this.seq;
  }

  counts(): RunCounts {
    return { ...this.c, filesChanged: this.changed.size };
  }
  planSummary(): RunPlanSummary {
    return summarizePlan(this.plan);
  }
  helpers(): RunHelper[] {
    return [...this.helperMap.values()];
  }

  /** What the run is doing right now, in one line. */
  now(): RunNow | null {
    if (this.ended !== null) return null;
    const open = [...this.steps.values()].filter((s) => s.open);
    const last = open[open.length - 1];
    if (last !== undefined) {
      const peers = open.filter((s) => s.kind === last.kind && s.parentId === last.parentId).length;
      const helper = last.parentId === undefined ? undefined : this.helperMap.get(last.parentId);
      return { kind: last.kind, title: last.title ?? null, paths: last.paths ?? [], helper: helper?.name ?? null, count: Math.min(999, Math.max(1, peers)) };
    }
    if (this.phase === 'answering') return { kind: 'answering', title: null, paths: [], helper: null, count: 1 };
    if (this.phase === 'thinking') return { kind: 'thinking', title: null, paths: [], helper: null, count: 1 };
    return null;
  }

  /** The folded state a card draws (the body of a `run.activity` push, without its ids). */
  progress(): RunProgress {
    return {
      state: this.state,
      now: this.now(),
      counts: this.counts(),
      plan: this.planSummary(),
      planVersion: this.planVersion,
      helpers: this.helpers().slice(-MAX_HELPERS_PUSHED),
      seq: this.seq,
      // only a run that is stopping or was stopped says who asked: a run that ended by itself before the Stop took effect was not stopped by anybody
      stoppedBy: this.state === 'stopping' || this.ended === 'stopped' ? this.stopper : null,
    };
  }

  /** The columns of `run_view` the fold owns. */
  viewColumns(): {
    state: RunViewState;
    now_step: RunNow | null;
    counts: RunCounts;
    helpers: RunHelper[];
    plan: RunPlanEntry[];
    plan_version: number;
    last_seq: number;
    stop_reason: string | null;
    cost: RunCost | null;
  } {
    return {
      state: this.state,
      now_step: this.now(),
      counts: this.counts(),
      helpers: this.helpers(),
      plan: this.plan,
      plan_version: this.planVersion,
      last_seq: this.seq,
      stop_reason: this.stopReason,
      cost: this.cost,
    };
  }

  private row(kind: RunActivityKind, payload: RunActivityPayload): FoldRow[] {
    if (this.seq + 1 >= this.maxRows) {
      this.c.omitted += 1;
      return [];
    }
    this.seq += 1;
    return [{ seq: this.seq, kind, payload }];
  }

  private stepOfResult(ev: Extract<SlimEvent, { t: 'result' }>): Step | undefined {
    if (ev.stepId !== undefined) return this.steps.get(ev.stepId);
    // a gateway that names no step ids (the Hermes gateway): the oldest open step of that tool
    for (const s of this.steps.values()) if (s.open && s.name === ev.name && s.id.startsWith('auto-')) return s;
    return undefined;
  }

  private trimSteps(): void {
    if (this.steps.size <= MAX_STEPS_KEPT) return;
    for (const [id, s] of this.steps) {
      if (this.steps.size <= MAX_STEPS_KEPT) break;
      if (!s.open) this.steps.delete(id);
    }
  }
}

// ---- the push ---------------------------------------------------------------------------------------------------------------------

/** A `run.activity` push stays under this many bytes of JSON (a push is capped near 7 KB). */
export const PUSH_BUDGET_BYTES = 5500;
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/**
 * Make a push of the folded state fit. Words are cut first (titles, then paths, then helper names), then whole parts go (older helpers, the paths, the plan's line),
 * until it fits. The counts and the state are never cut, so a card is always right about where the run is.
 */
export function fitPush<T extends RunProgress>(push: T, budget: number = PUSH_BUDGET_BYTES): T {
  if (bytes(push) <= budget) return push;
  const cut = (s: string | null, n: number): string | null => (s === null ? null : [...s].slice(0, n).join(''));
  let p: T = { ...push };
  const steps: ((q: T) => T)[] = [
    (q) => ({ ...q, now: q.now === null ? null : { ...q.now, title: cut(q.now.title, 120), paths: q.now.paths.slice(0, 2).map((x) => cut(x, 120) ?? '') }, plan: { ...q.plan, current: cut(q.plan.current, 120) } }),
    (q) => ({ ...q, helpers: q.helpers.slice(-3).map((h) => ({ ...h, name: cut(h.name, 40) ?? '' })) }),
    (q) => ({ ...q, now: q.now === null ? null : { ...q.now, title: cut(q.now.title, 40), paths: [], helper: cut(q.now.helper, 40) }, plan: { ...q.plan, current: cut(q.plan.current, 40) } }),
    (q) => ({ ...q, helpers: [] }),
    (q) => ({ ...q, now: q.now === null ? null : { ...q.now, title: null, helper: null }, plan: { ...q.plan, current: null } }),
  ];
  for (const step of steps) {
    p = step(p);
    if (bytes(p) <= budget) return p;
  }
  return p;
}
