import type { CapabilityAuthorizeContext } from '@manythreads/sdk';
import { PAGE_WRITE_MODES } from '@manythreads/shared';

// What the MCP endpoint offers a run and how each tool behaves (PLAN P5-09). The catalog is not a second copy of
// the capability list: `ctx.runs.catalog()` is the truth (every capability with an implementation), and this module
// only says how to *describe* a tool to a model and what a call does beyond asking the broker.
//
// Three shapes:
//   * `read`  — a call runs in the run's reader transaction (the asker's visibility when there is one) and every hit
//               it answers with is written to `run_source_log`, which is what "Sources reached" and the retention
//               rule ("a run retains no wider than the narrowest source it read") stand on.
//   * `write` — a call runs in the run's bot transaction, so the commit carries the bot; the broker's path guard and
//               grant rules decide, never this table.
//   * `stub`  — a capability this plugin declares itself because the plugin that will own it does not exist yet
//               (knowledge bases arrive with connections; the board arrives with tasks). A stub answers what it
//               knows and nothing else: it never invents content. When the owning plugin lands it declares the
//               capability and this declaration goes — see docs/plugins/gateway-mcp.md.

export type ToolKind = 'read' | 'write' | 'stub';

export interface ToolSource {
  sourceType: string;
  sourceRef: string;
  scope: 'team' | 'channel' | 'person';
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema, sent to the model as `inputSchema`. */
  inputSchema: Record<string, unknown>;
  kind: ToolKind;
  /** The stub's answer; only for `kind: 'stub'`. */
  answer?: Record<string, unknown>;
  /** What the call's answer proves the run read; only for `kind: 'read'`. */
  sourcesFrom?: (result: unknown) => ToolSource[];
}

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 2, maxLength: 200, description: 'Words to look for.' },
    teamId: { type: 'string', description: 'Only this team. Defaults to the team the run belongs to.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Most hits to answer with (default 10).' },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

const MESSAGES_POST_SCHEMA = {
  type: 'object',
  properties: {
    channelId: { type: 'string', description: 'The channel to post in — the one the run was asked in, or one you read about.' },
    body: { type: 'string', maxLength: 40_000, description: 'The message, in the same markup a person writes.' },
    threadRootId: { type: 'string', description: 'The thread to reply in; leave it out to post a new top-level message.' },
  },
  required: ['body'],
  additionalProperties: false,
} as const;

const PAGES_WRITE_SCHEMA = {
  type: 'object',
  properties: {
    team: { type: 'string', description: 'The team slug or id. Defaults to the team the run belongs to.' },
    mode: { type: 'string', enum: PAGE_WRITE_MODES, description: 'create, replace or append.' },
    path: { type: 'string', description: 'A path under pages/, e.g. pages/reports/week-37.md' },
    content: { type: 'string', maxLength: 2_000_000 },
    baseBlobSha: { type: 'string', description: 'The blob sha the edit was based on; a mismatch is refused.' },
    message: { type: 'string', maxLength: 4000, description: 'The commit message.' },
  },
  required: ['mode', 'path', 'content'],
  additionalProperties: false,
} as const;

// The memory tools take no bank, team or workspace argument, on purpose: the platform derives the bank from the run (memory-hindsight, SPEC 12.1).
const MEMORY_RECALL_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 2, maxLength: 500, description: 'What to remember: a question or a few words.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Most facts to answer with (default 10).' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Only facts that carry all of these tags.' },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

const MEMORY_RETAIN_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string', minLength: 1, maxLength: 20_000, description: 'What the team should remember, written so it makes sense on its own.' },
    context: { type: 'string', maxLength: 200, description: 'A short label, such as “decision” or “customer call”.' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Lowercase tags to find it by later.' },
  },
  required: ['content'],
  additionalProperties: false,
} as const;

/** Reads `{ hits: [{ id, channel? }] }` (the search plugin's answer) into source lines. */
const hitsFrom = (sourceType: 'message' | 'file') => (result: unknown): ToolSource[] => {
  const hits = (result as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits)) return [];
  const out: ToolSource[] = [];
  for (const hit of hits) {
    const row = hit as { id?: unknown; channel?: { id?: unknown } | null };
    if (typeof row?.id !== 'string') continue;
    const channelId = row.channel !== null && typeof row.channel === 'object' ? row.channel.id : undefined;
    out.push({ sourceType, sourceRef: row.id, scope: typeof channelId === 'string' ? 'channel' : 'team' });
  }
  return out;
};

/** One entry per tool this gateway can describe. A capability without an entry is still offered, with a plain description. */
export const TOOLS: Readonly<Record<string, ToolDefinition>> = {
  'messages.search': {
    name: 'messages.search',
    description: 'Search the team’s messages and threads. Answers the hits it found, each with its channel.',
    inputSchema: SEARCH_SCHEMA,
    kind: 'read',
    sourcesFrom: hitsFrom('message'),
  },
  'files.search': {
    name: 'files.search',
    description: 'Search the team’s file names. Answers the files it found, each with its channel when it has one.',
    inputSchema: SEARCH_SCHEMA,
    kind: 'read',
    sourcesFrom: hitsFrom('file'),
  },
  'memory.recall': {
    name: 'memory.recall',
    description:
      'Recall what the team’s memory knows about a question. Answers the facts it found. The memory is your team’s alone; you do not choose it.',
    inputSchema: MEMORY_RECALL_SCHEMA,
    kind: 'read',
    // The bank is the source: its scope is the team, which the retention rule (a run keeps no wider than the narrowest source it read) reads.
    sourcesFrom: (result) => {
      const answer = result as { ok?: unknown; bank?: unknown } | null;
      return answer?.ok === true && typeof answer.bank === 'string' ? [{ sourceType: 'memory', sourceRef: `bank:${answer.bank}`, scope: 'team' }] : [];
    },
  },
  'memory.retain': {
    name: 'memory.retain',
    description:
      'Add something to the team’s memory so every bot on the team can recall it later. Only things the whole team may know; the tool refuses when this run read something private to one person.',
    inputSchema: MEMORY_RETAIN_SCHEMA,
    kind: 'write',
  },
  'messages.post': {
    name: 'messages.post',
    description:
      'Post a message into a channel of the team, as yourself. Use this to answer in the thread you were asked in; the platform posts your final reply for you.',
    inputSchema: MESSAGES_POST_SCHEMA,
    kind: 'write',
  },
  'pages.write': {
    name: 'pages.write',
    description: 'Create, replace or append a page under pages/ of the team’s repo; the commit is yours.',
    inputSchema: PAGES_WRITE_SCHEMA,
    kind: 'write',
  },
  'knowledge.search': {
    name: 'knowledge.search',
    description:
      'Search the team’s knowledge bases. No knowledge base is configured in this deployment, so the answer is always empty and says why.',
    inputSchema: SEARCH_SCHEMA,
    kind: 'stub',
    answer: { hits: [], reason: 'no bases configured' },
  },
  'tasks.read': {
    name: 'tasks.read',
    description: 'Read the team’s board. The board is not part of this deployment yet; the tool says so and nothing else.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    kind: 'stub',
    answer: { ok: false, code: 'not_available', message: 'The task board is not available in this deployment yet.' },
  },
  'tasks.claim': {
    name: 'tasks.claim',
    description: 'Claim a task. The board is not part of this deployment yet; the tool says so and nothing else.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
    kind: 'stub',
    answer: { ok: false, code: 'not_available', message: 'The task board is not available in this deployment yet.' },
  },
  'tasks.complete': {
    name: 'tasks.complete',
    description: 'Complete a task. The board is not part of this deployment yet; the tool says so and nothing else.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' }, summary: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    kind: 'stub',
    answer: { ok: false, code: 'not_available', message: 'The task board is not available in this deployment yet.' },
  },
  'tasks.handoff': {
    name: 'tasks.handoff',
    description: 'Hand a task to another bot or person. The board is not part of this deployment yet; the tool says so and nothing else.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, to: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
    kind: 'stub',
    answer: { ok: false, code: 'not_available', message: 'The task board is not available in this deployment yet.' },
  },
};

/** Capabilities this plugin declares itself (the stubs above); the manifest lists exactly these names. */
export const STUB_CAPABILITIES: readonly string[] = ['knowledge.search', 'tasks.read', 'tasks.claim', 'tasks.complete', 'tasks.handoff'];

/** The entry for a capability, with a plain fallback so an unlisted tool is still offered honestly. */
export function definitionOf(name: string): ToolDefinition {
  return (
    TOOLS[name] ?? {
      name,
      description: `${name}: what the capability of that name does in this deployment.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      kind: 'write',
    }
  );
}

/**
 * What the broker must know beyond the tool name: the repo path(s) the call names. A mutation (`files.*`,
 * `pages.write`) is authorized against the path it will touch, and only the arguments know it — the same path the
 * handler would write. Without this, the broker refuses every mutation with "needs a path to be authorized".
 */
export function authorizeContext(input: Record<string, unknown>): CapabilityAuthorizeContext {
  const path = input['path'];
  const paths = input['paths'];
  return {
    ...(typeof path === 'string' ? { path } : {}),
    ...(Array.isArray(paths) && paths.every((p): p is string => typeof p === 'string') ? { paths } : {}),
  };
}

/**
 * The team a tool call is confined to, filled in when the caller did not name one: a run belongs to exactly one
 * team, so a tool never reaches across teams even when the model asks for it by omission.
 */
export function withRunTeam(name: string, input: Record<string, unknown>, teamId: string): Record<string, unknown> {
  if (name === 'pages.write' && typeof input['team'] !== 'string') return { ...input, team: teamId };
  if ((name === 'messages.search' || name === 'files.search' || name === 'knowledge.search') && typeof input['teamId'] !== 'string') {
    return { ...input, teamId };
  }
  return input;
}
