import type { RunCounts, RunHead, RunNow, RunProgress, RunViewState } from '@manythreads/shared';

/*
 * The words of the run card (PLAN P25-11, docs/plans/acp.md section 5). Pure functions, so the plain-language rules are tested: "helper", not "subagent"; "step", not
 * "tool call"; "plan", not "todos"; never a raw tool name, a path from the root of a disk or JSON.
 */

const ENDED: readonly RunViewState[] = ['done', 'failed', 'stopped'];
export const runEnded = (state: RunViewState): boolean => ENDED.includes(state);

/** The last part of a path ("clients/web/src/ThreadPanel.tsx" gives "ThreadPanel.tsx"). */
export function baseName(path: string): string {
  const clean = path.replace(/[\\/]+$/, '');
  const at = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return at === -1 ? clean : clean.slice(at + 1);
}

/** One line, clipped with an ellipsis. */
export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

const lower = (text: string): string => (text === '' ? text : `${text[0]!.toLowerCase()}${text.slice(1)}`);

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "45 s", "4 min", "1 h 5 min": how long a run took or has taken. */
export function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** How long the run has gone (live) or went (ended). `now` is the clock, a parameter so a test can hold it. */
export function runElapsedMs(head: Pick<RunHead, 'startedAt' | 'endedAt'>, now: number): number {
  const start = Date.parse(head.startedAt);
  if (!Number.isFinite(start)) return 0;
  const end = head.endedAt !== null ? Date.parse(head.endedAt) : now;
  return Math.max(0, (Number.isFinite(end) ? end : now) - start);
}

// ---- the header ---------------------------------------------------------------------------------------------------------------------

export interface WaitingContext {
  /** Some question of this run is waiting for the viewer to answer. */
  viewerCanAnswer: boolean;
  /** Who else is expected to answer (the asker's name), when the viewer cannot. */
  waitingFor: string | null;
}

/** The state word of a live run, as the header says it. */
export function stateWord(state: RunViewState, waiting: WaitingContext = { viewerCanAnswer: false, waitingFor: null }): string {
  switch (state) {
    case 'starting':
      return 'Starting…';
    case 'working':
      return 'Working';
    case 'waiting':
      if (waiting.viewerCanAnswer) return 'Waiting for you';
      return waiting.waitingFor !== null ? `Waiting for ${waiting.waitingFor}` : 'Waiting for an answer';
    case 'stopping':
      return 'Stopping…';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
  }
}

// ---- the now line ---------------------------------------------------------------------------------------------------------------------

export interface NowLine {
  /** The plain sentence ("Reading ThreadPanel.tsx"). */
  text: string;
  /** A command or title in mono after the sentence, when short. */
  code: string | null;
  /** A helper's step: "Helper: ..." and the helper's name, for the tooltip. */
  helper: string | null;
}

const firstFile = (now: Pick<RunNow, 'paths'>): string | null => (now.paths[0] !== undefined ? baseName(now.paths[0]) : null);

/**
 * The program a command step names, for a short mono chip: the bridge titles a command "Running pnpm" (the program only, never the line, which may hold a secret) or
 * "Running a command" when it cannot tell. Another title (an agent that names the command itself) is kept, clipped. Null when there is nothing worth showing.
 */
export function commandOf(title: string | null | undefined): string | null {
  const t = (title ?? '').replace(/\s+/g, ' ').trim();
  if (t === '' || /^(running a command|ran a command|terminal|bash|shell|command|execute|run command)$/i.test(t)) return null;
  const named = /^(?:running|ran|run)\s+(.+)$/i.exec(t);
  return clip(named ? named[1]! : t, 40);
}

/**
 * manythreads' own tools, as an agent's program titles a call to them ("mcp__manythreads__tasks_claim", "mcp__manythreads__memory.recall"): what the step does, in plain
 * words, while it runs and once it is done. Seen on the live site (P25-16): Claude Code and Codex title an MCP call with the tool's raw name.
 */
const OWN_TOOLS: Record<string, readonly [now: string, past: string]> = {
  'tasks.claim': ['Taking the card', 'Took the card'],
  'tasks.read': ['Reading a card', 'Read a card'],
  'tasks.describe': ['Writing on the card', 'Wrote on the card'],
  'tasks.update': ['Updating the card', 'Updated the card'],
  'tasks.create': ['Making a card', 'Made a card'],
  'tasks.handoff': ['Handing the card on', 'Handed the card on'],
  'tasks.complete': ['Marking the card done', 'Marked the card done'],
  'tasks.todo': ['Updating the to-do list', 'Updated the to-do list'],
  'tasks.private_note': ["Reading the card's private note", "Read the card's private note"],
  'tasks.commit_identity': ['Looking up who signs the commit', 'Looked up who signs the commit'],
  'memory.recall': ['Recalling from memory', 'Recalled from memory'],
  'memory.retain': ['Saving to memory', 'Saved to memory'],
  'messages.post': ['Posting a message', 'Posted a message'],
  'messages.search': ['Searching the messages', 'Searched the messages'],
  'files.search': ['Searching the files', 'Searched the files'],
  'approvals.ask': ['Asking a person', 'Asked a person'],
};

/**
 * A step title that is a tool's raw name (`mcp__<server>__<tool>`), in plain words: one of manythreads' own tools by what it does, any other "Using <server>: <tool>". Null
 * when the title is not a raw name (it is kept as it is). `tense` is "now" for the live line, "past" for the step list.
 */
export function toolPhrase(title: string | null | undefined, tense: 'now' | 'past'): string | null {
  const m = /^mcp__([A-Za-z0-9-]+?)__([A-Za-z0-9_.-]+)$/.exec((title ?? '').trim());
  if (m === null) return null;
  const server = m[1]!.toLowerCase();
  const tool = m[2]!;
  if (server === 'manythreads') {
    // the tool reaches the agent as `tasks_claim` (Claude Code) or `tasks.claim` (Codex): the area is the first word
    const dot = tool.includes('.') ? tool : tool.replace('_', '.');
    const own = OWN_TOOLS[dot.toLowerCase()];
    if (own !== undefined) return tense === 'now' ? own[0] : own[1];
    return `${tense === 'now' ? 'Using' : 'Used'} the workspace's ${dot.split('.')[0]!.replace(/_/g, ' ')} tool`;
  }
  return `${tense === 'now' ? 'Using' : 'Used'} ${server.replace(/[-_]/g, ' ')}: ${tool.replace(/[._]/g, ' ')}`;
}

/** A title an agent's program gives every step of a kind, which says less than the kind and its file ("Read File", "Edit", "Preparing file…"). */
export const BARE_TITLE = /^(read|read file|edit|edit file|write|write file|preparing file…?|preparing file\.\.\.)$/i;

/** What the run is doing, in one plain line. Never a raw tool name, never JSON, never a long path. */
export function nowLine(now: RunNow | null, state: RunViewState): NowLine {
  if (now === null) {
    // the header already says the state: the line says what that means now, not the same word again
    return { text: state === 'starting' ? 'Getting ready' : state === 'waiting' ? 'Waiting for an answer' : state === 'stopping' ? 'Finishing the step it is on' : 'Thinking', code: null, helper: null };
  }
  const file = firstFile(now);
  const many = now.count > 1;
  let text: string;
  let code: string | null = null;
  // a call to a tool by its raw name (Codex marks an MCP call a command): what it does, never the name
  const tool = toolPhrase(now.title, 'now');
  if (tool !== null && !many) {
    if (now.helper !== null) return { text: `Helper: ${lower(tool)}`, code: null, helper: now.helper };
    return { text: tool, code: null, helper: null };
  }
  switch (now.kind) {
    case 'thinking':
      text = 'Thinking';
      break;
    case 'answering':
      text = 'Writing the answer';
      break;
    case 'read':
      text = many ? `Reading ${now.count} files` : file !== null ? `Reading ${file}` : 'Reading a file';
      break;
    case 'edit':
      text = many ? `Editing ${now.count} files` : file !== null ? `Editing ${file}` : 'Editing a file';
      break;
    case 'delete':
      text = many ? `Removing ${now.count} files` : file !== null ? `Removing ${file}` : 'Removing a file';
      break;
    case 'move':
      text = many ? `Moving ${now.count} files` : file !== null ? `Moving ${file}` : 'Moving a file';
      break;
    case 'search':
      text = 'Searching the code';
      break;
    case 'execute':
      // said once: "Running" and the program in mono ("Running pnpm"), or "Running a command" when the program is not known
      code = many ? null : commandOf(now.title);
      text = many ? `Running ${now.count} commands` : code !== null ? 'Running' : 'Running a command';
      break;
    case 'fetch':
      text = 'Reading the web';
      break;
    case 'think':
      text = 'Thinking';
      break;
    case 'switch_mode':
      text = 'Planning';
      break;
    case 'other':
      // the server titles a call to one of manythreads' own tools in plain words ("Handed the card to Code reviewer"); any other step keeps its title, clipped
      text = now.title !== null && now.title.trim() !== '' ? clip(now.title, 60) : 'Working';
      break;
  }
  if (now.helper !== null) return { text: `Helper: ${lower(text)}`, code, helper: now.helper };
  return { text, code, helper: null };
}

// ---- the plan line and the work log ---------------------------------------------------------------------------------------------

/** "Plan 2 of 5 · Write the e2e test": steps done of all, and the current one. Null when the agent has no plan. */
export function planLine(plan: RunProgress['plan']): { done: number; total: number; current: string | null } | null {
  return plan.total > 0 ? { done: Math.min(plan.done, plan.total), total: plan.total, current: plan.current } : null;
}

/**
 * "14 steps · 2 files changed (+48 −6) · 3 commands · 2 helpers · 1 step failed": counts a person who does not read code can read. `compact` (the folded line under a finished
 * run) keeps what matters after the fact: steps, files changed, helpers and failures; the commands are among the steps and the lines changed are in the step list.
 * `failed: false` leaves the failures out (a stopped run's last step fails because it was stopped, which is not a failure to report).
 */
export function workParts(counts: RunCounts, opts: { compact?: boolean; failed?: boolean } = {}): string[] {
  const parts: string[] = [];
  if (counts.steps > 0) parts.push(plural(counts.steps, 'step', 'steps'));
  if (counts.filesChanged > 0) {
    const delta = !opts.compact && (counts.added > 0 || counts.removed > 0) ? ` (+${counts.added} −${counts.removed})` : '';
    parts.push(`${plural(counts.filesChanged, 'file', 'files')} changed${delta}`);
  }
  // commands are steps too: they are counted on their own only when they are all the run did besides reading (a run of commands reads "3 steps · 3 commands")
  if (!opts.compact && counts.commands > 0 && counts.filesChanged === 0 && counts.helpers === 0) parts.push(plural(counts.commands, 'command', 'commands'));
  if (counts.helpers > 0) parts.push(plural(counts.helpers, 'helper', 'helpers'));
  // "2 steps failed", not "2 failed": after "5 files changed" a bare number reads as five files of which two failed
  if (opts.failed !== false && counts.failed > 0) parts.push(`${plural(counts.failed, 'step', 'steps')} failed`);
  return parts;
}

/** Does the run have anything to open (steps, helpers or a record)? */
export const hasWork = (counts: RunCounts): boolean => counts.steps > 0 || counts.helpers > 0 || counts.filesChanged > 0;

// ---- after the run ----------------------------------------------------------------------------------------------------------------

/**
 * Who can fix a failed run, when the thread holds no notice about it. A run that a person was waiting on leaves a notice in the thread ("I couldn't answer: this team's runner is
 * offline...", `meta.runFailure`) which names the cause and who can fix it in the bot's own words; the card does not say it twice. Any other failed run says this.
 */
export const FAILURE_FALLBACK = 'It stopped on a problem. Try again; if it keeps happening, tell a workspace admin.';

export interface EndLine {
  /** "Worked 4 min", "Stopped by Omar after 2 min", "Failed after 40 s". */
  lead: string;
  /** The counts after it. */
  parts: string[];
  tone: 'done' | 'stopped' | 'failed';
}

/**
 * The one quiet line under the bot's last message once a run has ended. `now` stands in for the end while the server has not said when it ended yet (the push that ends a
 * run can come before its record), so the line never says "Worked 0 s".
 */
export function endLine(head: RunHead, now: number): EndLine {
  const ms = runElapsedMs(head, now);
  // under a second says no time at all ("Failed after 0 s" reads as a fault of its own)
  const after = ms < 1000 ? '' : ` after ${elapsedText(ms)}`;
  const parts = workParts(head.counts, { compact: true, failed: head.state !== 'stopped' });
  if (head.state === 'stopped') return { lead: head.stoppedBy !== null ? `Stopped by ${head.stoppedBy}${after}` : `Stopped${after}`, parts, tone: 'stopped' };
  if (head.state === 'failed') return { lead: `Failed${after}`, parts, tone: 'failed' };
  return { lead: ms < 1000 ? 'Done' : `Worked ${elapsedText(ms)}`, parts, tone: 'done' };
}

/** Is there a reason to draw the folded line at all? A finished run with no steps shows none; a stopped or failed one always does. */
export function showsEndLine(head: RunHead): boolean {
  return head.state !== 'done' || hasWork(head.counts);
}

/** The last two lines of the answer so far, one line each, for the faded preview. Never markdown: a bullet, a heading mark or a code fence is dropped. */
export function previewLines(text: string, max = 2, width = 160): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+[.)]\s+)/, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '' && !/^[-=~]{3,}$/.test(l));
  return lines.slice(-max).map((l) => (l.length > width ? `…${l.slice(l.length - width + 1).trimStart()}` : l));
}

/** The kind of a step as a sentence start, for a step that has no title ("Read" + a file). */
export const STEP_VERB: Record<string, string> = {
  read: 'Read',
  edit: 'Edited',
  delete: 'Removed',
  move: 'Moved',
  search: 'Searched',
  execute: 'Ran a command',
  think: 'Thought',
  fetch: 'Read a web page',
  switch_mode: 'Made a plan',
  other: 'Did a step',
};
