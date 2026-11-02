import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotReassessmentId, RunId, TeamId } from '../ids.ts';

// Replay and re-assessment of a bot (PLAN P7-07, SPEC section 9). Two things the Workshop's Live mode shows:
//   replay        what a bot's earlier runs decided at the gate, the guard and the tool door, asked again of TODAY's rules. Free: no model is called and nothing is written or done;
//                 it only says which decisions would now come out differently. A full replay (the bot answering the same message again) is a separate action that shows its cost first
//                 and runs in the Rehearse sandbox, where every write is held back;
//   re-assessment a short list of what to check again, filed when something the bot depends on changed (a knowledge base, a runner, a connection) or its eval score dropped. No model.

/** What kind of check a recorded decision came from. `gate` the bot's topic list; `guard` the workspace's data rules before a model call; `tool` the capability door. */
export const RUN_DECISION_KINDS = ['gate', 'guard', 'tool'] as const;
export const RunDecisionKind = z.enum(RUN_DECISION_KINDS);
export type RunDecisionKind = z.infer<typeof RunDecisionKind>;

/** The outcomes `run_decisions.outcome` may hold (docs/plugins/bots.md): the gate's `passed`, `held`, `refused`; the guard's `allow`, `redact`, `require_approval`, `block` (and `refused` for a budget); the tool door's `allowed`, `needs_approval`, `denied`. */
export const RUN_DECISION_OUTCOMES = ['passed', 'held', 'refused', 'allow', 'redact', 'require_approval', 'block', 'allowed', 'needs_approval', 'denied'] as const;
export const RunDecisionOutcome = z.enum(RUN_DECISION_OUTCOMES);
export type RunDecisionOutcome = z.infer<typeof RunDecisionOutcome>;

/** The days a replay may look back, and the most runs, decisions and listed changes one answer carries. */
export const REPLAY_MAX_DAYS = 30;
export const REPLAY_MAX_RUNS = 200;
/** Decisions one replay reads (the newest), and the different permission questions it puts to the door. */
export const REPLAY_MAX_DECISIONS = 6000;
export const REPLAY_MAX_QUESTIONS = 80;
export const REPLAY_MAX_CHANGES = 100;

/** Where a decision lands once every kind is put on one scale, mildest first: it goes through, a part is hidden, it waits for a person, it is stopped. */
export const REPLAY_STATES = ['allowed', 'redacted', 'waits_for_person', 'refused'] as const;
export const ReplayState = z.enum(REPLAY_STATES);
export type ReplayState = z.infer<typeof ReplayState>;

/** `same` today's rules decide as before; `tighter` the decision would now be stricter (allowed to waits, waits to refused); `looser` it would now be milder; `not_replayed` it cannot be asked again (the reason is in the line). */
export const REPLAY_VERDICTS = ['same', 'tighter', 'looser', 'not_replayed'] as const;
export const ReplayVerdict = z.enum(REPLAY_VERDICTS);
export type ReplayVerdict = z.infer<typeof ReplayVerdict>;

/** One decision whose answer would differ today, or that cannot be asked again. Plain words only: no id, no tool name, no message text. */
export const ReplayChange = z.object({
  runId: RunId,
  at: IsoDateTime,
  kind: RunDecisionKind,
  /** What the decision was about, in words ("the topic list", "posting messages", "the smart model"). */
  what: z.string().max(200),
  recorded: ReplayState,
  /** Null when `verdict` is `not_replayed`. */
  now: ReplayState.nullable(),
  verdict: ReplayVerdict,
  /** One or two plain sentences: why it would change, or why it cannot be asked again. */
  explanation: z.string().max(600),
});
export type ReplayChange = z.infer<typeof ReplayChange>;

export const ReplayCounts = z.object({
  total: z.number().int().min(0),
  same: z.number().int().min(0),
  tighter: z.number().int().min(0),
  looser: z.number().int().min(0),
  notReplayed: z.number().int().min(0),
});
export type ReplayCounts = z.infer<typeof ReplayCounts>;

export const ReplayResult = z.object({
  days: z.number().int().min(1).max(REPLAY_MAX_DAYS),
  /** The start of the window that was looked at. */
  since: IsoDateTime,
  /** Always `none`: the replay calls no model. It is here so the screen can say so. */
  model: z.literal('none'),
  runs: z.number().int().min(0),
  /** True when more runs fit the window than one replay reads (the newest `REPLAY_MAX_RUNS` were read). */
  runsCapped: z.boolean(),
  counts: ReplayCounts,
  byKind: z.object({ gate: ReplayCounts, guard: ReplayCounts, tool: ReplayCounts }),
  /** Decisions that would now come out differently or cannot be asked again, newest first, at most `REPLAY_MAX_CHANGES`. */
  changes: z.array(ReplayChange).max(REPLAY_MAX_CHANGES),
  /** True when there are more changes than `changes` holds. */
  changesCapped: z.boolean(),
  /**
   * True when the replay did not look at everything it found: it reads the newest `REPLAY_MAX_DECISIONS` decisions, and asks the permission door at most `REPLAY_MAX_QUESTIONS` different
   * questions (a tool and the places it aimed at). Whatever was left out is said in `notes`, and a decision whose question was not asked is counted as not replayed.
   */
  decisionsCapped: z.boolean(),
  /** What the replay cannot do, in plain sentences (always shown with the result). */
  notes: z.array(z.string().max(400)).max(10),
  /** Runs in the window that the viewer may replay and that a full replay may start from (newest first, at most 20). */
  fullReplayable: z.array(z.object({ runId: RunId, at: IsoDateTime, trigger: z.string().max(40), hasMessage: z.boolean() })).max(20),
});
export type ReplayResult = z.infer<typeof ReplayResult>;

/** What a full replay (the bot answering the same message again, in the sandbox) would cost, counted from what the run itself used. */
export const FullReplayEstimate = z.object({
  runId: RunId,
  /** Model calls the original run made (0 when the ledger has none for it). */
  calls: z.number().int().min(0),
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  /** Prompt and answer tokens together: the number the person confirms. */
  tokens: z.number().int().min(0),
  /** Dollars the original run cost, or null when no price is known for it (a local model, or no line). */
  costUsd: z.number().min(0).nullable(),
  priceKnown: z.boolean(),
  /** A full replay stops after this many model calls whatever the original run did. */
  maxCalls: z.number().int().min(1),
  /** One plain sentence: where the numbers come from and what a replay cannot exceed. */
  basis: z.string().max(400),
  /** Sent back with `tokens` to start the replay: it is made by the server from the run, the person and the number, so a bare number (or a zero) never starts one. */
  confirmToken: z.string().regex(/^[0-9a-f]{16}$/),
});
export type FullReplayEstimate = z.infer<typeof FullReplayEstimate>;

export const REASSESSMENT_REASONS = [
  'knowledge_added',
  'knowledge_removed',
  'runner_added',
  'runner_revoked',
  'runner_changed',
  'connection_added',
  'connection_revoked',
  'eval_dropped',
] as const;
export const ReassessmentReason = z.enum(REASSESSMENT_REASONS);
export type ReassessmentReason = z.infer<typeof ReassessmentReason>;

/** `open` waits for a lead; `done` a lead checked it; `dismissed` a lead said it does not matter. */
export const REASSESSMENT_STATUSES = ['open', 'done', 'dismissed'] as const;
export const ReassessmentStatus = z.enum(REASSESSMENT_STATUSES);
export type ReassessmentStatus = z.infer<typeof ReassessmentStatus>;

/** What a lead can answer: checked it, or it does not matter. */
export const ReassessmentAnswer = z.enum(['done', 'dismissed']);
export type ReassessmentAnswer = z.infer<typeof ReassessmentAnswer>;

export const Reassessment = z.object({
  id: BotReassessmentId,
  teamId: TeamId,
  botSlug: z.string(),
  reason: ReassessmentReason,
  /** The name of what changed (a knowledge base, a runner); empty for an eval score. */
  subject: z.string().max(100),
  /** One plain sentence: what happened. */
  headline: z.string().max(200),
  /** What to look at again, in plain sentences (two to five). */
  checks: z.array(z.string().max(300)).max(8),
  status: ReassessmentStatus,
  createdAt: IsoDateTime,
  closedAt: IsoDateTime.nullable(),
});
export type Reassessment = z.infer<typeof Reassessment>;
