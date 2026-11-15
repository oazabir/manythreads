import { posix } from 'node:path';
import { redact } from '../process.ts';

// What an ACP adapter says (P25-03), turned into the frames the bridge sends the server (docs/plans/acp.md §3.1).
//
// THE RULE: nothing about a step leaves except what this file reads by name. The adapters put the step's input and output on the wire in
// several places (`rawInput`, `rawOutput`, `_meta.claudeCode.toolResponse`, `_meta.terminal_output_delta`, `_meta.terminal_exit`, `content` text);
// none of them is read here, so none can be forwarded. The fields read are (docs/spikes/acp-measured.md): `toolCallId`, `title`, `kind`, `status`,
// `locations[].path`, the `diff` blocks of `content` (as counts only), `_meta.claudeCode.{toolName, parentToolUseId}` and `_meta.is_mcp_tool_call`.
// `rawInput` is opened in two places only: Hermes' `todo_list` step, whose items ARE the agent's plan (`rawInput.todos`, measured on Hermes 0.21.5), and
// `approvalOf`, for the one request a person is asked to approve (the command, or the plan to implement, so the card shows what will run). Both are clipped
// and redacted. A step's own title carries no command line: an `execute` step is "Running <program>", a link has no user, password or query, and a path outside
// the run's folder is not named. Reasoning text is counted in time and dropped.

export type Sink = (event: string, fields: Record<string, unknown>) => void;

export const MAX_TITLE_CHARS = 160;
export const MAX_PATH_CHARS = 200;
export const MAX_PATHS = 5;
const MAX_PLAN_ITEMS = 30;
const MAX_PLAN_CHARS = 200;
/** Text is cut to this many characters before the secrets are removed, so no token is split by the cut that matters (the final cut is far shorter and comes after). */
const PRE_CUT = 4096;
/** A partly written word of the answer waits this long for its end (a token must reach `redact` whole). */
const WORD_HOLD_MS = 1000;
const MAX_PENDING_CHARS = 8192;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Secrets out first, then one line, then cut on a character boundary. The cut comes after the removal so a cut can never leave half a secret. */
export function clipText(text: string, max: number, secrets: readonly string[]): string {
  const one = redact(text.slice(0, PRE_CUT), secrets).replace(/\s+/g, ' ').trim();
  const chars = Array.from(one);
  return chars.length <= max ? one : `${chars.slice(0, max - 1).join('')}…`;
}

export const MAX_APPROVAL_CHARS = 2000;
const PRE_CUT_BLOCK = 20_000;

/**
 * Several lines kept as lines (what a person approves: a command, a plan), secrets out first, then cut with a marker that says it was cut and by how much.
 * The text is cut at `PRE_CUT_BLOCK` before the removal and at `max` after it, so a cut never leaves half a secret in what is shown.
 */
export function clipBlock(text: string, max: number, secrets: readonly string[]): string {
  const clean = redact(text.slice(0, PRE_CUT_BLOCK), secrets)
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  const chars = Array.from(clean);
  if (chars.length <= max && text.length <= PRE_CUT_BLOCK) return clean;
  const more = chars.length - max + Math.max(0, text.length - PRE_CUT_BLOCK);
  return `${chars.slice(0, max).join('').trimEnd()}\n… [cut: ${text.length > PRE_CUT_BLOCK ? 'more than ' : ''}${Math.max(1, more)} more characters not shown]`;
}

export const OUTSIDE = 'a file outside the project';

/** A path as the run's folder sees it: relative inside it, "a file outside the project" outside it (also when `..` leads out of it). */
export function relativePath(path: string, cwd: string): string {
  if (path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)) return OUTSIDE;
  const base = posix.normalize(cwd).replace(/\/+$/, '');
  const n = posix.normalize(path);
  if (n === base) return '.';
  if (n.startsWith(`${base}/`)) return n.slice(base.length + 1);
  if (n.startsWith('/')) return OUTSIDE;
  if (n === '..' || n.startsWith('../')) return OUTSIDE;
  return n;
}

// A link in a title: the user, the password, the query and the fragment are not kept (they carry tokens and what was searched for).
const LINK = /\b[a-z][a-z0-9+.-]{1,10}:\/\/[^\s"'<>)\]]{1,2000}/gi;
const cleanLink = (link: string): string => {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#]*@)?([^?#]*)/i.exec(link);
  return m ? `${m[1]!}${m[2]!}` : 'a link';
};
// A path in a title: relative inside the run's folder, not named outside it.
const ABS_PATH = /(?<![\w./:~@%+=-])\/[\w.@%+=~/-]{1,500}/g;
const HOME_PATH = /(?<![\w.])~\/[\w.@%+=~/-]{0,500}/g;
const WIN_PATH = /(?<![\w])[A-Za-z]:[\\/][^\s"'<>|]{1,500}/g;
const DOTDOT_PATH = /(?<![\w.])\.\.\/[\w.@%+=~/-]{0,500}/g;

/** One line of free text for a title: secrets, links and paths made safe, the folder's own path left out. */
function scrubTitle(text: string, cx: ViewContext): string {
  // Links first: what follows a `?` or an `@` goes whole, before the secrets are looked for (a `[hidden]` mark would end the link early).
  let t = redact(text.slice(0, PRE_CUT).replace(LINK, cleanLink), cx.secrets);
  // A folder that is not an absolute path (the recorded sessions write it `<cwd>`) is cut out as written.
  const base = cx.cwd.replace(/\/+$/, '');
  if (base !== '' && !base.startsWith('/')) t = t.split(`${base}/`).join('').split(base).join('.');
  t = t.replace(ABS_PATH, (p) => {
    const trail = /[.,]+$/.exec(p)?.[0] ?? '';
    return relativePath(trail === '' ? p : p.slice(0, -trail.length), cx.cwd) + trail;
  });
  return t.replace(HOME_PATH, OUTSIDE).replace(WIN_PATH, OUTSIDE).replace(DOTDOT_PATH, OUTSIDE);
}

/** The program a command line starts: `git status` and `/usr/bin/git status` and `FOO=1 git status` are `git`; null when it is not a plain program name. */
export function programOf(command: string): string | null {
  let t = command.trim();
  t = t.replace(/^[A-Za-z_][\w-]{0,30}:\s+/, (m) => (/^(terminal|bash|shell|sh|execute|run|command)/i.test(m) ? '' : m));
  const wrap = /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-[a-z]*c\s+(.+)$/is.exec(t);
  if (wrap) t = wrap[1]!.trim().replace(/^["']/, '');
  const tokens = t.split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
  // `cd dir && git status` is about `git`.
  if (tokens[i] === 'cd' && tokens.length > i + 2 && /^(&&|;)$/.test(tokens[i + 2]!)) i += 3;
  const first = (tokens[i] ?? '').replace(/^[("'`]+/, '');
  const name = first.slice(first.lastIndexOf('/') + 1);
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(name) ? name : null;
}

/** The words a step shows for a command: what kind of thing runs, never the line itself (it may hold a token, a password or a person's data). */
export const runningLabel = (command: string): string => {
  const program = /^(terminal|bash|shell|run command|command|execute)$/i.test(command.trim()) ? null : programOf(command);
  return program === null ? 'Running a command' : `Running ${program}`;
};

/** Added and removed line counts of a diff block: lines that appear on one side only (an unchanged line of context counts for neither). */
export function diffCounts(oldText: string | null | undefined, newText: string): { added: number; removed: number } {
  const lines = (t: string): string[] => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
  const before = new Map<string, number>();
  for (const l of lines(oldText ?? '')) before.set(l, (before.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of lines(newText)) {
    const n = before.get(l) ?? 0;
    if (n > 0) before.set(l, n - 1);
    else added += 1;
  }
  let removed = 0;
  for (const n of before.values()) removed += n;
  return { added, removed };
}

export type StepKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
const KINDS: ReadonlySet<string> = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
const kindOf = (v: unknown): StepKind => (typeof v === 'string' && KINDS.has(v) ? (v as StepKind) : 'other');

/** What a permission card says the step is, in plain words (the person never reads a tool name). */
export const KIND_WORDS: Record<StepKind, string> = {
  read: 'Read files',
  edit: 'Edit files',
  delete: 'Delete files',
  move: 'Move files',
  search: 'Search the code',
  execute: 'Run a command',
  think: 'Think it over',
  fetch: 'Read the web',
  switch_mode: 'Change how it works',
  other: 'Use a tool',
};

/** The whitelisted view of a step, read from a `tool_call`, a `tool_call_update` or the `toolCall` of a permission request. */
export interface StepView {
  id: string;
  title: string | null;
  kind: StepKind | null;
  status: string | null;
  paths: string[];
  diff: { added: number; removed: number } | null;
  toolName: string;
  parentId: string | null;
  isMcpMeta: boolean;
  /** The raw title (not yet cleaned), for the few places that must read its first words. */
  rawTitle: string;
}

export interface ViewContext {
  cwd: string;
  secrets: readonly string[];
}

/** `known`: the kind this step was announced with (Claude's refining update carries a title and no kind, and the title of a command must still be read as one). */
export function viewOf(raw: unknown, cx: ViewContext, known: StepKind | null = null): StepView | null {
  if (!isRecord(raw)) return null;
  const id = str(raw['toolCallId']);
  if (id === '') return null;
  const meta = isRecord(raw['_meta']) ? raw['_meta'] : {};
  const claude = isRecord(meta['claudeCode']) ? meta['claudeCode'] : {};
  const paths: string[] = [];
  const addPath = (p: unknown): void => {
    if (typeof p !== 'string' || p === '') return;
    const rel = clipText(relativePath(p, cx.cwd), MAX_PATH_CHARS, cx.secrets);
    if (!paths.includes(rel) && paths.length < MAX_PATHS) paths.push(rel);
  };
  if (Array.isArray(raw['locations'])) for (const l of raw['locations']) if (isRecord(l)) addPath(l['path']);
  let diffAdded = 0;
  let diffRemoved = 0;
  let hasDiff = false;
  if (Array.isArray(raw['content'])) {
    for (const block of raw['content']) {
      if (!isRecord(block) || block['type'] !== 'diff' || typeof block['newText'] !== 'string') continue;
      // Real Codex edits have no `locations`: the path is only in the diff block.
      addPath(block['path']);
      const c = diffCounts(typeof block['oldText'] === 'string' ? block['oldText'] : null, block['newText']);
      hasDiff = true;
      diffAdded += c.added;
      diffRemoved += c.removed;
    }
  }
  const diff = hasDiff ? { added: diffAdded, removed: diffRemoved } : null;
  const rawTitle = str(raw['title']);
  const kind = typeof raw['kind'] === 'string' ? kindOf(raw['kind']) : null;
  return {
    id,
    title: rawTitle === '' ? null : titleOf(rawTitle, kind ?? known, cx),
    kind,
    status: typeof raw['status'] === 'string' ? raw['status'] : null,
    paths,
    diff,
    toolName: str(claude['toolName']),
    parentId: str(claude['parentToolUseId']) || null,
    isMcpMeta: meta['is_mcp_tool_call'] === true,
    rawTitle,
  };
}

/** A step's title: "Running <program>" for a command, else the adapter's own words with secrets, link details and outside paths taken out, on one line, cut. */
function titleOf(title: string, kind: StepKind | null, cx: ViewContext): string {
  if (kind === 'execute' && !MCP_TITLE.test(title)) return runningLabel(title);
  return clipText(scrubTitle(title, cx), MAX_TITLE_CHARS, cx.secrets);
}
/** Codex and Hermes title a call of an MCP tool as `mcp.server.tool` or `mcp__server__tool: arguments`; `mcpToolOf` handles those (the arguments are dropped). */
const MCP_TITLE = /^mcp(?:\.|__)/;

/**
 * What a person is shown to approve one request (the one place besides `todo_list` where `rawInput` is read): the command itself for a command, the plan for a
 * plan to implement, else the title. Several lines, secrets out, up to 2000 characters, with a mark where it was cut. `label` is the short title of the card.
 */
export function approvalOf(toolCall: unknown, cx: ViewContext): { text: string; label: string | null } {
  const raw = isRecord(toolCall) ? toolCall : {};
  const input = isRecord(raw['rawInput']) ? raw['rawInput'] : {};
  const kind = typeof raw['kind'] === 'string' ? kindOf(raw['kind']) : null;
  const title = str(raw['title']);
  if (kind === 'switch_mode' && typeof input['plan'] === 'string' && input['plan'].trim() !== '') return { text: clipBlock(input['plan'], MAX_APPROVAL_CHARS, cx.secrets), label: title === '' ? null : clipText(title, MAX_TITLE_CHARS, cx.secrets) };
  if (kind === 'execute') {
    const command = typeof input['command'] === 'string' && input['command'].trim() !== '' ? input['command'] : title;
    if (command.trim() !== '' && !MCP_TITLE.test(command)) return { text: clipBlock(command, MAX_APPROVAL_CHARS, cx.secrets), label: runningLabel(command) };
  }
  return { text: title === '' ? '' : clipBlock(title, MAX_APPROVAL_CHARS, cx.secrets), label: null };
}

/** `mcp.manythreads.mt_note` (Codex) and `mcp__manythreads__mt_note: hi` (Hermes) both name a tool of an MCP server; the arguments in a title are never kept. */
export function mcpToolOf(view: Pick<StepView, 'toolName' | 'rawTitle' | 'isMcpMeta'>): string | null {
  if (view.toolName.startsWith('mcp__')) return view.toolName;
  const head = view.rawTitle.split(':')[0]!.trim();
  const dotted = /^mcp\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)$/.exec(head);
  if (dotted) return `mcp__${dotted[1]!}__${dotted[2]!}`;
  if (/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/.test(head)) return head;
  return view.isMcpMeta ? head.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'mcp' : null;
}

/** The server of an MCP tool name (`mcp__manythreads__x` is `manythreads`). */
export const mcpServerOf = (tool: string): string | null => /^mcp__([^_](?:[^_]|_(?!_))*)__/.exec(tool)?.[1] ?? null;

const HIDDEN_TOOLS = new Set(['SubagentHandback', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite']);
/** Steps that only load or check things for the agent: nothing a person needs to see (Hermes `tool_search`/`tool_describe`, Claude's hand-back, Codex's review). */
export function isHiddenStep(view: Pick<StepView, 'toolName' | 'rawTitle'>): boolean {
  if (HIDDEN_TOOLS.has(view.toolName)) return true;
  const t = view.rawTitle;
  return /^(tool_search|tool_describe)\b/.test(t) || /^Guardian Review\b/.test(t);
}

type HelperKind = 'claude' | 'codex-start' | 'codex-complete' | 'hermes';
function helperOf(view: Pick<StepView, 'toolName' | 'rawTitle'>): HelperKind | null {
  if (view.toolName === 'Agent') return 'claude';
  if (/^Start subagent /.test(view.rawTitle)) return 'codex-start';
  if (/^Complete subagent /.test(view.rawTitle)) return 'codex-complete';
  if (/^delegate_task\b/.test(view.rawTitle)) return 'hermes';
  return null;
}

interface Step {
  id: string;
  title: string;
  kind: StepKind;
  paths: string[];
  status: string | null;
  startedAt: number;
  parentId: string | null;
  tool: string;
  mcp: boolean;
  hidden: boolean;
  /** Hermes' `todo_list` step: its items are the plan. */
  todo: boolean;
  helper: HelperKind | null;
  helperName: string;
  diff: { added: number; removed: number } | null;
  done: boolean;
}

interface Helper {
  id: string;
  name: string;
  status: 'working' | 'done' | 'failed';
  steps: number;
}

export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const planStatus = (v: unknown): PlanEntry['status'] => (v === 'in_progress' ? 'in_progress' : v === 'completed' || v === 'cancelled' || v === 'done' ? 'completed' : 'pending');

export interface FramesOptions extends ViewContext {
  emit: Sink;
  now?: () => number;
}

/**
 * Folds one run's `session/update` notifications into frames. One instance per run (per prompt): it keeps the open steps, the helpers, the last plan, the
 * answer text and the thinking burst.
 */
export class Frames {
  private readonly steps = new Map<string, Step>();
  private readonly helpers = new Map<string, Helper>();
  private readonly codexHelpers = new Map<string, string>();
  private readonly hermesTodos = new Map<string, PlanEntry>();
  private lastPlan = '';
  private readonly now: () => number;
  private pending = '';
  private holdTimer: NodeJS.Timeout | undefined;
  private thinkingFrom: number | null = null;
  private thinkingLast = 0;
  private text = '';
  private used: number | null = null;
  private costAmount: number | null = null;
  private costCurrency = 'USD';
  /** Steps that were started (not hidden, not helpers) and the files they touched: the run's own tally. */
  stepCount = 0;
  /**
   * The model's turns as far as the stream shows them: each tool call of the agent itself (a helper's own steps are not counted) and each stretch of text that
   * follows one. The CLI driver counts the model's replies; this is the same count, and a little high where a reply made several calls at once.
   */
  turns = 0;
  /** The names of the MCP tools the agent called (`mcp__<server>__<tool>`), in the order they were first seen. */
  readonly mcpTools = new Set<string>();
  /** A step started since the last text: the next text starts a new paragraph. */
  private afterStep = false;
  private inText = false;

  constructor(private readonly o: FramesOptions) {
    this.now = o.now ?? Date.now;
  }

  // ---- frames out --------------------------------------------------------------------------------------------------------------------

  private send(event: string, fields: Record<string, unknown>): void {
    this.flushText();
    this.o.emit(event, fields);
  }

  /** Everything the agent wrote as its answer, secrets removed. */
  answer(): string {
    return redact(this.text, this.o.secrets).trim();
  }

  cost(): { amount: number; currency: string } | null {
    return this.costAmount === null ? null : { amount: this.costAmount, currency: this.costCurrency };
  }

  contextUsed(): number | null {
    return this.used;
  }

  step(id: string): { title: string; kind: StepKind; paths: string[]; mcp: boolean; tool: string; hidden: boolean; diff: { added: number; removed: number } | null } | undefined {
    return this.steps.get(id);
  }

  // ---- the answer text ------------------------------------------------------------------------------------------------------------------

  private pushText(raw: string): void {
    this.endThinking();
    let chunk = raw;
    if (this.afterStep) {
      // Text before a step and text after it are two stretches of the answer: the adapters send them with nothing between ("Let me look.Done.").
      this.afterStep = false;
      if (this.text !== '' && !/\n\s*$/.test(this.text)) {
        this.text = this.text.replace(/[ \t]+$/, '');
        chunk = `\n\n${chunk.replace(/^[ \t]+/, '')}`;
      }
    }
    if (!this.inText) {
      this.inText = true;
      this.turns += 1;
    }
    this.text += chunk;
    this.pending += chunk;
    const cut = Math.max(this.pending.lastIndexOf(' '), this.pending.lastIndexOf('\n'), this.pending.lastIndexOf('\t'));
    if (cut >= 0) {
      const whole = this.pending.slice(0, cut + 1);
      this.pending = this.pending.slice(cut + 1);
      this.o.emit('message.delta', { delta: redact(whole, this.o.secrets) });
    }
    clearTimeout(this.holdTimer);
    if (this.pending.length >= MAX_PENDING_CHARS) this.flushText();
    else if (this.pending !== '') {
      this.holdTimer = setTimeout(() => this.flushText(), WORD_HOLD_MS);
      this.holdTimer.unref();
    }
  }

  /** Closes a thinking burst and sends the answer's partly written word: call before emitting any frame of your own, so the order stays true. */
  settle(): void {
    this.endThinking();
    this.flushText();
  }

  /** The partly written last word goes out too (called before any other frame, so the order stays true, and when the turn ends). */
  flushText(): void {
    clearTimeout(this.holdTimer);
    if (this.pending === '') return;
    const rest = this.pending;
    this.pending = '';
    this.o.emit('message.delta', { delta: redact(rest, this.o.secrets) });
  }

  // ---- thinking -------------------------------------------------------------------------------------------------------------------------

  private noteThought(): void {
    const t = this.now();
    this.thinkingFrom ??= t;
    this.thinkingLast = t;
  }

  /** One frame per burst of reasoning, with its length in seconds and no text. */
  private endThinking(): void {
    if (this.thinkingFrom === null) return;
    const seconds = Math.round(((this.thinkingLast - this.thinkingFrom) / 1000) * 10) / 10;
    this.thinkingFrom = null;
    this.flushText();
    this.o.emit('thinking', { seconds });
  }

  // ---- updates --------------------------------------------------------------------------------------------------------------------------

  /** One `session/update`'s `update` object. Unknown kinds (commands, titles, modes, config, notices) are ignored. */
  update(raw: unknown): void {
    if (!isRecord(raw)) return;
    switch (raw['sessionUpdate']) {
      case 'agent_message_chunk': {
        const c = raw['content'];
        if (isRecord(c) && c['type'] === 'text' && typeof c['text'] === 'string' && c['text'] !== '') this.pushText(c['text']);
        break;
      }
      case 'agent_thought_chunk':
        this.noteThought();
        break;
      case 'tool_call':
      case 'tool_call_update': {
        this.endThinking();
        const id = raw['toolCallId'];
        const view = viewOf(raw, this.o, typeof id === 'string' ? (this.steps.get(id)?.kind ?? null) : null);
        // An update for a step never announced and with nothing to show (Codex ends its "Implement this plan?" request like that) is not a step.
        const orphan = raw['sessionUpdate'] === 'tool_call_update' && view !== null && !this.steps.has(view.id) && view.rawTitle === '' && view.kind === null;
        if (view && !orphan) this.onStep(view, raw);
        break;
      }
      case 'plan':
        this.endThinking();
        this.onPlan(raw['entries']);
        break;
      case 'usage_update': {
        if (typeof raw['used'] === 'number' && Number.isFinite(raw['used'])) this.used = raw['used'];
        const cost = raw['cost'];
        // Claude's amount is cumulative for its session, and a run is one process: the last one seen is the run's cost.
        if (isRecord(cost) && typeof cost['amount'] === 'number' && Number.isFinite(cost['amount']) && cost['amount'] >= 0) {
          this.costAmount = cost['amount'];
          this.costCurrency = typeof cost['currency'] === 'string' && /^[A-Z]{3}$/.test(cost['currency']) ? cost['currency'] : 'USD';
        }
        break;
      }
      default:
    }
  }

  private onPlan(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    const list: PlanEntry[] = [];
    for (const e of entries.slice(0, MAX_PLAN_ITEMS)) {
      if (!isRecord(e)) continue;
      const content = clipText(scrubTitle(str(e['content']), this.o), MAX_PLAN_CHARS, this.o.secrets);
      if (content !== '') list.push({ content, status: planStatus(e['status']) });
    }
    this.sendPlan(list);
  }

  private sendPlan(list: PlanEntry[]): void {
    const key = JSON.stringify(list);
    if (key === this.lastPlan) return; // Claude sends the same list more than once
    this.lastPlan = key;
    this.send('plan.update', { entries: list });
  }

  /** Hermes 0.21.5 sends no `plan`: its `todo_list` step carries the items, and `merge: true` means "change these by id". */
  private onHermesTodos(raw: unknown): void {
    if (!isRecord(raw) || !isRecord(raw['rawInput'])) return;
    const input = raw['rawInput'];
    const todos = input['todos'];
    if (!Array.isArray(todos)) return;
    if (input['merge'] !== true) this.hermesTodos.clear();
    for (const t of todos.slice(0, MAX_PLAN_ITEMS)) {
      if (!isRecord(t)) continue;
      const key = str(t['id']) || String(this.hermesTodos.size);
      const prior = this.hermesTodos.get(key);
      const content = typeof t['content'] === 'string' ? clipText(scrubTitle(t['content'], this.o), MAX_PLAN_CHARS, this.o.secrets) : (prior?.content ?? '');
      if (content === '') continue;
      this.hermesTodos.set(key, { content, status: t['status'] === undefined ? (prior?.status ?? 'pending') : planStatus(t['status']) });
    }
    this.endThinking();
    this.sendPlan([...this.hermesTodos.values()].slice(0, MAX_PLAN_ITEMS));
  }

  // ---- steps ----------------------------------------------------------------------------------------------------------------------------

  private onStep(view: StepView, raw: Record<string, unknown>): void {
    const existing = this.steps.get(view.id);
    if (!existing) {
      this.afterStep = true;
      this.inText = false;
      if (view.parentId === null) this.turns += 1;
      const hidden = isHiddenStep(view);
      const helper = helperOf(view);
      const mcpTool = mcpToolOf(view);
      const step: Step = {
        id: view.id,
        title: mcpTool ?? view.title ?? '',
        kind: view.kind ?? 'other',
        paths: view.paths,
        status: null,
        startedAt: this.now(),
        parentId: view.parentId,
        tool: mcpTool ?? (view.toolName || view.kind || 'tool'),
        mcp: mcpTool !== null,
        hidden: hidden || helper !== null,
        todo: /^todo_list\b/.test(view.rawTitle),
        helper,
        helperName: '',
        diff: view.diff,
        done: false,
      };
      this.steps.set(view.id, step);
      if (mcpTool !== null) this.mcpTools.add(mcpTool);
      if (step.todo) {
        step.hidden = true;
        this.onHermesTodos(raw);
      }
      if (step.helper !== null) this.startHelper(step, view);
      else if (!step.hidden) {
        this.stepCount += 1;
        if (step.parentId !== null) {
          const parent = this.helpers.get(step.parentId);
          if (parent) parent.steps += 1;
        }
        this.send('tool.started', this.startedFields(step));
      }
      this.applyStatus(step, view.status);
      return;
    }
    // An update: only what changed is looked at.
    if (existing.hidden && existing.helper === null) {
      if (existing.todo) this.onHermesTodos(raw);
      this.applyStatus(existing, view.status);
      return;
    }
    const changed: Record<string, unknown> = {};
    const mcpTool = mcpToolOf(view);
    if (existing.helper === null && !existing.mcp && view.title !== null && view.title !== existing.title) {
      existing.title = view.title;
      changed['title'] = view.title;
    }
    if (mcpTool !== null) this.mcpTools.add(mcpTool);
    if (mcpTool !== null && !existing.mcp) {
      existing.mcp = true;
      existing.tool = mcpTool;
      existing.title = mcpTool;
      changed['title'] = mcpTool;
    }
    if (view.paths.length > 0 && view.paths.join('\n') !== existing.paths.join('\n')) {
      existing.paths = view.paths;
      changed['paths'] = view.paths;
    }
    if (view.kind !== null && view.kind !== existing.kind) existing.kind = view.kind;
    if (view.diff !== null) existing.diff = view.diff;
    if (existing.helper !== null) {
      this.renameHelper(existing, view);
    } else if (!existing.hidden && !existing.done) {
      const starting = view.status === 'in_progress' && existing.status !== 'in_progress';
      if (starting) changed['status'] = 'in_progress';
      if (Object.keys(changed).length > 0 && view.status !== 'completed' && view.status !== 'failed') this.send('step.update', { step_id: existing.id, ...changed });
    }
    this.applyStatus(existing, view.status);
  }

  private startedFields(step: Step): Record<string, unknown> {
    return {
      tool: step.tool,
      preview: step.title,
      step_id: step.id,
      ...(step.parentId !== null ? { parent_step_id: step.parentId } : {}),
      kind: step.kind,
      title: step.title,
      paths: step.paths,
      ...(step.mcp ? { mcp: true } : {}),
    };
  }

  private applyStatus(step: Step, status: string | null): void {
    if (status !== null) step.status = status;
    if (step.done || (status !== 'completed' && status !== 'failed')) return;
    step.done = true;
    const failed = status === 'failed';
    if (step.helper !== null) {
      this.endHelperStep(step, failed);
      return;
    }
    if (step.hidden) return;
    this.send('tool.completed', {
      tool: step.tool,
      step_id: step.id,
      duration: Math.round(((this.now() - step.startedAt) / 1000) * 10) / 10,
      error: failed,
      ...(step.diff !== null ? { diff: step.diff } : {}),
    });
  }

  // ---- helpers (subagents) --------------------------------------------------------------------------------------------------------------

  private helperName(step: Step, view: StepView): string {
    const clean = (s: string): string => clipText(scrubTitle(s, this.o), MAX_TITLE_CHARS, this.o.secrets);
    switch (step.helper) {
      case 'codex-start':
        return clean(view.rawTitle.replace(/^Start subagent /, '').replace(/[\s_-]+/g, ' '));
      case 'codex-complete':
        return clean(view.rawTitle.replace(/^Complete subagent /, '').replace(/[\s_-]+/g, ' '));
      case 'hermes':
        return clean(view.rawTitle.replace(/^delegate_task:?\s*/, '').replace(/^\d+\s+tasks?:\s*/, ''));
      default:
        // Claude titles its `Agent` call "Task" first and the helper's description in a later update.
        return view.title !== null && view.title !== 'Task' ? view.title : '';
    }
  }

  private startHelper(step: Step, view: StepView): void {
    const name = this.helperName(step, view);
    step.helperName = name;
    if (step.helper === 'codex-complete') {
      // The end of a helper whose "Start subagent" step was seen earlier (matched by name).
      const startId = this.codexHelpers.get(name);
      const known = startId === undefined ? undefined : this.helpers.get(startId);
      if (known) this.finishHelper(known, false);
      else {
        const h: Helper = { id: step.id, name: name || 'Helper', status: 'working', steps: 0 };
        this.helpers.set(step.id, h);
        this.finishHelper(h, false);
      }
      return;
    }
    const h: Helper = { id: step.id, name: name || 'Helper', status: 'working', steps: 0 };
    this.helpers.set(step.id, h);
    if (step.helper === 'codex-start') this.codexHelpers.set(name, step.id);
    this.send('agent.update', { agent_id: h.id, name: h.name, status: h.status, steps: 0, ...(step.parentId !== null ? { parent_step_id: step.parentId } : {}) });
  }

  private renameHelper(step: Step, view: StepView): void {
    const h = this.helpers.get(step.id);
    if (!h || h.status !== 'working') return;
    const name = this.helperName(step, view);
    if (name !== '' && name !== h.name) {
      h.name = name;
      this.send('agent.update', { agent_id: h.id, name: h.name, status: h.status, steps: h.steps });
    }
  }

  private endHelperStep(step: Step, failed: boolean): void {
    // Codex: the "Start subagent" step ends at once; the helper itself ends with its "Complete subagent" step.
    if (step.helper === 'codex-start' || step.helper === 'codex-complete') {
      if (failed && step.helper === 'codex-start') {
        const h = this.helpers.get(step.id);
        if (h) this.finishHelper(h, true);
      }
      return;
    }
    const h = this.helpers.get(step.id);
    if (h) this.finishHelper(h, failed);
  }

  private finishHelper(h: Helper, failed: boolean): void {
    if (h.status !== 'working') return;
    h.status = failed ? 'failed' : 'done';
    this.send('agent.update', { agent_id: h.id, name: h.name, status: h.status, steps: h.steps });
  }

  // ---- the end --------------------------------------------------------------------------------------------------------------------------

  /** The turn is over: the answer's last word, a thinking burst, and whatever the adapter left open (Codex leaves a cancelled step `in_progress` for ever; a step still open when the run failed is failed). */
  finish(cancelled: boolean, failed = false): void {
    this.endThinking();
    this.flushText();
    for (const step of this.steps.values()) {
      if (step.done) continue;
      step.done = true;
      if (step.helper !== null) {
        if (step.helper === 'claude' || step.helper === 'hermes') {
          const h = this.helpers.get(step.id);
          if (h) this.finishHelper(h, cancelled || failed);
        }
        continue;
      }
      if (step.hidden) continue;
      this.o.emit('tool.completed', {
        tool: step.tool,
        step_id: step.id,
        duration: Math.round(((this.now() - step.startedAt) / 1000) * 10) / 10,
        error: failed && !cancelled,
        ...(cancelled ? { interrupted: true } : {}),
        ...(step.diff !== null ? { diff: step.diff } : {}),
      });
    }
    for (const h of this.helpers.values()) if (h.status === 'working') this.finishHelper(h, cancelled || failed);
  }
}
