import { z } from 'zod';
import {
  BotRunner,
  BotRunnerAgent,
  BotRunnerKind,
  BotRunnerLabel,
  BotRunnerName,
  OldConnection,
  RunnerNode,
  RunnerNodeName,
  RunnerPlacement,
  TeamBotRunner,
} from '../../entities/bot-runner.ts';
import { HermesBaseUrl } from '../hermes/connections.ts';
import { BotRunnerId, TeamId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

// The runner catalog (PLAN Phase 19, P19-02, docs/plugins/bot-runners.md). A workspace admin makes, changes, tests, shares and removes runners; a team member
// only reads the short view of the runners available to their team. A key is accepted on create and update and never returned.

export * from './credentials.ts';
export * from './codex-credentials.ts';

export const BotRunnerPathParams = z.object({ id: BotRunnerId });
export const TeamBotRunnersPathParams = z.object({ slug: TeamSlug });

/** Which teams may use a runner: every team, or exactly the listed ones. The list is the permission. */
export const BotRunnerTeams = z.union([z.strictObject({ all: z.literal(true) }), z.strictObject({ teams: z.array(TeamId).max(500) })]);
export type BotRunnerTeams = z.infer<typeof BotRunnerTeams>;

/** How a Hermes profile is named from a bot: `{bot}` stands for the bot's slug. */
export const BotRunnerProfileRule = z
  .string()
  .max(80)
  .regex(/^[A-Za-z0-9._{}-]+$/, 'letters, digits, ".", "_", "-" and {bot}')
  .refine((v) => v.includes('{bot}'), 'the rule must contain {bot}');

/** A key for a Hermes gateway (the `API_SERVER_KEY` of its profile). */
export const BotRunnerApiKey = z.string().min(8).max(500);

export const ListBotRunnersResponse = z.object({
  items: z.array(BotRunner),
  /** The server runs Claude Code pods (the chart turned them on), so a Claude Code runner can be made. False: the Claude Code card on the add form stays shut. */
  claudePodsAvailable: z.boolean().default(false),
});
export type ListBotRunnersResponse = z.infer<typeof ListBotRunnersResponse>;
export const listBotRunnersRoute = { method: 'GET', path: '/api/admin/bot-runners' } as const;

/**
 * Make a runner. `claude_cli` is accepted where the server runs Claude Code pods (else 409); `codex_cli` is accepted by the shape and answered with 409 "not available yet" until its task is built.
 * `teams` omitted means no team yet (the admin ticks them); a runner nobody may use is safe, a runner everybody may use is a decision.
 */
export const CreateBotRunnerRequest = z.strictObject({
  name: BotRunnerName,
  label: BotRunnerLabel,
  kind: BotRunnerKind,
  /** Hermes gateway: where it answers. */
  baseUrl: HermesBaseUrl.optional(),
  /** Hermes gateway: its key. */
  apiKey: BotRunnerApiKey.optional(),
  profileRule: BotRunnerProfileRule.optional(),
  /** Hermes gateway: what answers at the address; left out means `hermes`. `claude-code` and `codex` are the agent bridge (P19-14). Admin only, like every field here. */
  agent: BotRunnerAgent.optional(),
  /** LLM gateway: the alias from the LLM page. */
  modelAlias: z.string().min(1).max(40).optional(),
  /** Claude Code: runs at once on this runner (1 to 4); left out means the install's default. */
  maxConcurrent: z.number().int().min(1).max(4).optional(),
  enabled: z.boolean().optional(),
  teams: BotRunnerTeams.optional(),
});
export type CreateBotRunnerRequest = z.infer<typeof CreateBotRunnerRequest>;
export const CreateBotRunnerResponse = z.object({ runner: BotRunner });
export type CreateBotRunnerResponse = z.infer<typeof CreateBotRunnerResponse>;
export const createBotRunnerRoute = { method: 'POST', path: '/api/admin/bot-runners' } as const;

/** Change a runner. The name and the kind never change. Turning a runner off keeps its bots and refuses their runs with a plain line. */
export const UpdateBotRunnerRequest = z.strictObject({
  label: BotRunnerLabel.optional(),
  baseUrl: HermesBaseUrl.optional(),
  apiKey: BotRunnerApiKey.optional(),
  profileRule: BotRunnerProfileRule.optional(),
  /** Hermes gateway only (P19-14): what answers at the address. A change needs a new Test. */
  agent: BotRunnerAgent.optional(),
  modelAlias: z.string().min(1).max(40).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateBotRunnerRequest = z.infer<typeof UpdateBotRunnerRequest>;
export const UpdateBotRunnerResponse = z.object({ runner: BotRunner });
export type UpdateBotRunnerResponse = z.infer<typeof UpdateBotRunnerResponse>;
export const updateBotRunnerRoute = { method: 'PATCH', path: '/api/admin/bot-runners/:id' } as const;

export const DeleteBotRunnerResponse = z.object({ deleted: z.literal(true) });
export type DeleteBotRunnerResponse = z.infer<typeof DeleteBotRunnerResponse>;
export const deleteBotRunnerRoute = { method: 'DELETE', path: '/api/admin/bot-runners/:id' } as const;

// A delete of a runner that bots are placed on answers 409; its message says how many bots and which teams they belong to.

/** Check a runner. A Hermes gateway is asked as the connection test asks (three fixed sentences, through the outbound guard); other kinds report their state. */
export const TestBotRunnerRequest = z.strictObject({
  /** The profile to ask for; omitted checks the gateway's default profile. */
  profile: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .optional(),
});
export type TestBotRunnerRequest = z.infer<typeof TestBotRunnerRequest>;
export const TestBotRunnerResponse = z.object({
  ok: z.boolean(),
  /** Why it failed, in a sentence a person can act on (never a stack, a remote body or a secret). */
  error: z.string().nullable(),
  status: z.enum(['not_set_up', 'waiting_for_sign_in', 'starting', 'ready', 'needs_sign_in', 'waiting_for_node', 'moving', 'paused', 'off']),
  checkedAt: z.string(),
});
export type TestBotRunnerResponse = z.infer<typeof TestBotRunnerResponse>;
export const testBotRunnerRoute = { method: 'POST', path: '/api/admin/bot-runners/:id/test' } as const;

export const SetBotRunnerTeamsRequest = BotRunnerTeams;
export type SetBotRunnerTeamsRequest = z.infer<typeof SetBotRunnerTeamsRequest>;
export const SetBotRunnerTeamsResponse = z.object({ runner: BotRunner });
export type SetBotRunnerTeamsResponse = z.infer<typeof SetBotRunnerTeamsResponse>;
export const setBotRunnerTeamsRoute = { method: 'PUT', path: '/api/admin/bot-runners/:id/teams' } as const;

/** Make a runner the default (what a bot with no placement runs on), or `null` to have none. */
export const SetDefaultBotRunnerRequest = z.strictObject({ runnerId: BotRunnerId.nullable() });
export type SetDefaultBotRunnerRequest = z.infer<typeof SetDefaultBotRunnerRequest>;
export const SetDefaultBotRunnerResponse = z.object({ defaultRunnerId: BotRunnerId.nullable() });
export type SetDefaultBotRunnerResponse = z.infer<typeof SetDefaultBotRunnerResponse>;
export const setDefaultBotRunnerRoute = { method: 'PUT', path: '/api/admin/bot-runners/default' } as const;

/**
 * The machines of the cluster the operator allows (Helm `botRunners.allowedNodes`, empty: all), for the node picker (P19-08). `runnerId` asks for one pod runner:
 * then every node also says whether that runner's work volume is there, and `placement` says where the runner's pods stand. Without it those fields are zero/null.
 * Admin only.
 */
export const ListRunnerNodesQuery = z.object({ runnerId: BotRunnerId.optional() });
export type ListRunnerNodesQuery = z.infer<typeof ListRunnerNodesQuery>;
export const ListRunnerNodesResponse = z.object({
  /** False when this install cannot list machines (no cluster behind the server). `nodes` is then empty and `note` says so. */
  available: z.boolean(),
  nodes: z.array(RunnerNode),
  /** The cluster has exactly one allowed machine: the picker shows it and says that there is nothing to choose. */
  singleNode: z.boolean(),
  placement: RunnerPlacement.nullable(),
  /** One plain sentence when something is worth saying (no cluster, the cluster did not answer). */
  note: z.string().nullable(),
});
export type ListRunnerNodesResponse = z.infer<typeof ListRunnerNodesResponse>;
export const listRunnerNodesRoute = { method: 'GET', path: '/api/admin/bot-runners/nodes' } as const;

/**
 * Choose the machine a pod runner's pods stand on, or `null` to let the cluster choose. A name must be allowed by the operator and Ready. Changing the machine
 * recreates the pods' work volumes empty on the new one (the Secrets stay); the page asks to confirm first.
 */
export const SetRunnerNodeRequest = z.strictObject({ node: RunnerNodeName.nullable() });
export type SetRunnerNodeRequest = z.infer<typeof SetRunnerNodeRequest>;
export const SetRunnerNodeResponse = z.object({ runner: BotRunner, recreatesWorkVolume: z.boolean() });
export type SetRunnerNodeResponse = z.infer<typeof SetRunnerNodeResponse>;
export const setRunnerNodeRoute = { method: 'PUT', path: '/api/admin/bot-runners/:id/node' } as const;

export const ListOldConnectionsResponse = z.object({ items: z.array(OldConnection) });
export type ListOldConnectionsResponse = z.infer<typeof ListOldConnectionsResponse>;
export const listOldConnectionsRoute = { method: 'GET', path: '/api/admin/bot-runners/old-connections' } as const;

export const OldConnectionPathParams = z.object({ connectionId: z.uuid() });
/** Turn a team's old connection into a runner (same address, same key) that only that team may use. Nothing in any BOT.md changes. */
export const AdoptConnectionRequest = z.strictObject({
  /** The runner's name; omitted: the connection's own name (`host`) or, for a team pod, `team-pod`. */
  name: BotRunnerName.optional(),
  label: BotRunnerLabel.optional(),
});
export type AdoptConnectionRequest = z.infer<typeof AdoptConnectionRequest>;
export const AdoptConnectionResponse = z.object({ runner: BotRunner });
export type AdoptConnectionResponse = z.infer<typeof AdoptConnectionResponse>;
export const adoptConnectionRoute = { method: 'POST', path: '/api/admin/bot-runners/old-connections/:connectionId/adopt' } as const;

/** What a team member sees: the runners available to the team, in the short view. */
export const ListTeamBotRunnersResponse = z.object({ items: z.array(TeamBotRunner) });
export type ListTeamBotRunnersResponse = z.infer<typeof ListTeamBotRunnersResponse>;
export const listTeamBotRunnersRoute = { method: 'GET', path: '/api/teams/:slug/bot-runners' } as const;
