import type { RunActivityItem, RunDiff, RunStepKind } from '@manythreads/shared';
import { baseName, clip, commandOf, plural, STEP_VERB } from './words';

/*
 * The step list of a run (PLAN P25-11, docs/plans/acp.md section 5.2): the kept lines folded into what a person reads.
 *  - a step starts with a `tool` line and ends with a `tool_result` line (which may refine its title and paths);
 *  - steps in a row of the same kind that went well fold into one ("Read 6 files"); a step that is still going or failed never folds;
 *  - a helper (an `agent` line) is one row; the steps that name it as their parent are inside it, indented, with its own status;
 *  - a stretch of thinking is "Thought for 12 s", with no text; a question to a person is one row with its answer.
 * Pure: the same lines always give the same rows.
 */

export type StepStatus = 'working' | 'done' | 'failed';

export interface StepRow {
  type: 'step';
  id: string;
  kind: RunStepKind;
  /** The sentence of the step (its title, or a verb and a file). */
  text: string;
  /** The program of a command, drawn in mono after the sentence ("Ran" + "pnpm"). */
  code: string | null;
  /** File names to show as chips, not already in the text. */
  files: string[];
  status: StepStatus;
  seconds: number | null;
  diff: RunDiff | null;
  /** The step waited for a person's yes or no: its answer, said on the step's own line (one line per step, not a second row). */
  answer?: QuestionRow['outcome'];
}

export interface GroupRow {
  type: 'group';
  /** The id of its first step: stable while the group grows. */
  id: string;
  kind: RunStepKind;
  text: string;
  steps: StepRow[];
}

export interface HelperRow {
  type: 'helper';
  id: string;
  name: string;
  status: StepStatus;
  stepCount: number;
  rows: Row[];
}

export interface ThinkingRow {
  type: 'thinking';
  id: string;
  seconds: number;
}

export interface QuestionRow {
  type: 'question';
  id: string;
  outcome: 'asked' | 'approved' | 'denied' | 'ended';
  /** What it asked to do, as a verb phrase ("Run", "Edit ThreadPanel.tsx"). */
  text: string;
  /** The program of a command it asked to run, in mono. */
  code: string | null;
}

export type Row = StepRow | GroupRow | HelperRow | ThinkingRow | QuestionRow;

/** Steps in a row of the same kind fold from this many. */
export const FOLD_FROM = 3;

// `other` steps never fold: each has its own title ("Handed the card to Code reviewer"), and "3 other steps" would hide what they did
const FOLDABLE: ReadonlySet<RunStepKind> = new Set(['read', 'search', 'edit', 'execute', 'fetch']);

/** "Read 6 files", "Ran 3 commands": what a folded group says. */
export function groupText(kind: RunStepKind, n: number): string {
  switch (kind) {
    case 'read':
      return `Read ${plural(n, 'file', 'files')}`;
    case 'edit':
      return `Edited ${plural(n, 'file', 'files')}`;
    case 'execute':
      return `Ran ${plural(n, 'command', 'commands')}`;
    case 'search':
      return `Searched ${plural(n, 'time', 'times')}`;
    case 'fetch':
      return `Read ${plural(n, 'web page', 'web pages')}`;
    default:
      return plural(n, 'other step', 'other steps');
  }
}

/** A step's sentence: its title when it has one, else the verb of its kind and its first file. */
function sentence(kind: RunStepKind, title: string | undefined, paths: readonly string[]): string {
  const t = title?.trim() ?? '';
  if (t !== '') return clip(t, 120);
  const file = paths[0] !== undefined ? baseName(paths[0]) : '';
  const verb = STEP_VERB[kind] ?? 'Did a step';
  return file !== '' && (kind === 'read' || kind === 'edit' || kind === 'delete' || kind === 'move') ? `${verb} ${file}` : verb;
}

interface Draft {
  id: string;
  parent: string | undefined;
  kind: RunStepKind;
  title: string | undefined;
  paths: string[];
  status: StepStatus;
  seconds: number | null;
  diff: RunDiff | null;
  answer?: QuestionRow['outcome'];
}

interface Agent {
  id: string;
  name: string;
  status: StepStatus;
  steps: number;
}

function toRow(d: Draft): StepRow {
  // a command reads "Ran pnpm" (or "Running pnpm" while it runs): the program in mono, said once
  const code = d.kind === 'execute' ? commandOf(d.title) : null;
  const text = d.kind === 'execute' ? (d.status === 'working' ? (code !== null ? 'Running' : 'Running a command') : code !== null ? 'Ran' : 'Ran a command') : sentence(d.kind, d.title, d.paths);
  const files = d.paths.map(baseName).filter((f, i, all) => f !== '' && all.indexOf(f) === i && !text.includes(f)).slice(0, 3);
  return { type: 'step', id: d.id, kind: d.kind, text, code, files, status: d.status, seconds: d.seconds, diff: d.diff, ...(d.answer !== undefined ? { answer: d.answer } : {}) };
}

/** What a question asked to do: "Run" and the program, or its title as a phrase. */
function asked(title: string | undefined, kind: RunStepKind | undefined): { text: string; code: string | null } {
  const t = title?.trim() ?? '';
  if (kind === 'execute' || /^running\s/i.test(t)) {
    const code = commandOf(t);
    return { text: code !== null ? 'Run' : 'Run a command', code };
  }
  if (t !== '') return { text: clip(t, 120), code: null };
  return { text: kind !== undefined ? (STEP_VERB[kind] ?? 'A step') : 'A step', code: null };
}

/** Folds a run of consecutive finished steps of one kind into a group; every other row stays as it is. */
export function foldRows(rows: readonly Row[]): Row[] {
  const out: Row[] = [];
  let run: StepRow[] = [];
  const flush = (): void => {
    if (run.length >= FOLD_FROM) out.push({ type: 'group', id: run[0]!.id, kind: run[0]!.kind, text: groupText(run[0]!.kind, run.length), steps: run });
    else out.push(...run);
    run = [];
  };
  for (const row of rows) {
    const foldable = row.type === 'step' && row.status === 'done' && FOLDABLE.has(row.kind) && (run.length === 0 || run[0]!.kind === row.kind);
    if (foldable) {
      run.push(row);
      continue;
    }
    flush();
    if (row.type === 'step' && row.status === 'done' && FOLDABLE.has(row.kind)) run.push(row);
    else out.push(row);
  }
  flush();
  return out;
}

/** The rows of a run's kept lines, oldest first. */
export function buildRows(items: readonly RunActivityItem[]): Row[] {
  const steps = new Map<string, Draft>();
  const agents = new Map<string, Agent>();
  /** The order things began in: step ids, agent ids, and line markers for thinking and questions. */
  const order: Array<{ key: string; at: number }> = [];
  const loose = new Map<string, Row>();
  /** The newest question with no answer yet: an answer line that does not name its step answers it. */
  let openAsk: string | null = null;
  items.forEach((item, at) => {
    const p = item.payload;
    switch (p.kind) {
      case 'tool': {
        if (!steps.has(p.stepId)) order.push({ key: `s:${p.stepId}`, at });
        steps.set(p.stepId, {
          id: p.stepId,
          parent: p.parentStepId,
          kind: p.stepKind,
          title: p.title,
          paths: [...(p.paths ?? [])],
          status: 'working',
          seconds: null,
          diff: null,
        });
        return;
      }
      case 'tool_result': {
        const d = steps.get(p.stepId);
        if (!d) return;
        d.status = p.ok ? 'done' : 'failed';
        if (p.title !== undefined) d.title = p.title;
        if (p.paths !== undefined) d.paths = [...p.paths];
        if (p.seconds !== undefined) d.seconds = p.seconds;
        if (p.diff !== undefined) d.diff = p.diff;
        return;
      }
      case 'agent': {
        const prior = agents.get(p.agentId);
        if (!prior) order.push({ key: `a:${p.agentId}`, at });
        agents.set(p.agentId, { id: p.agentId, name: p.name, status: p.status, steps: p.steps });
        return;
      }
      case 'thinking': {
        const key = `t:${item.seq}`;
        order.push({ key, at });
        loose.set(key, { type: 'thinking', id: key, seconds: p.seconds });
        return;
      }
      case 'approval': {
        // a question and its answer are two lines of the same step; the answer replaces the question in its place
        // a question about a step that is in the list is said on that step's line
        const onStep = p.stepId !== undefined ? steps.get(p.stepId) : undefined;
        if (onStep !== undefined) {
          onStep.answer = p.outcome;
          openAsk = p.outcome === 'asked' ? `d:${p.stepId}` : openAsk === `d:${p.stepId}` ? null : openAsk;
          return;
        }
        if (p.outcome !== 'asked' && p.stepId === undefined && openAsk?.startsWith('d:')) {
          const d = steps.get(openAsk.slice(2));
          if (d !== undefined) d.answer = p.outcome;
          openAsk = null;
          return;
        }
        let key = p.stepId !== undefined ? `q:${p.stepId}` : `q:${item.seq}`;
        if (p.outcome !== 'asked' && !loose.has(key) && openAsk !== null) key = openAsk;
        const prior = loose.get(key);
        const words = p.title !== undefined && p.title.trim() !== '' ? asked(p.title, p.stepKind) : prior?.type === 'question' ? { text: prior.text, code: prior.code } : asked(undefined, p.stepKind);
        if (!loose.has(key)) order.push({ key, at });
        loose.set(key, { type: 'question', id: key, outcome: p.outcome, ...words });
        openAsk = p.outcome === 'asked' ? key : openAsk === key ? null : openAsk;
        return;
      }
      case 'plan':
        return; // the plan has its own view
    }
  });

  // a helper's own step line (the `Agent` call itself) is the helper's row, not a step
  for (const id of agents.keys()) steps.delete(id);

  const childrenOf = new Map<string, Draft[]>();
  for (const d of steps.values()) {
    if (d.parent !== undefined && agents.has(d.parent)) childrenOf.set(d.parent, [...(childrenOf.get(d.parent) ?? []), d]);
  }

  const rows: Row[] = [];
  for (const o of order) {
    const [type, id] = [o.key[0], o.key.slice(2)];
    if (type === 's') {
      const d = steps.get(id);
      if (d && !(d.parent !== undefined && agents.has(d.parent))) rows.push(toRow(d));
    } else if (type === 'a') {
      const a = agents.get(id)!;
      const kids = (childrenOf.get(id) ?? []).map(toRow);
      rows.push({ type: 'helper', id: a.id, name: a.name, status: a.status, stepCount: Math.max(a.steps, kids.length), rows: foldRows(kids) });
    } else {
      const r = loose.get(o.key);
      if (r) rows.push(r);
    }
  }
  return foldRows(rows);
}

/** How many rows a long list draws before "Show all N": the last ones, because the newest is what a person looks for. */
export const TAIL_ROWS = 8;
/** A list longer than this is drawn this many rows at a time. */
export const PAGE_ROWS = 100;

/** "6 steps" for a helper's row. */
export const helperSteps = (n: number): string => plural(n, 'step', 'steps');

/** The most helpers drawn before "+N more helpers". */
export const HELPERS_SHOWN = 3;

/**
 * Which helpers fold behind "+N more": the oldest finished ones beyond the first `HELPERS_SHOWN`. A helper that is working or failed is always drawn (it is what a person looks
 * for), and so are the newest. Returns the ids to hide.
 */
export function helpersToHide(rows: readonly Row[], shown = HELPERS_SHOWN): Set<string> {
  const helpers = rows.filter((r): r is HelperRow => r.type === 'helper');
  const pinned = helpers.filter((h) => h.status !== 'done').length;
  let room = Math.max(0, shown - pinned);
  const keep = new Set<string>();
  for (const h of [...helpers].reverse()) {
    if (h.status !== 'done') keep.add(h.id);
    else if (room > 0) {
      keep.add(h.id);
      room -= 1;
    }
  }
  return new Set(helpers.filter((h) => !keep.has(h.id)).map((h) => h.id));
}
