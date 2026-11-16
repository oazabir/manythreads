import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, BotId, ChannelId, MessageId, RunId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// What a run did, kept and shown (PLAN Phase 25, docs/plans/acp.md §3, tasks P25-06 to P25-08). A run of a bot in a thread leaves a short record of its steps
// (`run_activity`, one line per step, helper, plan change and question) and one folded state (`run_view`: what it is doing now, how many steps, the plan, the helpers,
// who stopped it). The record holds no tool input or output, no file content and no reasoning: a step is its kind, one line of title and at most five paths, all of
// them redacted again by the server before they are kept. The live pushes carry the folded state only (well under the 7 KB cap of a push); the step list is read with
// `GET /api/runs/:runId/activity`.

// ---- the words --------------------------------------------------------------------------------------------------------------------

/** What a step does, from the agent's own kinds. */
export const RunStepKind = z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
export type RunStepKind = z.infer<typeof RunStepKind>;

/** Where a run is. `stopping` is a Stop that was asked for and has not taken effect yet; the three last words end the run. */
export const RunViewState = z.enum(['starting', 'working', 'waiting', 'stopping', 'done', 'failed', 'stopped']);
export type RunViewState = z.infer<typeof RunViewState>;
export const RUN_VIEW_ENDED: readonly RunViewState[] = ['done', 'failed', 'stopped'];

/** The kinds of line a run keeps. */
export const RunActivityKind = z.enum(['tool', 'tool_result', 'agent', 'plan', 'thinking', 'approval']);
export type RunActivityKind = z.infer<typeof RunActivityKind>;

export const RunPlanStatus = z.enum(['pending', 'in_progress', 'completed']);
export type RunPlanStatus = z.infer<typeof RunPlanStatus>;
export const RunPlanEntry = z.object({ content: z.string().max(400), status: RunPlanStatus });
export type RunPlanEntry = z.infer<typeof RunPlanEntry>;

export const RunDiff = z.object({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() });
export type RunDiff = z.infer<typeof RunDiff>;

// ---- the folded state -------------------------------------------------------------------------------------------------------------

/** What the run is doing right now, in one line: a step, a stretch of thinking, or writing the answer. `count` is how many open steps are of the same kind ("Reading 6 files"). */
export const RunNow = z.object({
  kind: z.union([RunStepKind, z.enum(['thinking', 'answering'])]),
  title: z.string().max(400).nullable(),
  paths: z.array(z.string().max(300)).max(5),
  /** The name of the helper this step belongs to, when it is a helper's. */
  helper: z.string().max(200).nullable(),
  count: z.number().int().min(1).max(999),
});
export type RunNow = z.infer<typeof RunNow>;

/** Counts a person can read: files read and searches are in `steps`, they have no number of their own. */
export const RunCounts = z.object({
  steps: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  commands: z.number().int().nonnegative(),
  filesChanged: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  helpers: z.number().int().nonnegative(),
  thinkingSeconds: z.number().nonnegative(),
  /** Lines the record did not keep because it was full (the run still counts them above). */
  omitted: z.number().int().nonnegative(),
});
export type RunCounts = z.infer<typeof RunCounts>;

export const RunHelper = z.object({
  id: z.string().max(200),
  name: z.string().max(200),
  status: z.enum(['working', 'done', 'failed']),
  steps: z.number().int().nonnegative(),
});
export type RunHelper = z.infer<typeof RunHelper>;

/** The plan folded to what a card says: "Plan 3 of 5 · Write the e2e test". */
export const RunPlanSummary = z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative(), current: z.string().max(400).nullable() });
export type RunPlanSummary = z.infer<typeof RunPlanSummary>;

export const RunCost = z.object({ amount: z.number().nonnegative(), currency: z.string().max(8) });
export type RunCost = z.infer<typeof RunCost>;

/** What changes while a run works. This is what a `run.activity` push carries (with the ids) and what a head holds. */
export const RunProgress = z.object({
  state: RunViewState,
  now: RunNow.nullable(),
  counts: RunCounts,
  plan: RunPlanSummary,
  /** Goes up by one each time the plan changes: a card reads the whole plan again only when it moves. */
  planVersion: z.number().int().nonnegative(),
  /** At most five helpers, the newest last. */
  helpers: z.array(RunHelper).max(5),
  /** The position of the newest line kept (-1 when none): read `?after=` this far. */
  seq: z.number().int().min(-1),
  /** Who stopped the run, once somebody has asked. */
  stoppedBy: z.string().max(200).nullable(),
});
export type RunProgress = z.infer<typeof RunProgress>;

/** One run of a bot as the thread shows it. */
export const RunHead = RunProgress.extend({
  runId: RunId,
  botId: BotId,
  /** The bot's actor, so a screen finds its avatar and name with the people it already knows. */
  botActorId: ActorId.nullable(),
  botName: z.string().max(200),
  channelId: ChannelId,
  threadRootId: MessageId.nullable(),
  askerActorId: ActorId.nullable(),
  /** A run in a person's private conversation with a bot. */
  conversation: z.boolean(),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
  /** Why the agent's turn ended (`end_turn`, `cancelled`, ...), when it says. */
  stopReason: z.string().max(60).nullable(),
  cost: RunCost.nullable(),
  /** May the person who asks press Stop: the asker, the person who started the thread, a lead of the team, a workspace admin. */
  canStop: z.boolean(),
});
export type RunHead = z.infer<typeof RunHead>;

// ---- the kept lines ---------------------------------------------------------------------------------------------------------------

export const RunToolLine = z.object({
  kind: z.literal('tool'),
  stepId: z.string().max(200),
  parentStepId: z.string().max(200).optional(),
  stepKind: RunStepKind,
  title: z.string().max(400).optional(),
  paths: z.array(z.string().max(300)).max(5).optional(),
});
export const RunToolResultLine = z.object({
  kind: z.literal('tool_result'),
  stepId: z.string().max(200),
  ok: z.boolean(),
  /** Set only when the step's title or paths changed after the first line. */
  title: z.string().max(400).optional(),
  paths: z.array(z.string().max(300)).max(5).optional(),
  seconds: z.number().nonnegative().optional(),
  diff: RunDiff.optional(),
});
export const RunAgentLine = z.object({
  kind: z.literal('agent'),
  agentId: z.string().max(200),
  name: z.string().max(200),
  status: z.enum(['working', 'done', 'failed']),
  steps: z.number().int().nonnegative(),
  parentStepId: z.string().max(200).optional(),
});
export const RunPlanLine = z.object({ kind: z.literal('plan'), entries: z.array(RunPlanEntry).max(30) });
export const RunThinkingLine = z.object({ kind: z.literal('thinking'), seconds: z.number().nonnegative() });
export const RunApprovalLine = z.object({
  kind: z.literal('approval'),
  /** `ended`: the run was stopped (or ended) while the question waited, so nobody answered it. */
  outcome: z.enum(['asked', 'approved', 'denied', 'ended']),
  stepId: z.string().max(200).optional(),
  stepKind: RunStepKind.optional(),
  title: z.string().max(400).optional(),
  paths: z.array(z.string().max(300)).max(5).optional(),
  diff: RunDiff.optional(),
});

/** The payload of a kept line; `kind` repeats the line's own kind so a client can switch on it. */
export const RunActivityPayload = z.discriminatedUnion('kind', [RunToolLine, RunToolResultLine, RunAgentLine, RunPlanLine, RunThinkingLine, RunApprovalLine]);
export type RunActivityPayload = z.infer<typeof RunActivityPayload>;

export const RunActivityItem = z.object({ seq: z.number().int().nonnegative(), at: IsoDateTime, payload: RunActivityPayload });
export type RunActivityItem = z.infer<typeof RunActivityItem>;

// ---- reading ----------------------------------------------------------------------------------------------------------------------

export const RunActivityPathParams = z.object({ runId: RunId });
export type RunActivityPathParams = z.infer<typeof RunActivityPathParams>;

/** `after` is the position of the last line the client holds (-1 for none); lines come oldest first. */
export const RunActivityQuery = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type RunActivityQuery = z.infer<typeof RunActivityQuery>;

export const RunActivityResponse = z.object({
  run: RunHead,
  /** The whole plan as it is now (the head holds only its summary). */
  plan: z.array(RunPlanEntry).max(30),
  items: z.array(RunActivityItem),
  /** More lines follow `items` (ask again with `after` set to the last `seq`). */
  hasMore: z.boolean(),
});
export type RunActivityResponse = z.infer<typeof RunActivityResponse>;
export const runActivityRoute = { method: 'GET', path: '/api/runs/:runId/activity' } as const satisfies ApiRoute;

export const ThreadRunsPathParams = z.object({ rootId: MessageId });
export type ThreadRunsPathParams = z.infer<typeof ThreadRunsPathParams>;
/** The runs of a thread, oldest first (the newest hundred). */
export const ListThreadRunsResponse = z.object({ runs: z.array(RunHead).max(100) });
export type ListThreadRunsResponse = z.infer<typeof ListThreadRunsResponse>;
export const listThreadRunsRoute = { method: 'GET', path: '/api/threads/:rootId/runs' } as const satisfies ApiRoute;

// ---- who is working in a channel ------------------------------------------------------------------------------------------------

/** The runs that are going in a channel's threads, for the "Coder is working" chips of a page that was just opened (a run that began before the page loaded sent its `run.started` to nobody). */
export const ChannelRunsPathParams = z.object({ channelId: ChannelId });
export type ChannelRunsPathParams = z.infer<typeof ChannelRunsPathParams>;
export const ActiveChannelRun = z.object({
  runId: RunId,
  channelId: ChannelId,
  threadRootId: MessageId,
  botId: BotId,
  botActorId: ActorId.nullable(),
  botName: z.string().max(200),
  startedAt: IsoDateTime,
  /** The run's folded state (P29): present for the newest `CHANNEL_RUN_HEADS_MAX` runs, so the channel can draw the run card without a read per thread. */
  head: RunHead.optional(),
});
export type ActiveChannelRun = z.infer<typeof ActiveChannelRun>;
/** How many runs of a channel carry their head, and how long a run that ended stays in `recent` (a reload shows its folded line). */
export const CHANNEL_RUN_HEADS_MAX = 30;
export const CHANNEL_RUN_RECENT_MINUTES = 30;
export const ActiveChannelRunsResponse = z.object({
  /** Only runs that are going: a client turns every row into a "working" chip. */
  runs: z.array(ActiveChannelRun).max(100),
  /** The heads of runs that ended in the last `CHANNEL_RUN_RECENT_MINUTES`, newest first. A separate list on purpose: an older client reads `runs` only. */
  recent: z.array(RunHead).max(CHANNEL_RUN_HEADS_MAX).optional(),
});
export type ActiveChannelRunsResponse = z.infer<typeof ActiveChannelRunsResponse>;
export const activeChannelRunsRoute = { method: 'GET', path: '/api/channels/:channelId/active-runs' } as const satisfies ApiRoute;
/** The same read for the threads the Threads view lists (P29), by root (`ThreadBatchQuery`); `recent` is left out there. */
export const activeThreadRunsRoute = { method: 'GET', path: '/api/thread-batch/runs' } as const satisfies ApiRoute;

/** The sidebar's Threads entry (P29): in how many threads of the team a run is going, in channels the caller can read. A person's own conversation with a bot is not counted. */
export const ThreadsRunningResponse = z.object({ threads: z.number().int().nonnegative() });
export type ThreadsRunningResponse = z.infer<typeof ThreadsRunningResponse>;
export const threadsRunningRoute = { method: 'GET', path: '/api/teams/:slug/threads/running' } as const satisfies ApiRoute;

// ---- watching a thread ------------------------------------------------------------------------------------------------------------

/** How long a watch lasts without being renewed; the open thread panel renews it every `THREAD_WATCH_RENEW_SECONDS`. */
export const THREAD_WATCH_TTL_SECONDS = 60;
export const THREAD_WATCH_RENEW_SECONDS = 20;
/** The most open thread panels one person holds at once (all their tabs together); the next watch is a 429. */
export const THREAD_WATCH_MAX_PER_PERSON = 50;

/**
 * One lease per open panel: each browser tab names its own `leaseId` (a UUID it makes up), so closing a tab ends only that tab's lease and never one that another tab of
 * the same person still holds.
 */
export const ThreadWatchPathParams = z.object({ rootId: MessageId, leaseId: z.uuid() });
export type ThreadWatchPathParams = z.infer<typeof ThreadWatchPathParams>;
export const ThreadWatchResponse = z.object({ expiresAt: IsoDateTime });
export type ThreadWatchResponse = z.infer<typeof ThreadWatchResponse>;
export const ThreadUnwatchResponse = z.object({ ok: z.literal(true) });
export type ThreadUnwatchResponse = z.infer<typeof ThreadUnwatchResponse>;
export const watchThreadRoute = { method: 'PUT', path: '/api/threads/:rootId/watch/:leaseId' } as const satisfies ApiRoute;
export const unwatchThreadRoute = { method: 'DELETE', path: '/api/threads/:rootId/watch/:leaseId' } as const satisfies ApiRoute;

// ---- the lease of an open channel (P29) --------------------------------------------------------------------------------------------

/**
 * A channel page that draws the task view under its roots holds one lease for the whole channel, not one per thread: a thread lease also asks for the words of the answer
 * (`run.delta`, about 12 frames a second per run) and is capped at 50 per person, while the channel lease asks only for the folded state (`run.activity`).
 * Held `THREAD_WATCH_TTL_SECONDS`, renewed every `THREAD_WATCH_RENEW_SECONDS`.
 */
export const CHANNEL_WATCH_MAX_PER_PERSON = 8;
export const ChannelWatchPathParams = z.object({ channelId: ChannelId, leaseId: z.uuid() });
export type ChannelWatchPathParams = z.infer<typeof ChannelWatchPathParams>;
export const ChannelWatchResponse = z.object({ expiresAt: IsoDateTime });
export type ChannelWatchResponse = z.infer<typeof ChannelWatchResponse>;
export const ChannelUnwatchResponse = z.object({ ok: z.literal(true) });
export type ChannelUnwatchResponse = z.infer<typeof ChannelUnwatchResponse>;
export const watchChannelRoute = { method: 'PUT', path: '/api/channels/:channelId/watch/:leaseId' } as const satisfies ApiRoute;
export const unwatchChannelRoute = { method: 'DELETE', path: '/api/channels/:channelId/watch/:leaseId' } as const satisfies ApiRoute;

// ---- the live pushes of a run in a thread (WebSocket envelope `{ type, id, payload }`; ephemeral, never in the event log) ----------------

/** The folded state of a run, at most about once a second, to the people who have the thread open. Under 7 KB. */
export const WS_RUN_ACTIVITY = 'run.activity';
export const RunActivityPush = RunProgress.extend({ runId: RunId, channelId: ChannelId, threadRootId: MessageId });
export type RunActivityPush = z.infer<typeof RunActivityPush>;

/** A run began, to every reader of the channel (the root's "Coder is working" chip). The run's own steps are not pushed to them. */
export const WS_RUN_STARTED = 'run.started';
export const RunStartedPush = z.object({
  runId: RunId,
  channelId: ChannelId,
  threadRootId: MessageId,
  botId: BotId,
  botActorId: ActorId.nullable(),
  botName: z.string().max(200),
  startedAt: IsoDateTime,
});
export type RunStartedPush = z.infer<typeof RunStartedPush>;
// A run ended goes to the same readers as `run.ended` (`RunEndedPush`, conversations/chat.ts); the answer's words of a run in a thread go to the watchers as `run.delta`.
