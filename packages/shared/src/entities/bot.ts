import { z } from 'zod';
import { BotKind, BotPlacement, BotRuntime, BotVisibility } from '../bot-md/frontmatter.ts';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotId, RunId, TeamId, ThreadId, WorkspaceId } from '../ids.ts';

// Bots (PLAN.md A.5, P5-03). Every type here matches a column or a CHECK of the bots plugin's migration
// 0001_bots.sql; `BotKind`, `BotRuntime` and `BotVisibility` are the BOT.md frontmatter's own enums (SPEC §7.1),
// re-exported through this module so web, server and the runtimes read one vocabulary.

/** Lifecycle of a loaded bot: `invalid` keeps the last good definition and alerts the team (PLAN P5-04). */
export const BotStatus = z.enum(['active', 'disabled', 'invalid']);
export type BotStatus = z.infer<typeof BotStatus>;

/**
 * Which BOT.md trigger fired a run — the `type` values of `BotTrigger` (SPEC §7.2), recorded so the run history can
 * say why a run happened without re-parsing the definition it ran from.
 */
export const BotRunTrigger = z.enum([
  'conversation',
  'mention',
  'routine',
  'task_assigned',
  'inbox',
  'channel_message',
  'webhook',
]);
export type BotRunTrigger = z.infer<typeof BotRunTrigger>;

/** One run: `running` until the runtime ends it, then `done`, `failed` or `stopped` (handover or approval timeout). */
export const BotRunStatus = z.enum(['running', 'done', 'failed', 'stopped']);
export type BotRunStatus = z.infer<typeof BotRunStatus>;

/** What a logged source was read under: the whole team, one channel, or one person (their DMs and memory). */
export const RunSourceScope = z.enum(['team', 'channel', 'person']);
export type RunSourceScope = z.infer<typeof RunSourceScope>;

/** A slug as BOT.md writes one (SPEC §7.1): lowercase letters, digits, `.`, `_` or `-`. */
const Slug = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, ".", "_" or "-"');
/** sha256 of a definition, lowercase hex (the loader's `definition_sha`). */
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'lowercase sha256 hex');

/**
 * A bot as the loader leaves it (PLAN P5-04): one row per `bots/<slug>/BOT.md` of a team's repo. The definition
 * itself lives in the repo, not here — this row is its identity, its compiled placement and its status.
 */
export const Bot = z.object({
  id: BotId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  /** The slug of `bots/<slug>/BOT.md`, unique in the team. */
  slug: Slug,
  kind: BotKind,
  runtime: BotRuntime,
  visibility: BotVisibility,
  definitionSha: Sha256,
  status: BotStatus,
  /** The `placement & limits` block, stored as open data (PLAN D3) and validated by `BotPlacement` on the way out. */
  placement: BotPlacement.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Bot = z.infer<typeof Bot>;

/** One run of one bot (PLAN P5-07, P5-10): who triggered it, where it answers, and how it ended. */
export const BotRun = z.object({
  id: RunId,
  botId: BotId,
  teamId: TeamId,
  trigger: BotRunTrigger,
  /** The person (or bot) that asked; null for a scheduled or inbound-trigger run. */
  askerId: ActorId.nullable(),
  /** The thread the run answers in; null when it has not found one yet. */
  threadId: ThreadId.nullable(),
  status: BotRunStatus,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
});
export type BotRun = z.infer<typeof BotRun>;

/**
 * One line of `run_source_log`: something a run read (PLAN P5-07), for the run's "Sources reached" and the audit
 * trail. `sourceType` is an open set (`message`, `page`, `file`, `memory`, ...) — plugins add their own.
 */
export const RunSourceLogEntry = z.object({
  runId: RunId,
  /** Position in the run, so the log keeps read order. */
  seq: z.number().int().nonnegative(),
  sourceType: z.string().min(1),
  /** Where it was read from: a message id, a repo path, a bank name — the ref of `sourceType`. */
  sourceRef: z.string().min(1),
  scope: RunSourceScope,
  createdAt: IsoDateTime,
});
export type RunSourceLogEntry = z.infer<typeof RunSourceLogEntry>;
