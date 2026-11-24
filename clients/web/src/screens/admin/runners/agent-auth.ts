import { hasSignInScopeChoice, type AgentAuth, type AgentAuthAttempt, type AgentAuthMethod, type AgentAuthTeamState, type BotRunner, type BotRunnerSignInScope } from '@manythreads/shared';

/*
 * The words and rules of the agent sign-in on the Runners page (P25-09, docs/plans/acp.md section 4.1). Pure functions, so they are tested without a browser. The page
 * never shows an account e-mail (the server does not send one), and a code or an API key typed here goes up once and is cleared from the page the moment it is sent.
 */

/** A Claude Code or Codex runner in a pod (P26-09). Its agent is signed in inside the pod, from this page, unless a sign-in file was uploaded for it (the older way, kept for those runners). */
export const isPodAgent = (r: Pick<BotRunner, 'kind'>): boolean => r.kind === 'claude_cli' || r.kind === 'codex_cli';

/** A runner where each team signs in with an account of its own: a pod runner (P35-10) or a server runner (P35-10b). */
export const isPerTeam = (r: Pick<BotRunner, 'kind'> & { agent?: BotRunner['agent']; signInScope?: BotRunner['signInScope'] }): boolean =>
  hasSignInScopeChoice({ kind: r.kind, agent: r.agent ?? '' }) && r.signInScope === 'per_team';

/** Whether this runner signs in from this page: a gateway whose address answers as a Claude Code or Codex bridge, or a pod runner with no uploaded sign-in file */
export const hasAgentSignin = (r: Pick<BotRunner, 'kind' | 'agent'> & { uploadedAt?: BotRunner['uploadedAt'] }): boolean =>
  (r.kind === 'hermes_gateway' && (r.agent === 'claude-code' || r.agent === 'codex')) || (isPodAgent(r) && r.uploadedAt === null);

/** The agent a runner drives: a pod runner's kind says it, a bridge runner's agent field does. */
export const agentOf = (r: Pick<BotRunner, 'kind' | 'agent'>): 'claude-code' | 'codex' | null =>
  r.kind === 'claude_cli' ? 'claude-code' : r.kind === 'codex_cli' ? 'codex' : r.agent === 'claude-code' || r.agent === 'codex' ? r.agent : null;

export const AGENT_NAME: Record<'claude-code' | 'codex', string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** An attempt that is still running: the page asks again every few seconds until it ends. */
export const isLive = (a: AgentAuthAttempt | null): boolean => a !== null && (a.state === 'starting' || a.state === 'waiting' || a.state === 'checking');

/** An attempt that waits for the person to type or paste something here. */
export const needsAnswer = (a: AgentAuthAttempt | null): boolean => a !== null && (a.state === 'needs_input' || (a.state === 'waiting' && a.action?.type === 'paste_code'));

/** How long to wait before asking again: quick while something is being checked, slower while the person is on the other page. */
export const pollDelayMs = (a: AgentAuthAttempt | null): number => (a === null ? 0 : a.state === 'waiting' ? 3000 : 1500);

/** The status line at the top of the dialog. */
export function statusWords(auth: AgentAuth): string {
  const name = AGENT_NAME[auth.agent];
  switch (auth.state) {
    case 'signed_in':
      return auth.kind === 'gateway' ? `${name} uses the workspace's model gateway. No sign-in is needed.` : `${name} is signed in.`;
    case 'signed_out':
      return `${name} is not signed in.`;
    case 'not_needed':
      return `${name} does not need a sign-in here.`;
    default:
      return `The bridge did not say whether ${name} is signed in.`;
  }
}

/** The machine a runner's bridge runs on, as the address names it (host and port), for the sentences that say whose sign-in is meant. */
export function machineOf(baseUrl: string | null): string {
  if (!baseUrl) return 'the bridge machine';
  try {
    return new URL(baseUrl).host || 'the bridge machine';
  } catch {
    return 'the bridge machine';
  }
}

/** Whose sign-in this is: the folder the agent keeps it in is this profile's own, or the machine's shared one. Empty for an agent with no sign-in of its own. */
export function homeWords(auth: AgentAuth, runner: Pick<BotRunner, 'baseUrl'> & { kind?: BotRunner['kind'] }, team?: TeamRef): string {
  const name = AGENT_NAME[auth.agent];
  if (team) return `This sign-in belongs to team ${team.name} alone. It lives in that team's own pod, and no other team of this runner uses it.`;
  if (isPodAgent({ kind: runner.kind ?? 'hermes_gateway' })) return `This sign-in lives in the pod of ${name} for this runner only. Nothing else uses it, and it is deleted with the pod's state volume.`;
  if (auth.home === 'dedicated') return `This sign-in belongs to the bridge profile "${auth.profile}" alone. It has its own sign-in folder on ${machineOf(runner.baseUrl)}.`;
  if (auth.home === 'shared') return `This sign-in is the one every user of ${name} on ${machineOf(runner.baseUrl)} shares, including anyone who uses it from a terminal there.`;
  return '';
}

/** What signing out asks the person to confirm: the machine, and who else loses the sign-in when the folder is shared. */
export function logoutWords(auth: AgentAuth, runner: Pick<BotRunner, 'baseUrl'> & { kind?: BotRunner['kind'] }, team?: TeamRef): string {
  const name = AGENT_NAME[auth.agent];
  if (team) return `Sign team ${team.name} out of ${name}? Its bots on this runner stop until the team is signed in again. Other teams are not changed.`;
  if (isPodAgent({ kind: runner.kind ?? 'hermes_gateway' })) return `Sign ${name} out in its pod? Bots that use this runner stop until it is signed in again.`;
  const machine = machineOf(runner.baseUrl);
  if (auth.home === 'dedicated') return `Sign ${name} out on ${machine}? Only the bridge profile "${auth.profile}" uses this sign-in. Bots that use this runner stop until it is signed in again.`;
  return `Sign ${name} out on ${machine}? That signs out every user of ${name} on that machine, not only this runner, and bots that use it stop until it is signed in again.`;
}

/** What starting a new sign-in asks the person to confirm while one is already in place. */
export function replaceWords(auth: AgentAuth, runner: Pick<BotRunner, 'baseUrl'> & { kind?: BotRunner['kind'] }, team?: TeamRef): string {
  const name = AGENT_NAME[auth.agent];
  if (team) return `Team ${team.name} is already signed in to ${name}. A new sign-in replaces that account for this team only.`;
  if (isPodAgent({ kind: runner.kind ?? 'hermes_gateway' })) return `${name} is already signed in in its pod. A new sign-in replaces that account for every team that uses this runner.`;
  const machine = machineOf(runner.baseUrl);
  if (auth.home === 'dedicated') return `${name} is already signed in. A new sign-in replaces the account on ${machine} for the bridge profile "${auth.profile}".`;
  return `${name} is already signed in. A new sign-in replaces that account for every user of ${name} on ${machine}, not only this runner.`;
}

/** The label of one method's button: the agent's own name for it. */
export const methodLabel = (m: AgentAuthMethod): string => m.name;

/** What the person is asked to do for an attempt, in one sentence (the dialog shows the page and the code beside it). */
export function attemptWords(a: AgentAuthAttempt): string {
  if (a.message) return a.message;
  switch (a.state) {
    case 'starting':
      return 'Starting the sign-in.';
    case 'waiting':
      return a.action?.type === 'enter_code' ? 'Open the page, enter the code, then wait here.' : a.action?.type === 'paste_code' ? 'Open the page, sign in, then paste the code it shows below.' : 'Open the page and finish the sign-in. This page updates by itself.';
    case 'needs_input':
      return a.action?.type === 'give_key' ? 'Paste an API key below. It goes to the agent and is not kept here.' : 'The agent is waiting for you.';
    case 'checking':
      return 'Checking the sign-in.';
    case 'done':
      return 'Signed in.';
    case 'cancelled':
      return 'The sign-in was cancelled.';
    default:
      return 'The sign-in did not work.';
  }
}

/** What blocks the Send button, in a sentence, or null. The text itself is never put in a message. */
export function answerProblem(a: AgentAuthAttempt | null, text: string): string | null {
  if (!a || !needsAnswer(a)) return 'There is nothing to answer right now.';
  const t = text.trim();
  if (a.action?.type === 'give_key') return t.length < 8 ? 'An API key is at least 8 characters.' : t.length > 500 ? 'That is too long for an API key.' : null;
  if (t === '') return 'Paste the code first.';
  if (t.length > 2000) return 'That is too long for a code.';
  if (/[\r\n]/.test(t)) return 'The code is one line.';
  return null;
}

/** The body of an answer: a key or a code, by what the attempt asks for. */
export const answerBody = (a: AgentAuthAttempt, text: string): { attemptId: string; apiKey: string } | { attemptId: string; code: string } =>
  a.action?.type === 'give_key' ? { attemptId: a.id, apiKey: text.trim() } : { attemptId: a.id, code: text.trim() };

/** One sentence the page says after an action finishes (the polite status line of the Runners page). */
export const signedOutWords = (r: Pick<BotRunner, 'label'>, team?: TeamRef): string => (team ? `Team ${team.name} was signed out of ${r.label}.` : `${r.label} was signed out.`);
export const signedInDoneWords = (r: Pick<BotRunner, 'label'>, team?: TeamRef): string => (team ? `Team ${team.name} is signed in on ${r.label}.` : `${r.label} is signed in.`);

// ---- Each team signs in (P35-10, docs/plans/per-team-sign-in.md section 1) ----------------------------------------------------------------------------------------

/** The team a sign-in is for, on a runner where each team signs in. */
export type TeamRef = { slug: string; name: string };

export const SCOPE_LABEL: Record<BotRunnerSignInScope, string> = { shared: 'One sign-in for all teams', per_team: 'Each team signs in' };

/** What each choice means, under its label. */
export const SCOPE_HINT: Record<BotRunnerSignInScope, string> = {
  shared: 'Every team of this runner uses one account and shares its plan limits.',
  per_team: "Each team signs in with an account of its own. A team's bots work only once that team is signed in.",
};

/** The runner row's line about who signs in: "Each team signs in: 2 of 3 teams signed in". */
export function scopeLine(r: Pick<BotRunner, 'signInScope' | 'teamsSignedIn' | 'teamsServed'> & { kind?: BotRunner['kind'] }): string {
  if (r.signInScope !== 'per_team') return SCOPE_LABEL.shared;
  return `${SCOPE_LABEL.per_team}: ${teamsSignedInWords(r.teamsSignedIn ?? 0, r.teamsServed ?? 0, r.kind === 'server_agent')}`;
}

/** `onServer`: a server runner, where a team signs in without a pod of its own. */
export function teamsSignedInWords(signedIn: number, served: number, onServer = false): string {
  if (served === 0) return onServer ? 'no team may use it yet' : 'no team has a pod yet';
  return `${signedIn} of ${served} ${served === 1 ? 'team' : 'teams'} signed in`;
}

/** What switching does, said before it is done. Both ways stop the runs under way and clear the shell homes kept beside the sign-in. */
export function scopeSwitchWords(r: Pick<BotRunner, 'kind' | 'agent'>, to: BotRunnerSignInScope): string {
  const which = agentOf(r);
  const name = which === null ? 'the agent' : AGENT_NAME[which];
  if (r.kind === 'server_agent') {
    // a server (P35-10b): no pods; each team's own sign-in lives in a folder of the team's own user there
    const stop = `Runs of ${name} under way on that server are stopped.`;
    return to === 'per_team'
      ? `The one ${name} sign-in of this server is signed out and removed. Then every team must sign in with its own account before its bots work again. Each team's sign-in is kept in a folder only that team's user on the server can open; the bridge's own user and the server's administrator can still reach it. ${stop}`
      : `Every team's own ${name} sign-in on this server is signed out and removed. Then the server needs one sign-in, used by all teams of this runner, before any bot works again. ${stop}`;
  }
  const after = 'Every pod of this runner restarts: runs under way are stopped, and the shell homes and saved sessions next to the sign-in are cleared.';
  return to === 'per_team'
    ? `The one ${name} sign-in of this runner is signed out and removed, with any uploaded sign-in file. Then every team must sign in with its own account before its bots work again. ${after}`
    : `Every team's own ${name} sign-in on this runner is signed out and removed. Then the runner needs one sign-in, used by all its teams, before any bot works again. ${after}`;
}

/** What the server list says when its agent's runner lets each team sign in: the teams are signed in from the runner's own Sign-in (P35-10b). */
export const PER_TEAM_SERVER_SIGNIN = (label: string): string => `Each team signs in on its own on ${label}. Use Sign-in on that runner in the list above to choose the team.`;

/** A team's state in the list. */
export function teamStateWords(t: Pick<AgentAuthTeamState, 'served' | 'state'> & { pausedUntil?: string | null }, onServer = false): string {
  if (!t.served && !onServer) return 'No pod yet: place a bot of this team on the runner first';
  if (t.state === 'signed_in') return 'Signed in';
  if (t.state === 'signed_out') return 'Signed out';
  if (t.state === 'refused') return 'Sign-in refused or expired: sign this team in again';
  if (t.state === 'limited') return t.pausedUntil ? `Signed in; plan limit reached, runs wait until ${t.pausedUntil.slice(11, 16)} UTC` : 'Signed in; plan limit reached';
  return 'Not checked yet';
}

/** A team whose own sign-in works (at its plan limit it is still signed in). */
export const teamSignedIn = (t: Pick<AgentAuthTeamState, 'state'>): boolean => t.state === 'signed_in' || t.state === 'limited';

/** The list's button for a team: sign in while it is not, or sign out (and change the account) while it is. Null: nothing to do yet. */
export function teamAction(t: Pick<AgentAuthTeamState, 'served' | 'state'>, onServer = false): 'Sign in' | 'Sign out' | null {
  // on a server any team of the runner may sign in: it needs no pod of its own
  if (!t.served && !onServer) return null;
  return teamSignedIn(t) ? 'Sign out' : 'Sign in';
}
