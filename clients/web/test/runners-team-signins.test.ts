import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentAuthTeamState, BotRunner } from '@manythreads/shared';
import { setTransport, type TransportRequest } from '../src/api/client';
import { agentLogout, cancelAgentLogin, fetchAgentAuth, fetchAgentAuthTeams, setSignInScope, startAgentLogin } from '../src/screens/admin/runners/api';
import { isPerTeam, logoutWords, PER_TEAM_SERVER_SIGNIN, scopeLine, scopeSwitchWords, signedInDoneWords, teamAction, teamsSignedInWords, teamStateWords } from '../src/screens/admin/runners/agent-auth';
import { sharesSignin, warnsServerSignin } from '../src/screens/admin/runners/commands';
import { TeamSignInsView } from '../src/screens/admin/runners/TeamSignIns';

/*
 * Each team signs in (P35-10a, docs/plans/per-team-sign-in.md section 1): the runner row's "N of M teams signed in", the words of the switch, the list of a runner's teams with
 * their states and buttons, and the team that every sign-in call names.
 */

const RUNNER = '00000000-0000-7000-8000-0000000d0101';
const runner = (over: Partial<BotRunner> = {}): BotRunner =>
  ({ id: RUNNER, label: 'Team Codex', kind: 'codex_cli', agent: 'hermes', allTeams: false, teams: [], signInScope: 'per_team', teamsSignedIn: 2, teamsServed: 3, ...over }) as unknown as BotRunner;
const team = (slug: string, over: Partial<AgentAuthTeamState> = {}): AgentAuthTeamState =>
  ({ teamId: `00000000-0000-7000-8000-${slug.padEnd(12, '0').slice(0, 12).replace(/[^0-9a-f]/g, '0')}`, slug, name: slug[0]!.toUpperCase() + slug.slice(1), served: true, state: null, checkedAt: null, ...over }) as AgentAuthTeamState;

describe("the runner row's words", () => {
  it('says how many teams are signed in, for a runner where each team signs in', () => {
    expect(scopeLine(runner())).toBe('Each team signs in: 2 of 3 teams signed in');
    expect(scopeLine(runner({ teamsSignedIn: 1, teamsServed: 1 }))).toBe('Each team signs in: 1 of 1 team signed in');
    expect(scopeLine(runner({ teamsSignedIn: 0, teamsServed: 0 }))).toBe('Each team signs in: no team has a pod yet');
    expect(scopeLine(runner({ signInScope: 'shared', teamsSignedIn: null, teamsServed: null }))).toBe('One sign-in for all teams');
    expect(teamsSignedInWords(0, 2)).toBe('0 of 2 teams signed in');
  });

  it('shows the "teams share its sign-in" note and warning only for a shared runner with more than one team', () => {
    const many = { allTeams: true, teams: [] };
    expect(sharesSignin(runner({ ...many, signInScope: 'shared' }))).toBe(true);
    expect(sharesSignin(runner({ ...many, signInScope: 'per_team' }))).toBe(false);
    expect(warnsServerSignin(runner({ ...many, signInScope: 'shared' }))).toBe(true);
    expect(warnsServerSignin(runner({ ...many, signInScope: 'per_team' }))).toBe(false);
  });

  it('per team is a pod runner choice only', () => {
    expect(isPerTeam(runner())).toBe(true);
    expect(isPerTeam(runner({ signInScope: 'shared' }))).toBe(false);
    expect(isPerTeam(runner({ kind: 'hermes_gateway' }))).toBe(false);
  });
});

describe('the switch says what happens before it is done', () => {
  it('to each team: the one sign-in is signed out and removed, every team must sign in, runs stop, shell homes are cleared', () => {
    const words = scopeSwitchWords(runner({ signInScope: 'shared' }), 'per_team');
    expect(words).toContain('The one Codex sign-in of this runner is signed out and removed');
    expect(words).toContain('every team must sign in with its own account');
    expect(words).toContain('runs under way are stopped');
    expect(words).toContain('shell homes');
  });

  it("to one for all: every team's own sign-in is signed out and removed, and the runner needs one sign-in", () => {
    const words = scopeSwitchWords(runner({ kind: 'claude_cli' }), 'shared');
    expect(words).toContain("Every team's own Claude Code sign-in on this runner is signed out and removed");
    expect(words).toContain('needs one sign-in');
    expect(words).toContain('runs under way are stopped');
  });
});

describe("the list of a runner's teams", () => {
  const view = (items: AgentAuthTeamState[] | null, error: string | null = null): string =>
    renderToStaticMarkup(createElement(TeamSignInsView, { runner: runner(), items, error, onTeam: () => undefined, onScope: () => undefined }));

  it('gives each team its state and the right button, and counts the served teams', () => {
    const html = view([team('engineering', { state: 'signed_in' }), team('marketing', { state: 'signed_out' }), team('support', { served: false }), team('design', { state: 'limited' })]);
    // a team at its plan limit is still signed in
    expect(html).toContain('2 of 3 teams signed in');
    expect(html).toMatch(/data-team="engineering" data-state="signed_in"/);
    expect(html).toMatch(/data-team="marketing" data-state="signed_out"/);
    expect(html).toMatch(/data-team="support" data-state="no_pod"/);
    expect(html).toContain('aria-label="Sign out: team Engineering"');
    expect(html).toContain('aria-label="Sign in: team Marketing"');
    expect(html).not.toContain('team Support"');
    expect(html).toContain('No pod yet: place a bot of this team on the runner first');
  });

  it('says so when no team may use the runner, and shows an error in words', () => {
    expect(view([])).toContain('No team may use this runner yet');
    expect(view(null, 'The cluster did not answer.')).toContain('The cluster did not answer.');
  });

  it('words a team state and its action', () => {
    expect(teamStateWords({ served: true, state: null })).toBe('Not checked yet');
    expect(teamAction({ served: true, state: null })).toBe('Sign in');
    expect(teamAction({ served: false, state: 'signed_in' })).toBeNull();
    expect(teamStateWords({ served: true, state: 'refused' })).toBe('Sign-in refused or expired: sign this team in again');
    expect(teamAction({ served: true, state: 'refused' })).toBe('Sign in');
    expect(teamStateWords({ served: true, state: 'limited', pausedUntil: '2026-11-24T17:30:00.000Z' })).toBe('Signed in; plan limit reached, runs wait until 17:30 UTC');
    expect(teamAction({ served: true, state: 'limited' })).toBe('Sign out');
  });

  it("names the team in a team's sign-in words", () => {
    const t = { slug: 'marketing', name: 'Marketing' };
    expect(signedInDoneWords(runner(), t)).toBe('Team Marketing is signed in on Team Codex.');
    expect(logoutWords({ agent: 'codex' } as never, { baseUrl: null, kind: 'codex_cli' }, t)).toBe('Sign team Marketing out of Codex? Its bots on this runner stop until the team is signed in again. Other teams are not changed.');
  });
});

describe('the calls name the team', () => {
  let seen: TransportRequest[] = [];
  beforeEach(() => {
    seen = [];
    setTransport(async (req) => {
      seen.push(req);
      return { status: 418, body: { error: { code: 'internal', message: 'stop' } } };
    });
  });
  const send = async (run: () => Promise<unknown>): Promise<TransportRequest> => {
    await run().catch(() => undefined);
    const req = seen.at(-1);
    if (!req) throw new Error('no request was sent');
    return req;
  };

  it('in the query of a read, in the body of the others, and not at all for a shared runner', async () => {
    expect(await send(() => fetchAgentAuth(RUNNER, 'marketing'))).toMatchObject({ method: 'GET', url: `/api/admin/bot-runners/${RUNNER}/agent-auth?team=marketing` });
    expect(await send(() => fetchAgentAuth(RUNNER))).toMatchObject({ method: 'GET', url: `/api/admin/bot-runners/${RUNNER}/agent-auth` });
    expect(JSON.parse(String((await send(() => startAgentLogin(RUNNER, 'm', 'marketing'))).body))).toEqual({ methodId: 'm', team: 'marketing' });
    expect(JSON.parse(String((await send(() => cancelAgentLogin(RUNNER, 'a1', 'marketing'))).body))).toEqual({ attemptId: 'a1', team: 'marketing' });
    expect(JSON.parse(String((await send(() => agentLogout(RUNNER, 'marketing'))).body))).toEqual({ team: 'marketing' });
    expect(await send(() => fetchAgentAuthTeams(RUNNER))).toMatchObject({ method: 'GET', url: `/api/admin/bot-runners/${RUNNER}/agent-auth/teams` });
    const put = await send(() => setSignInScope(RUNNER, 'per_team'));
    expect(put).toMatchObject({ method: 'PUT', url: `/api/admin/bot-runners/${RUNNER}/sign-in-scope` });
    expect(JSON.parse(String(put.body))).toEqual({ scope: 'per_team' });
  });
});

describe('a server runner where each team signs in (P35-10b)', () => {
  const server = (over: Partial<BotRunner> = {}): BotRunner => runner({ kind: 'server_agent', agent: 'claude-code', label: 'Box Claude', ...over });

  it('is a per-team runner for Claude Code or Codex only, and its row says so in server words', () => {
    expect(isPerTeam(server())).toBe(true);
    expect(isPerTeam(server({ agent: 'codex' }))).toBe(true);
    expect(isPerTeam(server({ agent: 'hermes-acp' }))).toBe(false);
    expect(isPerTeam(server({ signInScope: 'shared' }))).toBe(false);
    expect(scopeLine(server({ teamsSignedIn: 0, teamsServed: 0 }))).toBe('Each team signs in: no team may use it yet');
    expect(teamsSignedInWords(0, 0)).toBe('no team has a pod yet');
  });

  it('the switch names the server, says runs stop, and says plainly who can still reach a team\'s sign-in; no pod words', () => {
    const to = scopeSwitchWords(server(), 'per_team');
    expect(to).toContain('The one Claude Code sign-in of this server is signed out and removed');
    expect(to).toContain("only that team's user on the server can open");
    expect(to).toContain("the bridge's own user and the server's administrator can still reach it");
    expect(to).toContain('Runs of Claude Code under way on that server are stopped.');
    expect(to).not.toContain('pod');
    const back = scopeSwitchWords(server({ agent: 'codex' }), 'shared');
    expect(back).toContain("Every team's own Codex sign-in on this server is signed out and removed");
    expect(back).not.toContain('pod');
  });

  it('any team of the runner may sign in on a server: no pod is needed, so an unserved team has a button and no pod words', () => {
    const t = team('marketing', { served: false, state: null });
    expect(teamAction(t)).toBeNull();
    expect(teamAction(t, true)).toBe('Sign in');
    expect(teamStateWords(t, true)).toBe('Not checked yet');
    expect(teamAction(team('marketing', { served: false, state: 'signed_in' }), true)).toBe('Sign out');
    const html = renderToStaticMarkup(createElement(TeamSignInsView, { runner: server(), items: [team('engineering', { state: 'signed_in' }), t], error: null, onTeam: () => undefined, onScope: () => undefined }));
    expect(html).not.toContain('No pod yet');
    expect(html).not.toContain('data-state="no_pod"');
    expect((html.match(/data-testid="runner-team-signin-open"/g) ?? []).length).toBe(2);
    // every team of a server runner counts, served or not
    expect(html).toContain('1 of 2 teams signed in');
  });

  it('the server list points to the runner\'s own Sign-in, which chooses the team', () => {
    expect(PER_TEAM_SERVER_SIGNIN('Box Claude')).toBe('Each team signs in on its own on Box Claude. Use Sign-in on that runner in the list above to choose the team.');
  });
});
