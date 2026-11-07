import { Bot, BotRun, BotSummary, RunSourceLogEntry } from '@manythreads/shared';

// The plugin's mapper for `bots`, `bot_runs` and `run_source_log`: the only place a row of one of those tables
// becomes a shared entity (the kernel's mappers are not importable from a plugin). Dates are converted here, once;
// `placement` is open jsonb and is validated by the schema on the way out.

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export type BotRow = {
  id: string;
  workspace_id: string;
  /** NULL for the workspace bot (`scope = 'workspace'`); the roster fills in the context team before mapping. */
  team_id: string | null;
  scope?: string;
  slug: string;
  name: string;
  role: string;
  avatar?: string | null;
  may_tag: string[];
  kind: string;
  runtime: string;
  visibility: string;
  definition_sha: string;
  status: string;
  placement: unknown;
  invalid_reason: unknown;
  /** The BOT.md triggers as written (`bots.triggers`, jsonb); only `toBotSummary` reads it, for `conversational`. */
  triggers?: unknown;
  created_at: Date;
  updated_at: Date;
};
export const BOT_COLUMNS =
  'id, workspace_id, team_id, scope, slug, name, role, avatar, may_tag, kind, runtime, visibility, definition_sha, status, placement, invalid_reason, triggers, created_at, updated_at';
export const toBot = (r: BotRow): Bot =>
  Bot.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    ...(r.scope === 'workspace' || r.scope === 'team' ? { scope: r.scope } : {}),
    slug: r.slug,
    name: r.name,
    role: r.role,
    avatar: r.avatar ?? null,
    kind: r.kind,
    runtime: r.runtime,
    visibility: r.visibility,
    definitionSha: r.definition_sha,
    status: r.status,
    placement: r.placement ?? null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  });

/** Whether the definition lists a `conversation` trigger: the only trigger a message in a conversation channel fires (runtime-hermes' router). */
export const hasConversationTrigger = (triggers: unknown): boolean =>
  Array.isArray(triggers) && triggers.some((t) => typeof t === 'object' && t !== null && (t as { type?: unknown }).type === 'conversation');

/** Whether a person can address the bot: a `mention` or a `conversation` trigger. A bot with only `drop`, `schedule` or event triggers is never asked anything. */
export const hasAddressableTrigger = (triggers: unknown): boolean =>
  Array.isArray(triggers) &&
  triggers.some((t) => {
    const type = typeof t === 'object' && t !== null ? (t as { type?: unknown }).type : undefined;
    return type === 'conversation' || type === 'mention';
  });

/** The roster's row: the bot plus the display fields the loader copied onto it and the reason its last load failed (`invalid_reason`, null once repaired). */
export const toBotSummary = (r: BotRow, actorId: string | null = null): BotSummary =>
  BotSummary.parse({
    ...toBot(r),
    actorId,
    name: r.name,
    role: r.role,
    mayTag: r.may_tag,
    invalid: r.invalid_reason ?? null,
    conversational: hasConversationTrigger(r.triggers),
    mentionable: hasAddressableTrigger(r.triggers),
  });

export type BotRunRow = {
  id: string;
  workspace_id: string;
  bot_id: string;
  team_id: string;
  trigger_type: string;
  asker_id: string | null;
  thread_id: string | null;
  status: string;
  started_at: Date;
  ended_at: Date | null;
};
export const BOT_RUN_COLUMNS = 'id, workspace_id, bot_id, team_id, trigger_type, asker_id, thread_id, status, started_at, ended_at';
export const toBotRun = (r: BotRunRow, markdownRepairs: { paths: number; fences: number } = { paths: 0, fences: 0 }): BotRun =>
  BotRun.parse({
    markdownRepairs,
    id: r.id,
    botId: r.bot_id,
    teamId: r.team_id,
    trigger: r.trigger_type,
    askerId: r.asker_id,
    threadId: r.thread_id,
    status: r.status,
    startedAt: r.started_at.toISOString(),
    endedAt: iso(r.ended_at),
  });

export type RunSourceLogRow = {
  run_id: string;
  seq: number;
  source_type: string;
  source_ref: string;
  scope: string;
  created_at: Date;
};
export const RUN_SOURCE_LOG_COLUMNS = 'run_id, seq, source_type, source_ref, scope, created_at';
export const toRunSourceLogEntry = (r: RunSourceLogRow): RunSourceLogEntry =>
  RunSourceLogEntry.parse({
    runId: r.run_id,
    seq: r.seq,
    sourceType: r.source_type,
    sourceRef: r.source_ref,
    scope: r.scope,
    createdAt: r.created_at.toISOString(),
  });
