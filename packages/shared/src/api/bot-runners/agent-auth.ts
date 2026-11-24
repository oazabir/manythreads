import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { BotRunner, BotRunnerSignInScope, BotRunnerTeamSignInState, BotRunnerTeam } from '../../entities/bot-runner.ts';
import { BotRunnerId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

// Signing an agent runner in and out from the Runners page (P25-09, docs/plans/acp.md section 4.1). The runner is a Hermes gateway runner whose address answers as an agent
// bridge (`claude-code` or `codex`); the server asks that bridge, which asks the agent's own adapter. The shapes here are what the server hands to the page after reading
// the bridge's answer: only the fields below, each bounded, so a bridge cannot put free text or a secret into the page. A code or a key goes in `AnswerAgentLoginRequest`
// once and is never stored, returned or put in an event. The agent's account (e-mail, organization) never gets here at all.

export const AgentAuthAgent = z.enum(['claude-code', 'codex']);
export type AgentAuthAgent = z.infer<typeof AgentAuthAgent>;

/** `not_needed`: the agent has no sign-in of its own (it uses the workspace's model gateway). `unknown`: the agent did not say. */
export const AgentAuthState = z.enum(['signed_in', 'signed_out', 'unknown', 'not_needed']);
export type AgentAuthState = z.infer<typeof AgentAuthState>;

/** How a person signs in with a method: type a code shown on a page (`device_code`), open a page and paste the code it gives (`paste_code`), or give an API key (`api_key`). */
export const AgentAuthHow = z.enum(['device_code', 'paste_code', 'api_key']);
export type AgentAuthHow = z.infer<typeof AgentAuthHow>;

export const AgentAuthMethod = z.object({
  id: z.string().min(1).max(80),
  /** The agent's own name for the method ("Claude Subscription", "Sign in with ChatGPT (device code)"). */
  name: z.string().max(80),
  description: z.string().max(200),
  how: AgentAuthHow,
});
export type AgentAuthMethod = z.infer<typeof AgentAuthMethod>;

/** The real Claude sign-in address is about 470 characters; the bound leaves room for longer ones and stops a flood. The bridge uses the same number. */
export const SIGN_IN_PAGE_MAX = 2000;
const SignInPage = z.string().regex(new RegExp(`^https://[^\\s"'<>]{1,${SIGN_IN_PAGE_MAX}}$`), 'a page address starting with https://');

/** What the person must do now. */
export const AgentAuthAction = z.discriminatedUnion('type', [
  /** Open `url` and enter `code` there. */
  z.object({ type: z.literal('enter_code'), url: SignInPage, code: z.string().regex(/^[A-Za-z0-9-]{3,20}$/) }),
  /** Open `url` and follow what it says. */
  z.object({ type: z.literal('open_url'), url: SignInPage }),
  /** Open `url`, sign in, and paste the code the page shows back here. */
  z.object({ type: z.literal('paste_code'), url: SignInPage }),
  /** Give an API key. */
  z.object({ type: z.literal('give_key') }),
]);
export type AgentAuthAction = z.infer<typeof AgentAuthAction>;

export const AgentAuthAttemptState = z.enum(['starting', 'waiting', 'needs_input', 'checking', 'done', 'failed', 'cancelled']);
export type AgentAuthAttemptState = z.infer<typeof AgentAuthAttemptState>;

export const AgentAuthAttempt = z.object({
  id: z.string().min(1).max(80),
  methodId: z.string().min(1).max(80),
  /** What kind of sign-in it is (the audit line says it, never the code or the key). */
  how: AgentAuthHow,
  state: AgentAuthAttemptState,
  action: AgentAuthAction.nullable(),
  /** One plain sentence: what to do, or why it failed. */
  message: z.string().max(400).nullable(),
});
export type AgentAuthAttempt = z.infer<typeof AgentAuthAttempt>;

/** Whose sign-in a sign-in or sign-out here changes: `dedicated` (the bridge profile has a sign-in folder of its own) or `shared` (the machine's own, used by everyone who runs the tool there). */
export const AgentAuthHome = z.enum(['dedicated', 'shared']);
export type AgentAuthHome = z.infer<typeof AgentAuthHome>;

export const AgentAuth = z.object({
  agent: AgentAuthAgent,
  /** The bridge profile the answer is about. */
  profile: z.string().max(64),
  /** Null for an agent with no sign-in of its own. */
  home: AgentAuthHome.nullable(),
  state: AgentAuthState,
  /** How the agent is signed in, as it words it (`account`, `gateway`, ...); no e-mail, no organization. */
  kind: z.string().max(24).nullable(),
  canLogout: z.boolean(),
  methods: z.array(AgentAuthMethod).max(8),
  /** The sign-in under way, or the last one that ended (kept for ten minutes). */
  attempt: AgentAuthAttempt.nullable(),
  note: z.string().max(300).nullable(),
});
export type AgentAuth = z.infer<typeof AgentAuth>;

export const AgentAuthPathParams = z.object({ id: BotRunnerId });

/**
 * The team whose sign-in is meant, by slug (P35-10): required for a runner where each team signs in, refused for a runner with one sign-in for all its teams. A GET carries it
 * in the query (`?team=`), the other routes in the body.
 */
export const AgentAuthTeam = TeamSlug;
export const GetAgentAuthQuery = z.strictObject({ team: AgentAuthTeam.optional() });
export type GetAgentAuthQuery = z.infer<typeof GetAgentAuthQuery>;

export const GetAgentAuthResponse = z.object({ auth: AgentAuth });
export type GetAgentAuthResponse = z.infer<typeof GetAgentAuthResponse>;
export const getAgentAuthRoute = { method: 'GET', path: '/api/admin/bot-runners/:id/agent-auth' } as const;

export const StartAgentLoginRequest = z.strictObject({ methodId: z.string().min(1).max(80), team: AgentAuthTeam.optional() });
export type StartAgentLoginRequest = z.infer<typeof StartAgentLoginRequest>;
export const AgentLoginResponse = z.object({ attempt: AgentAuthAttempt });
export type AgentLoginResponse = z.infer<typeof AgentLoginResponse>;
export const startAgentLoginRoute = { method: 'POST', path: '/api/admin/bot-runners/:id/agent-auth/login' } as const;

/** The code the page gave (one line) or the API key; exactly one of them. It goes to the bridge and nowhere else. */
export const AnswerAgentLoginRequest = z
  .strictObject({
    attemptId: z.string().min(1).max(80),
    code: z.string().min(1).max(2000).optional(),
    apiKey: z.string().min(8).max(500).optional(),
    team: AgentAuthTeam.optional(),
  })
  .refine((v) => (v.code === undefined) !== (v.apiKey === undefined), 'give the code or the key, not both');
export type AnswerAgentLoginRequest = z.infer<typeof AnswerAgentLoginRequest>;
export const answerAgentLoginRoute = { method: 'POST', path: '/api/admin/bot-runners/:id/agent-auth/answer' } as const;

export const CancelAgentLoginRequest = z.strictObject({ attemptId: z.string().min(1).max(80).optional(), team: AgentAuthTeam.optional() });
export type CancelAgentLoginRequest = z.infer<typeof CancelAgentLoginRequest>;
export const cancelAgentLoginRoute = { method: 'POST', path: '/api/admin/bot-runners/:id/agent-auth/cancel' } as const;

export const AgentLogoutRequest = z.strictObject({ team: AgentAuthTeam.optional() });
export type AgentLogoutRequest = z.infer<typeof AgentLogoutRequest>;
export const AgentLogoutResponse = z.object({ auth: AgentAuth });
export type AgentLogoutResponse = z.infer<typeof AgentLogoutResponse>;
export const agentLogoutRoute = { method: 'POST', path: '/api/admin/bot-runners/:id/agent-auth/logout' } as const;

/**
 * One team of a runner where each team signs in, for the page's list (P35-10). `state` is the stored state (the pod controller's pass, or the page's last read): null when
 * nobody has seen this team's sign-in yet. `served`: the team has a pod on this runner (a bot of it is placed there, or it is the first team while none is), so it can sign in.
 */
export const AgentAuthTeamState = BotRunnerTeam.extend({
  served: z.boolean(),
  state: BotRunnerTeamSignInState.nullable(),
  /** `limited` only: when the team's plan limit resets. */
  pausedUntil: IsoDateTime.nullable().default(null),
  checkedAt: IsoDateTime.nullable(),
});
export type AgentAuthTeamState = z.infer<typeof AgentAuthTeamState>;
export const ListAgentAuthTeamsResponse = z.object({ items: z.array(AgentAuthTeamState).max(500) });
export type ListAgentAuthTeamsResponse = z.infer<typeof ListAgentAuthTeamsResponse>;
export const listAgentAuthTeamsRoute = { method: 'GET', path: '/api/admin/bot-runners/:id/agent-auth/teams' } as const;

/**
 * Change who signs a runner in. Switching signs out for real first and removes the old sign-in (every team's own, or the one for all teams), and every pod of the runner restarts:
 * runs under way stop. The answer is the runner as it is afterwards.
 */
export const SetSignInScopeRequest = z.strictObject({ scope: BotRunnerSignInScope });
export type SetSignInScopeRequest = z.infer<typeof SetSignInScopeRequest>;
export const SetSignInScopeResponse = z.object({ runner: BotRunner });
export type SetSignInScopeResponse = z.infer<typeof SetSignInScopeResponse>;
export const setSignInScopeRoute = { method: 'PUT', path: '/api/admin/bot-runners/:id/sign-in-scope' } as const;
