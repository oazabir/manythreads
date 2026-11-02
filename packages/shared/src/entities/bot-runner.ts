import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotRunnerId, TeamId, WorkspaceId } from '../ids.ts';

// Bot runners (PLAN Phase 19, P19-02): the places a bot can run, set up by a workspace admin. Every enum matches a CHECK of the bot-runners migration
// 0001_bot_runners.sql; the kernel's schema-enums test compares the two.

/**
 * What a runner is. `hermes_gateway`: a Hermes running on the devbox host or any machine, reached by address and key. `hermes_pod`: the team's own Hermes pod in
 * the cluster. `claude_cli` and `codex_cli`: the Claude Code or Codex command-line tool in a pod, signed in with a file the admin uploads (later tasks).
 * `llm_gateway`: a model alias called through the platform's own LLM gateway.
 */
export const BotRunnerKind = z.enum(['hermes_gateway', 'hermes_pod', 'claude_cli', 'codex_cli', 'llm_gateway']);
export type BotRunnerKind = z.infer<typeof BotRunnerKind>;

/** The kinds an admin can make today; the other two answer "not available yet" until the pod tasks of the phase are built. */
export const CREATABLE_BOT_RUNNER_KINDS = ['hermes_gateway', 'hermes_pod', 'llm_gateway'] as const;
export const CreatableBotRunnerKind = z.enum(CREATABLE_BOT_RUNNER_KINDS);
export type CreatableBotRunnerKind = z.infer<typeof CreatableBotRunnerKind>;

/** The state a runner is in, as the admin page and the picker word it. A disabled runner always reads `off`. */
export const BotRunnerStatus = z.enum(['not_set_up', 'waiting_for_sign_in', 'starting', 'ready', 'needs_sign_in', 'waiting_for_node', 'moving', 'paused', 'off']);
export type BotRunnerStatus = z.infer<typeof BotRunnerStatus>;

/** A runner's name: the slug a BOT.md `placement.runs_on` uses. It never changes after the runner is made. */
export const BotRunnerName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, 'lowercase letters, digits, ".", "_" or "-"');
export type BotRunnerName = z.infer<typeof BotRunnerName>;

/** The words on screen. */
export const BotRunnerLabel = z.string().trim().min(1).max(80);

/** A team on a runner's list, as the admin page shows it. */
export const BotRunnerTeam = z.object({ teamId: TeamId, slug: z.string(), name: z.string() });
export type BotRunnerTeam = z.infer<typeof BotRunnerTeam>;

/**
 * A runner as a workspace admin sees it. No key, token or sign-in is here: the Hermes gateway's key is kept encrypted and only says whether it exists
 * (`hasKey`). Everyone else sees `TeamBotRunner`.
 */
export const BotRunner = z.object({
  id: BotRunnerId,
  workspaceId: WorkspaceId,
  name: BotRunnerName,
  label: z.string(),
  kind: BotRunnerKind,
  enabled: z.boolean(),
  isDefault: z.boolean(),
  /** True: every team may use it. False: only `teams`. */
  allTeams: z.boolean(),
  /** The list that is the permission when `allTeams` is false (empty when it is true). */
  teams: z.array(BotRunnerTeam),
  /** A Hermes gateway's address. */
  baseUrl: z.string().nullable(),
  hasKey: z.boolean(),
  /** How the profile of a bot is named on a Hermes gateway: `{bot}` is the bot's slug. */
  profileRule: z.string().nullable(),
  node: z.string().nullable(),
  modelAlias: z.string().nullable(),
  ownerActorId: ActorId.nullable(),
  ownerName: z.string().nullable(),
  planLabel: z.string().nullable(),
  credentialsExpiresAt: IsoDateTime.nullable(),
  uploadedAt: IsoDateTime.nullable(),
  termsAcceptedBy: ActorId.nullable(),
  termsAcceptedAt: IsoDateTime.nullable(),
  maxConcurrent: z.number().int().min(1).max(4).nullable(),
  /** `off` when the runner is disabled, whatever was last found. */
  status: BotRunnerStatus,
  statusDetail: z.string().nullable(),
  pausedUntil: IsoDateTime.nullable(),
  lastCheckedAt: IsoDateTime.nullable(),
  /** How many bots (switched on or off, not broken ones) are placed on it by `runs_on`, or through a connection that was adopted into it. */
  botCount: z.number().int().min(0),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotRunner = z.infer<typeof BotRunner>;

/**
 * What a team member sees of a runner available to their team: its name, kind, state and, for the subscription kinds, the owner's name and plan.
 * Never an address, a key, a node or the expiry of a sign-in. The database function `app.bot_runners_for_team` returns exactly these fields.
 */
export const TeamBotRunner = z.object({
  name: BotRunnerName,
  label: z.string(),
  kind: BotRunnerKind,
  status: BotRunnerStatus,
  isDefault: z.boolean(),
  ownerName: z.string().nullable(),
  planLabel: z.string().nullable(),
  /** How many teams may use it (every team of the workspace when it is open to all). A count; the teams are not named. */
  sharedWith: z.number().int().min(0),
});
export type TeamBotRunner = z.infer<typeof TeamBotRunner>;

/** A team's own Hermes connection from before runners existed ("Team-owned (old)"), as the admin page lists it so it can be adopted. */
export const OldConnection = z.object({
  id: z.uuid(),
  teamId: TeamId,
  teamSlug: z.string(),
  teamName: z.string(),
  name: z.string(),
  /** `external` is a gateway a lead typed; `managed` is the team's own Hermes pod. */
  kind: z.enum(['external', 'managed']),
  agent: z.enum(['hermes', 'claude-code', 'codex']),
  baseUrl: z.string().nullable(),
  /** False for a connection to the Claude Code or Codex command-line tool: those become runners with the pod tasks of the phase. */
  adoptable: z.boolean(),
  adoptableReason: z.string().nullable(),
  /** Bots (switched on or off) whose BOT.md names this connection. */
  botCount: z.number().int().min(0),
});
export type OldConnection = z.infer<typeof OldConnection>;
