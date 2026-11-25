import type { BotPlanEntry, BotRuntimeEvent, BotStepDiff, BotStepKind } from '@manythreads/sdk';

// The activity of a run as a runtime event (P25-04, docs/plans/acp.md §3.1). A gateway's frame (the agent bridge's, or a Hermes gateway's own) becomes one of the
// event kinds of the SDK: `tool`, `tool_result`, `step`, `agent`, `plan`, `thinking`. The bridge has already cut every frame down to a whitelist and redacted the
// text; this module reads the same fields again defensively (a gateway of the customer's own is not ours): a field of the wrong shape is left out, never passed on,
// and the lengths are bounded.

const STEP_KINDS: readonly BotStepKind[] = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'];
const PLAN_STATUS: readonly BotPlanEntry['status'][] = ['pending', 'in_progress', 'completed'];
const AGENT_STATUS = ['working', 'done', 'failed'] as const;

export const MAX_TITLE = 160;
export const MAX_PATH = 200;
export const MAX_PATHS = 5;
export const MAX_PLAN_ENTRIES = 30;
export const MAX_PLAN_TEXT = 300;
const MAX_ID = 120;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : undefined);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

/**
 * The kind a tool's name suggests, for a gateway that sends only a name (the Hermes gateway's `tool.started {tool, preview}`): `lookingLabel` (live.ts) does the same
 * for its phrase. The order matters: `read_file` is a read, `web_search` a fetch of the web, `search_files` a search.
 */
export function kindOfTool(tool: string): BotStepKind {
  if (/^mcp(__|\.)/i.test(tool)) return 'other';
  // Whole words only: `tools` is not `ls`, `locate` is not `cat`. A name is cut at every mark and at every capital (`readFile`), and a plural counts as its word.
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
  const has = (...list: string[]): boolean => words.some((w) => list.includes(w) || (w.length > 3 && w.endsWith('s') && list.includes(w.slice(0, -1))));
  if (has('terminal', 'shell', 'bash', 'exec', 'execute', 'run', 'command', 'process')) return 'execute';
  if (has('web', 'browse', 'browser', 'fetch', 'http', 'https', 'url', 'download')) return 'fetch';
  if (has('search', 'grep', 'glob', 'find', 'query', 'lookup')) return 'search';
  if (has('delete', 'remove', 'unlink', 'rm')) return 'delete';
  if (has('move', 'rename')) return 'move';
  if (has('write', 'edit', 'patch', 'apply', 'create', 'save', 'replace')) return 'edit';
  if (has('read', 'view', 'open', 'cat', 'list', 'ls', 'file', 'page', 'repo', 'memory', 'knowledge')) return 'read';
  if (has('think', 'thinking', 'reason', 'reasoning')) return 'think';
  return 'other';
}

const kindOf = (v: unknown): BotStepKind | undefined => (typeof v === 'string' ? STEP_KINDS.find((k) => k === v) : undefined);

function pathsOf(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const p of v) {
    const t = text(p, MAX_PATH);
    if (t !== undefined && !out.includes(t) && out.length < MAX_PATHS) out.push(t);
  }
  return out;
}

export function diffOf(v: unknown): BotStepDiff | undefined {
  if (!isRecord(v)) return undefined;
  const added = count(v['added']);
  const removed = count(v['removed']);
  return added === undefined || removed === undefined ? undefined : { added, removed };
}

/** `tool.started`. A frame with no step id (the Hermes gateway's) still gets a kind, from the tool's name. */
export function toolFromFrame(f: Record<string, unknown>): Extract<BotRuntimeEvent, { type: 'tool' }> {
  const name = String(f['tool'] ?? 'tool');
  const stepId = text(f['step_id'], MAX_ID);
  const parentStepId = text(f['parent_step_id'], MAX_ID);
  const title = text(f['title'], MAX_TITLE);
  const paths = pathsOf(f['paths']);
  return {
    type: 'tool',
    name,
    input: f['preview'] ?? null,
    ...(stepId !== undefined ? { stepId } : {}),
    ...(parentStepId !== undefined ? { parentStepId } : {}),
    kind: kindOf(f['kind']) ?? kindOfTool(name),
    ...(title !== undefined ? { title } : {}),
    ...(paths !== undefined ? { paths } : {}),
  };
}

/** `tool.completed`. */
export function toolResultFromFrame(f: Record<string, unknown>): Extract<BotRuntimeEvent, { type: 'tool_result' }> {
  const failed = f['error'] === true;
  const stepId = text(f['step_id'], MAX_ID);
  const diff = diffOf(f['diff']);
  const seconds = typeof f['duration'] === 'number' && Number.isFinite(f['duration']) && f['duration'] >= 0 ? f['duration'] : undefined;
  return {
    type: 'tool_result',
    name: String(f['tool'] ?? 'tool'),
    ok: !failed,
    ...(failed ? { reason: f['reason'] === 'out_of_memory' ? 'out of memory' : 'the tool reported an error' } : {}),
    ...(stepId !== undefined ? { stepId } : {}),
    ...(diff !== undefined ? { diff } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
  };
}

/** `step.update`: the fields that changed. A frame that names no step, or changes nothing, is nothing. */
export function stepFromFrame(f: Record<string, unknown>): Extract<BotRuntimeEvent, { type: 'step' }> | null {
  const stepId = text(f['step_id'], MAX_ID);
  if (stepId === undefined) return null;
  const title = text(f['title'], MAX_TITLE);
  const paths = pathsOf(f['paths']);
  const status = f['status'] === 'in_progress' ? ('in_progress' as const) : undefined;
  if (title === undefined && paths === undefined && status === undefined) return null;
  return { type: 'step', stepId, ...(title !== undefined ? { title } : {}), ...(paths !== undefined ? { paths } : {}), ...(status !== undefined ? { status } : {}) };
}

/** `agent.update`: a helper agent and how far it is. */
export function agentFromFrame(f: Record<string, unknown>): Extract<BotRuntimeEvent, { type: 'agent' }> | null {
  const agentId = text(f['agent_id'], MAX_ID);
  const status = AGENT_STATUS.find((s) => s === f['status']);
  if (agentId === undefined || status === undefined) return null;
  const parentStepId = text(f['parent_step_id'], MAX_ID);
  return { type: 'agent', agentId, name: text(f['name'], MAX_TITLE) ?? 'Helper', status, steps: count(f['steps']) ?? 0, ...(parentStepId !== undefined ? { parentStepId } : {}) };
}

/** `plan.update`: the whole list. An entry with no words is dropped; an unknown status is `pending`. */
export function planFromFrame(f: Record<string, unknown>): Extract<BotRuntimeEvent, { type: 'plan' }> | null {
  if (!Array.isArray(f['entries'])) return null;
  const entries: BotPlanEntry[] = [];
  for (const e of f['entries']) {
    if (!isRecord(e) || entries.length >= MAX_PLAN_ENTRIES) continue;
    const content = text(e['content'], MAX_PLAN_TEXT);
    if (content === undefined) continue;
    entries.push({ content, status: PLAN_STATUS.find((s) => s === e['status']) ?? 'pending' });
  }
  return { type: 'plan', entries };
}

/** `run.notice` (P31-04): only a kind from the fixed list, the step's id and title, and the run's memory limit; any text the gateway sends with it is not read. */
export function noticeFromFrame(f: Record<string, unknown>): Extract<BotRuntimeEvent, { type: 'notice' }> | null {
  if (f['kind'] !== 'out_of_memory') return null;
  const stepId = text(f['step_id'], MAX_ID);
  const title = text(f['title'], MAX_TITLE);
  const limit = count(f['limit_mib']);
  return {
    type: 'notice',
    kind: 'out_of_memory',
    ...(stepId !== undefined ? { stepId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(limit !== undefined && limit > 0 && limit <= 16 * 1024 * 1024 ? { limitMiB: limit } : {}),
  };
}

/** `4096` MiB is "4 GB", `1536` is "1.5 GB", below 1 GB in MB. */
export function memoryWords(mib: number): string {
  if (mib < 1024) return `${mib} MB`;
  const gb = Math.round((mib / 1024) * 10) / 10;
  return `${Number.isInteger(gb) ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

/** The sentence the thread gets when a command ran out of memory: what happened, that the run goes on, and what to run instead. */
export function outOfMemoryNotice(n: Extract<BotRuntimeEvent, { type: 'notice' }>): string {
  const title = (n.title ?? '').replace(/[`\s]+/g, ' ').trim();
  const what = title === '' ? 'A command' : `A command (\`${title}\`)`;
  const limit = n.limitMiB !== undefined ? `it needed more than the ${memoryWords(n.limitMiB)} this run may use` : 'it needed more memory than the machine could spare';
  return (
    `${what} ran out of memory and was stopped: ${limit}. The run goes on. ` +
    'A smaller check fits: the typecheck and tests of the package that changed, one test file at a time, or `vitest --maxWorkers=1`; never a whole-repository run or a bigger `--max-old-space-size`.'
  );
}

/** `thinking`: how long, never what. */
export function thinkingFromFrame(f: Record<string, unknown>): Extract<BotRuntimeEvent, { type: 'thinking' }> {
  const seconds = typeof f['seconds'] === 'number' && Number.isFinite(f['seconds']) && f['seconds'] >= 0 ? Math.round(f['seconds'] * 10) / 10 : 0;
  return { type: 'thinking', seconds };
}

/** What `run.completed` adds to the result: why the turn ended, and what the agent says it cost. */
export function endOfTurn(f: Record<string, unknown>): { stopReason?: string; cost?: { amount: number; currency: string } } {
  const stopReason = text(f['stop_reason'], 40);
  const c = f['cost'];
  const amount = isRecord(c) && typeof c['amount'] === 'number' && Number.isFinite(c['amount']) && c['amount'] >= 0 ? c['amount'] : undefined;
  const currency = isRecord(c) ? text(c['currency'], 8) : undefined;
  return { ...(stopReason !== undefined ? { stopReason } : {}), ...(amount !== undefined && currency !== undefined ? { cost: { amount, currency } } : {}) };
}

/** What an `approval.request` frame adds to the question: what the step is. */
export function approvalExtras(f: Record<string, unknown>): Omit<Extract<BotRuntimeEvent, { type: 'approval' }>, 'type' | 'command' | 'description' | 'choices' | 'answer'> {
  const kind = kindOf(f['kind']);
  const title = text(f['title'], MAX_TITLE);
  const paths = pathsOf(f['paths']);
  const diff = diffOf(f['diff']);
  const stepId = text(f['step_id'], MAX_ID);
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(paths !== undefined ? { paths } : {}),
    ...(diff !== undefined ? { diff } : {}),
    ...(stepId !== undefined ? { stepId } : {}),
    ...(f['note_ok'] === true ? { canNote: true } : {}),
  };
}

/**
 * A run of the agent bridge that failed with one of its own plain sentences (the bridge's words, not a remote program's): the runner will not take this bot
 * (OpenCode, a Hermes that cannot be limited to the bot's tools, an agent with no way to limit its tools, a model the profile pins that the agent did not take),
 * or the run used up its turns. Read off the text; only the category leaves.
 */
export function bridgeFailureOf(error: string | undefined): 'runner_refused' | 'steps' | null {
  if (error === undefined) return null;
  if (/turn limit exceeded/i.test(error)) return 'steps';
  if (
    /OpenCode cannot run yet|cannot be limited to (less|what the bot may do)|tools cannot be limited|does not let its .* be chosen|did not take the .* that the profile pins|cannot take the platform's tools over HTTP/i.test(error)
  )
    return 'runner_refused';
  return null;
}
