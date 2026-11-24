import {
  AdoptConnectionRequest,
  AgentLoginResponse,
  AgentLogoutRequest,
  AgentLogoutResponse,
  GetAgentAuthQuery,
  ListAgentAuthTeamsResponse,
  SetSignInScopeRequest,
  SetSignInScopeResponse,
  listAgentAuthTeamsRoute,
  setSignInScopeRoute,
  type BotRunnerSignInScope,
  AnswerAgentLoginRequest,
  CancelAgentLoginRequest,
  GetAgentAuthResponse,
  StartAgentLoginRequest,
  agentLogoutRoute,
  answerAgentLoginRoute,
  cancelAgentLoginRoute,
  getAgentAuthRoute,
  startAgentLoginRoute,
  CheckClaudeSigninResponse,
  CODEX_PLAN_LABEL_HEADER,
  ClaudeRunnerUsageResponse,
  CREDENTIALS_SIGNINS_HEADER,
  CREDENTIALS_TERMS_HEADER,
  PutClaudeCredentialsResponse,
  RemoveClaudeCredentialsResponse,
  AdoptConnectionResponse,
  CreateBotRunnerRequest,
  CreateBotRunnerResponse,
  DeleteBotRunnerResponse,
  ListBotRunnersResponse,
  ListOldConnectionsResponse,
  ListRunnerNodesQuery,
  ListRunnerNodesResponse,
  SetBotRunnerTeamsRequest,
  SetBotRunnerTeamsResponse,
  SetDefaultBotRunnerRequest,
  SetDefaultBotRunnerResponse,
  SetRunnerNodeRequest,
  SetRunnerNodeResponse,
  TestBotRunnerRequest,
  TestBotRunnerResponse,
  UpdateBotRunnerRequest,
  UpdateBotRunnerResponse,
  adoptConnectionRoute,
  checkClaudeSigninRoute,
  claudeRunnerUsageRoute,
  putClaudeCredentialsRoute,
  removeClaudeCredentialsRoute,
  createBotRunnerRoute,
  deleteBotRunnerRoute,
  listBotRunnersRoute,
  listOldConnectionsRoute,
  listRunnerNodesRoute,
  setBotRunnerTeamsRoute,
  setDefaultBotRunnerRoute,
  setRunnerNodeRoute,
  testBotRunnerRoute,
  updateBotRunnerRoute,
} from '@manythreads/shared';
import { call } from '../../../api/client';

/*
 * What the Runners page asks of the server (docs/plugins/bot-runners.md). Every route is for a workspace admin. A gateway key goes in on `create` or
 * `update` and is never read back: the list says only whether one is set (`hasKey`).
 */

export const fetchBotRunners = () => call(listBotRunnersRoute, { response: ListBotRunnersResponse });

export const createBotRunner = (body: CreateBotRunnerRequest) =>
  call(createBotRunnerRoute, { request: CreateBotRunnerRequest, response: CreateBotRunnerResponse }, body);

export const updateBotRunner = (id: string, body: UpdateBotRunnerRequest) =>
  call(updateBotRunnerRoute, { request: UpdateBotRunnerRequest, response: UpdateBotRunnerResponse }, body, { id });

export const deleteBotRunner = (id: string) => call(deleteBotRunnerRoute, { response: DeleteBotRunnerResponse }, undefined, { id });

/** Ask the runner whether it answers; `profile` names the Hermes profile to ask for (left out: the gateway's default one). */
export const testBotRunner = (id: string, body: TestBotRunnerRequest = {}) =>
  call(testBotRunnerRoute, { request: TestBotRunnerRequest, response: TestBotRunnerResponse }, body, { id });

export const setBotRunnerTeams = (id: string, body: SetBotRunnerTeamsRequest) =>
  call(setBotRunnerTeamsRoute, { request: SetBotRunnerTeamsRequest, response: SetBotRunnerTeamsResponse }, body, { id });

/** `null` clears the default. */
export const setDefaultBotRunner = (runnerId: string | null) =>
  call(setDefaultBotRunnerRoute, { request: SetDefaultBotRunnerRequest, response: SetDefaultBotRunnerResponse }, { runnerId });

export const fetchOldConnections = () => call(listOldConnectionsRoute, { response: ListOldConnectionsResponse });

/** The machines the operator allows for pod runners; with `runnerId`, also where that runner's work volume is and where its pods stand. */
export const fetchRunnerNodes = (runnerId?: string) =>
  call(listRunnerNodesRoute, { request: ListRunnerNodesQuery, response: ListRunnerNodesResponse }, runnerId ? ({ runnerId } as ListRunnerNodesQuery) : {});

/** `null` lets the cluster choose. A new machine recreates the pods' work volumes empty on it (the page asks first). */
export const setRunnerNode = (id: string, node: string | null) =>
  call(setRunnerNodeRoute, { request: SetRunnerNodeRequest, response: SetRunnerNodeResponse }, { node }, { id });

export const adoptOldConnection = (connectionId: string, body: AdoptConnectionRequest = {}) =>
  call(adoptConnectionRoute, { request: AdoptConnectionRequest, response: AdoptConnectionResponse }, body, { connectionId });

// The Claude Code runner's sign-in (P19-06). The file goes up as the text the admin chose, unchanged; the server stores it byte for byte and answers with the
// runner (plan, expiry), never the file. Both boxes must be ticked: the plan's terms, and the other sign-ins the file holds.
export const uploadClaudeCredentials = (id: string, text: string) =>
  call(putClaudeCredentialsRoute, { response: PutClaudeCredentialsResponse }, undefined, { id }, { rawBody: text, headers: { [CREDENTIALS_TERMS_HEADER]: '1', [CREDENTIALS_SIGNINS_HEADER]: '1' } });

/**
 * The Codex runner's sign-in (P19-13) goes the same route with the same two boxes. The server reads no token, so the page names the plan it read from the file in the
 * `x-plan-label` header (the server accepts only a name from a fixed list).
 */
export const uploadCodexCredentials = (id: string, text: string, planLabel: string) =>
  call(putClaudeCredentialsRoute, { response: PutClaudeCredentialsResponse }, undefined, { id }, { rawBody: text, headers: { [CREDENTIALS_TERMS_HEADER]: '1', [CREDENTIALS_SIGNINS_HEADER]: '1', [CODEX_PLAN_LABEL_HEADER]: planLabel } });

export const removeClaudeCredentials = (id: string) => call(removeClaudeCredentialsRoute, { response: RemoveClaudeCredentialsResponse }, undefined, { id });

export const checkClaudeSignin = (id: string) => call(checkClaudeSigninRoute, { response: CheckClaudeSigninResponse }, undefined, { id });

export const fetchClaudeUsage = () => call(claudeRunnerUsageRoute, { response: ClaudeRunnerUsageResponse });

// The sign-in of an agent behind a gateway runner (P25-09): the bridge asks the agent's own adapter. The code or key of an answer goes up once and is kept nowhere.
// `team` (a slug): the team's own sign-in, on a runner where each team signs in (P35-10); left out for a runner with one sign-in for all its teams.
const teamPart = (team?: string): { team?: string } => (team !== undefined ? { team } : {});

export const fetchAgentAuth = (id: string, team?: string) =>
  call(getAgentAuthRoute, { request: GetAgentAuthQuery, response: GetAgentAuthResponse }, teamPart(team) as GetAgentAuthQuery, { id });

export const startAgentLogin = (id: string, methodId: string, team?: string) =>
  call(startAgentLoginRoute, { request: StartAgentLoginRequest, response: AgentLoginResponse }, { methodId, ...teamPart(team) }, { id });

export const answerAgentLogin = (id: string, body: AnswerAgentLoginRequest, team?: string) =>
  call(answerAgentLoginRoute, { request: AnswerAgentLoginRequest, response: AgentLoginResponse }, { ...body, ...teamPart(team) }, { id });

export const cancelAgentLogin = (id: string, attemptId?: string, team?: string) =>
  call(cancelAgentLoginRoute, { request: CancelAgentLoginRequest, response: AgentLoginResponse }, { ...(attemptId ? { attemptId } : {}), ...teamPart(team) }, { id });

export const agentLogout = (id: string, team?: string) =>
  call(agentLogoutRoute, { request: AgentLogoutRequest, response: AgentLogoutResponse }, teamPart(team) as AgentLogoutRequest, { id });

/** The teams of a runner where each team signs in, with each one's stored state (P35-10). */
export const fetchAgentAuthTeams = (id: string) => call(listAgentAuthTeamsRoute, { response: ListAgentAuthTeamsResponse }, undefined, { id });

/** One sign-in for all teams, or each team on its own. Switching signs every old sign-in out first. */
export const setSignInScope = (id: string, scope: BotRunnerSignInScope) =>
  call(setSignInScopeRoute, { request: SetSignInScopeRequest, response: SetSignInScopeResponse }, { scope }, { id });
