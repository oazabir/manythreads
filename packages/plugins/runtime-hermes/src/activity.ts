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
  const name = tool.toLowerCase();
  if (name.startsWith('mcp__') || name.startsWith('mcp.')) return 'other';
  if (/(^|[_.\-\s])(terminal|shell|bash|exec|execute|run|command|process)([_.\-\s]|$)/.test(name)) return 'execute';
  if (/web|browse|fetch|http|url|download/.test(name)) return 'fetch';
  if (/search|grep|glob|find|query|lookup/.test(name)) return 'search';
  if (/delete|remove|unlink|rm$/.test(name)) return 'delete';
  if (/move|rename/.test(name)) return 'move';
  if (/write|edit|patch|apply|create|save|replace/.test(name)) return 'edit';
  if (/read|view|open|cat|list|ls|get_file|file|page|repo|memory|knowledge/.test(name)) return 'read';
  if (/think|reason/.test(name)) return 'think';
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
    ...(failed ? { reason: 'the tool reported an error' } : {}),
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
