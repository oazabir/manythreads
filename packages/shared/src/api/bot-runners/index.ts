import { z } from 'zod';
import {
  BotRunner,
  BotRunnerKind,
  BotRunnerLabel,
  BotRunnerName,
  OldConnection,
  TeamBotRunner,
} from '../../entities/bot-runner.ts';
import { HermesBaseUrl } from '../hermes/connections.ts';
import { BotRunnerId, TeamId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

// The runner catalog (PLAN Phase 19, P19-02, docs/plugins/bot-runners.md). A workspace admin makes, changes, tests, shares and removes runners; a team member
// only reads the short view of the runners available to their team. A key is accepted on create and update and never returned.

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

export const ListBotRunnersResponse = z.object({ items: z.array(BotRunner) });
export type ListBotRunnersResponse = z.infer<typeof ListBotRunnersResponse>;
export const listBotRunnersRoute = { method: 'GET', path: '/api/admin/bot-runners' } as const;

/**
 * Make a runner. The kinds `claude_cli` and `codex_cli` are accepted by the shape and answered with 409 "not available yet" until their tasks are built.
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
  /** Pod kinds: the node, a Kubernetes host name (P19-08). */
  node: z.string().min(1).max(253).optional(),
  /** LLM gateway: the alias from the LLM page. */
  modelAlias: z.string().min(1).max(40).optional(),
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
  node: z.string().min(1).max(253).nullable().optional(),
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
