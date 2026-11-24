/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTunnel, type TunnelClient } from '../../../../tools/agent-bridge/src/tunnel.ts';
import { createWorld, personas, type World } from './world.ts';

// P35-10b (docs/plans/per-team-sign-in.md sections 4 and 7): who signs a server's Claude Code or Codex runner in. The site allows "each team signs in" only on a server whose bridge said
// it runs each team as a user of its own; the switch is the bridge's (`POST /v1/signin/scope` through the server's connection); the agent-auth routes name the team to the bridge; the
// team states are stored from the page's reads and from the refresh at connect. A stand-in bridge answers on the tunnel's socket and notes every request (tools/agent-bridge has
// the real one's tests).

const { omar } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let w: World;
let dir: string;
let agent: Server;
let client: TunnelClient | null = null;
const INTERNAL = 'internal-key-for-this-test-0123456789';
const seen: Array<{ method: string; url: string; body: any }> = [];
/** What the stand-in answers: each team's state, and whether the scope switch is refused. */
const stand = {
  teams: {} as Record<string, 'signed_in' | 'signed_out'>,
  shared: 'signed_in' as 'signed_in' | 'signed_out',
  refuseScope: false,
  /** How long the switch takes on the bridge. */
  delayMs: 0,
  /** A switch done in part: the bridge keeps the old choice and says which teams. */
  partial: null as null | { signedOutTeams: string[]; notCleaned: string[] },
  /** The server does not run the agent. */
  missing: false,
};

const authView = (agentName: string, state: string) => ({ auth: { agent: agentName, profile: 'claude-signin', home: 'dedicated', state, kind: state === 'signed_in' ? 'account' : null, canLogout: true, methods: [], attempt: null, note: null } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'server-scope-'));
  agent = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method ?? 'GET', url: `${url.pathname}${url.search}`, body: raw ? JSON.parse(raw) : null });
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const agentName = url.searchParams.get('agent') ?? 'claude-code';
      const team = url.searchParams.get('team');
      if (url.pathname === '/v1/signin/scope') {
        if (stand.missing) return json(404, { error: { message: "This server does not run Claude Code. Install it with the bridge installer's --update, or remove this runner.", code: 'agent_missing' } });
        if (stand.refuseScope) return json(502, { error: { message: 'Team engineering could not be signed out, so nothing was changed. Try again in a moment.', code: 'sign_out_failed' } });
        const asked = JSON.parse(raw).scope as string;
        const answer = (): void =>
          stand.partial !== null
            ? json(200, { scope: asked === 'shared' ? 'per_team' : 'shared', signedOut: stand.partial.signedOutTeams.length, signedOutTeams: stand.partial.signedOutTeams, notSignedOut: [], notCleaned: stand.partial.notCleaned })
            : json(200, { scope: asked, signedOut: 1, signedOutTeams: [], notSignedOut: [], notCleaned: [] });
        if (stand.delayMs > 0) setTimeout(answer, stand.delayMs);
        else answer();
        return;
      }
      if (url.pathname === '/v1/auth/status') return json(200, authView(agentName, team === null ? stand.shared : (stand.teams[team] ?? 'signed_out')));
      if (url.pathname === '/v1/auth/logout') {
        if (team !== null) stand.teams[team] = 'signed_out';
        return json(200, authView(agentName, 'signed_out'));
      }
      json(404, { error: { message: 'not found', code: 'not_found' } });
    });
  });
  await new Promise<void>((resolve) => agent.listen(join(dir, 'agent.sock'), resolve));
  w = await createWorld();
}, 120_000);

afterEach(async () => {
  await client?.close();
  client = null;
  seen.length = 0;
  stand.teams = {};
  stand.shared = 'signed_in';
  stand.refuseScope = false;
  stand.delayMs = 0;
  stand.partial = null;
  stand.missing = false;
});

afterAll(async () => {
  await w?.close();
  await new Promise<void>((resolve) => agent.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const HOST = { hostname: 'box-scope', system: 'Ubuntu 24.04', arch: 'x64' };
const AGENTS = [{ agent: 'claude-code' as const, version: '2.1.3' }];

/** A server enrolled and connected through the real tunnel, its Claude Code runner open to Engineering and Marketing. */
type Kept = { claude?: 'shared' | 'per_team' | 'unreadable' };
async function connect(name: string, teamUsers: boolean | undefined, kept?: Kept): Promise<{ runnerId: string; reconnect: (again?: Kept) => Promise<void> }> {
  let signInScope = kept;
  const made = await w.call<any>(omar, 'POST', '/api/admin/bot-servers', { name, label: `Box ${name}` });
  expect(made.status).toBe(201);
  const done = await w.call<any>(null, 'POST', '/api/bridge/enrol', { code: made.body.code, host: HOST, agents: AGENTS, bridgeVersion: '1.2.3', allowFullAccess: false, ...(teamUsers !== undefined ? { teamUsers } : {}) });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  const key = done.body.key as string;
  const dial = (): TunnelClient => startTunnel({
    siteUrl: w.server.url,
    key: () => key,
    socketPath: join(dir, 'agent.sock'),
    internalKey: INTERNAL,
    hello: () => ({ bridgeVersion: '1.2.3', host: HOST, agents: AGENTS, allowFullAccess: false, ...(teamUsers !== undefined ? { teamUsers } : {}), ...(signInScope !== undefined ? { signInScope } : {}) }),
    storeKey: async () => undefined,
    insecure: true,
    minBackoffMs: 100,
    maxBackoffMs: 200,
    log: () => undefined,
  });
  client = dial();
  await client.connected();
  const runner = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.bot_runners WHERE name = $1 AND agent = 'claude-code'", [`${name}-claude`])).rows[0]!);
  const teams = await w.call<any>(omar, 'PUT', `/api/admin/bot-runners/${runner.id}/teams`, { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] });
  expect(teams.status, JSON.stringify(teams.body)).toBeLessThan(300);
  return {
    runnerId: runner.id,
    reconnect: async (again?: Kept) => {
      if (again !== undefined) signInScope = again;
      await client?.close();
      client = dial();
      await client.connected();
    },
  };
}

/** Straight to per team, for the cases whose subject is not the switch (the switch route allows 10 a minute per person). */
const perTeam = (id: string) => w.system((tx) => tx.query(`UPDATE app.bot_runners SET sign_in_scope = 'per_team', status = 'waiting_for_sign_in' WHERE id = $1::uuid`, [id]));
const scope = (id: string, to: 'shared' | 'per_team') => w.call<any>(omar, 'PUT', `/api/admin/bot-runners/${id}/sign-in-scope`, { scope: to });
const row = async (id: string): Promise<any> => (await w.system((tx) => tx.query(`SELECT sign_in_scope, status FROM app.bot_runners WHERE id = $1::uuid`, [id]))).rows[0];
const stored = async (id: string): Promise<Record<string, string>> =>
  Object.fromEntries((await w.system((tx) => tx.query<{ team_id: string; state: string }>(`SELECT team_id, state FROM app.bot_runner_team_signins WHERE runner_id = $1::uuid`, [id]))).rows.map((r) => [r.team_id, r.state]));

describe('who signs a server runner in (P35-10b)', () => {
  // first: the switch route allows 10 a minute per person, and the cases below use most of them
  it('a server that does not run the agent says so in its own words, not "update the bridge"', async () => {
    const { runnerId } = await connect('scope-missing', true);
    stand.missing = true;
    const res = await scope(runnerId, 'per_team');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('This server does not run Claude Code');
    expect(res.body.error.message).not.toMatch(/Update the agent bridge/);
    expect((await row(runnerId)).sign_in_scope).toBe('shared');
  });
  it('a server whose bridge did not say it has team users keeps one sign-in: the switch is refused in plain words and the bridge is not asked', async () => {
    const { runnerId } = await connect('scope-solo', undefined);
    const team = await w.system(async (tx) => (await tx.query<{ team_users: boolean }>("SELECT team_users FROM app.bot_servers WHERE name = 'scope-solo'")).rows[0]!);
    expect(team.team_users).toBe(false);
    const res = await scope(runnerId, 'per_team');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/runs every team as one user/);
    expect(seen.filter((s) => s.url.startsWith('/v1/signin/scope'))).toEqual([]);
    expect((await row(runnerId)).sign_in_scope).toBe('shared');
  });

  it('with team users: the bridge switches; each team is signed in by name; the states are stored; dispatch follows them; back to one sign-in lists the teams', async () => {
    const { runnerId } = await connect('scope-teams', true);
    expect((await w.system(async (tx) => (await tx.query<{ team_users: boolean }>("SELECT team_users FROM app.bot_servers WHERE name = 'scope-teams'")).rows[0]!)).team_users).toBe(true);
    const sw = await scope(runnerId, 'per_team');
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    // on a server every team open to the runner may sign in, so both count (P35-10b review)
    expect(sw.body.runner).toMatchObject({ signInScope: 'per_team', teamsSignedIn: 0, teamsServed: 2 });
    expect(seen.find((s) => s.url.startsWith('/v1/signin/scope'))).toMatchObject({ method: 'POST', url: '/v1/signin/scope?agent=claude-code', body: { scope: 'per_team', teams: [] } });
    expect(await row(runnerId)).toMatchObject({ sign_in_scope: 'per_team', status: 'waiting_for_sign_in' });

    // a team is named; without one the page is told to choose
    expect((await w.call<any>(omar, 'GET', `/api/admin/bot-runners/${runnerId}/agent-auth`)).status).toBe(400);
    stand.teams['engineering'] = 'signed_in';
    const st = await w.call<any>(omar, 'GET', `/api/admin/bot-runners/${runnerId}/agent-auth?team=engineering`);
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    expect(seen.some((s) => s.url === '/v1/auth/status?agent=claude-code&team=engineering')).toBe(true);
    expect(await stored(runnerId)).toEqual({ [TEAM_IDS.Engineering]: 'signed_in' });
    expect((await row(runnerId)).status).toBe('ready');
    const list = await w.call<any>(omar, 'GET', `/api/admin/bot-runners/${runnerId}/agent-auth/teams`);
    expect(list.body.items.map((t: any) => [t.slug, t.state])).toEqual([['engineering', 'signed_in'], ['marketing', null]]);

    // a team's own sign-out goes to the bridge with the team, and is stored
    const out = await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${runnerId}/agent-auth/logout`, { team: 'engineering' });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(seen.some((s) => s.method === 'POST' && s.url === '/v1/auth/logout?agent=claude-code&team=engineering')).toBe(true);
    expect(await stored(runnerId)).toEqual({ [TEAM_IDS.Engineering]: 'signed_out' });
    expect((await row(runnerId)).status).toBe('waiting_for_sign_in');

    // back to one sign-in: the bridge is given the runner's teams to sign out, and the stored states go with the switch
    seen.length = 0;
    const back = await scope(runnerId, 'shared');
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // only the teams that may hold a sign-in here: Engineering has a stored state (and is the first); Marketing never signed in and has no bot here, so no user is made for it
    expect(seen.find((s) => s.url.startsWith('/v1/signin/scope'))?.body).toEqual({ scope: 'shared', teams: ['engineering'] });
    expect(await stored(runnerId)).toEqual({});
    expect((await row(runnerId)).sign_in_scope).toBe('shared');
    // a shared runner names no team
    expect((await w.call<any>(omar, 'GET', `/api/admin/bot-runners/${runnerId}/agent-auth?team=engineering`)).status).toBe(400);
  });

  it('a switch the bridge refuses changes nothing on the site, and says the bridge\'s plain sentence', async () => {
    const { runnerId } = await connect('scope-refused', true);
    stand.refuseScope = true;
    const res = await scope(runnerId, 'per_team');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.message).toContain('could not be signed out, so nothing was changed');
    expect((await row(runnerId)).sign_in_scope).toBe('shared');
  });

  it('at connect, a per-team runner\'s teams whose state is unknown or old are asked by name and stored; one seen lately is not asked (a refused one stays refused)', async () => {
    const { runnerId, reconnect } = await connect('scope-refresh', true);
    await perTeam(runnerId);
    // Marketing met a refused sign-in in a run; the refresh must not undo that
    await w.system((tx) => tx.query(`INSERT INTO app.bot_runner_team_signins (runner_id, team_id, state) VALUES ($1::uuid, $2::uuid, 'refused')`, [runnerId, TEAM_IDS.Marketing]));
    stand.teams['engineering'] = 'signed_in';
    stand.teams['marketing'] = 'signed_in';
    seen.length = 0;
    await reconnect();
    await vi.waitFor(async () => {
      if ((await stored(runnerId))[TEAM_IDS.Engineering] !== 'signed_in') throw new Error('not yet');
    }, { timeout: 15_000, interval: 50 });
    expect(seen.filter((s) => s.url.startsWith('/v1/auth/status')).map((s) => s.url)).toEqual(['/v1/auth/status?agent=claude-code&team=engineering']);
    expect(await stored(runnerId)).toEqual({ [TEAM_IDS.Engineering]: 'signed_in', [TEAM_IDS.Marketing]: 'refused' });
    expect((await row(runnerId)).status).toBe('ready');
  });

  it('no row lock is held while the bridge switches: the row stays free, a second switch meanwhile is refused, and the claim goes at the end', async () => {
    const { runnerId } = await connect('scope-claim', true);
    stand.delayMs = 1500;
    const first = scope(runnerId, 'per_team');
    await vi.waitFor(async () => {
      if (!seen.some((s) => s.url.startsWith('/v1/signin/scope'))) throw new Error('not yet');
    }, { timeout: 10_000, interval: 20 });
    // the runner's row can be locked by someone else at once: nothing holds it
    await w.system((tx) => tx.query('SELECT id FROM app.bot_runners WHERE id = $1::uuid FOR UPDATE NOWAIT', [runnerId]));
    const second = await scope(runnerId, 'per_team');
    expect(second.status).toBe(409);
    const done = await first;
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const after = (await w.system((tx) => tx.query<{ sign_in_scope: string; scope_switch_at: Date | null }>('SELECT sign_in_scope, scope_switch_at FROM app.bot_runners WHERE id = $1::uuid', [runnerId]))).rows[0]!;
    expect(after).toEqual({ sign_in_scope: 'per_team', scope_switch_at: null });
    const kept = (await w.system((tx) => tx.query<{ signin_scopes: any }>("SELECT signin_scopes FROM app.bot_servers WHERE name = 'scope-claim'"))).rows[0]!.signin_scopes;
    expect(kept).toMatchObject({ claude: 'per_team' });
  });

  it('a bridge that keeps another choice than the runner is shown on the runner and runs nothing; it is never flipped by the site; the same choice again clears it', async () => {
    const { runnerId, reconnect } = await connect('scope-drift', true, { claude: 'per_team' });
    await vi.waitFor(async () => {
      if ((await row(runnerId)).status !== 'needs_sign_in') throw new Error('not yet');
    }, { timeout: 10_000, interval: 50 });
    const detail = (await w.system((tx) => tx.query<{ status_detail: string }>('SELECT status_detail FROM app.bot_runners WHERE id = $1::uuid', [runnerId]))).rows[0]!.status_detail;
    expect(detail).toBe('The server keeps a sign-in for each team for Claude Code, but this runner says the other. Choose Who signs in on this runner again to set both.');
    expect((await row(runnerId)).sign_in_scope).toBe('shared');
    // an unreadable kept choice says so too
    await reconnect({ claude: 'unreadable' });
    await vi.waitFor(async () => {
      const d = (await w.system((tx) => tx.query<{ status_detail: string }>('SELECT status_detail FROM app.bot_runners WHERE id = $1::uuid', [runnerId]))).rows[0]!.status_detail;
      if (!d.startsWith('The server could not read')) throw new Error('not yet');
    }, { timeout: 10_000, interval: 50 });
    // the bridge agrees again: the runner waits for its sign-in check, as after any connect
    await reconnect({ claude: 'shared' });
    await vi.waitFor(async () => {
      if ((await row(runnerId)).status === 'needs_sign_in') throw new Error('not yet');
    }, { timeout: 10_000, interval: 50 });
    // an admin choosing the value the runner already has asks the bridge all the same
    seen.length = 0;
    expect((await scope(runnerId, 'shared')).status).toBe(200);
    expect(seen.some((s) => s.url.startsWith('/v1/signin/scope'))).toBe(true);
  });

  it('a switch the bridge did only in part changes no column, stores the teams it signed out, and says which teams were signed out and which were not cleaned', async () => {
    const { runnerId } = await connect('scope-partial', true);
    await perTeam(runnerId);
    await w.system((tx) => tx.query(`INSERT INTO app.bot_runner_team_signins (runner_id, team_id, state) VALUES ($1::uuid, $2::uuid, 'signed_in')`, [runnerId, TEAM_IDS.Engineering]));
    stand.partial = { signedOutTeams: ['engineering'], notCleaned: ['marketing'] };
    const res = await scope(runnerId, 'shared');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('The switch was not finished, so this runner still lets each team sign in. Signed out: engineering. The sign-in folder could not be removed for: marketing. Try again in a moment.');
    expect((await row(runnerId)).sign_in_scope).toBe('per_team');
    expect(await stored(runnerId)).toEqual({ [TEAM_IDS.Engineering]: 'signed_out' });
    const claim = (await w.system((tx) => tx.query<{ scope_switch_at: Date | null }>('SELECT scope_switch_at FROM app.bot_runners WHERE id = $1::uuid', [runnerId]))).rows[0]!;
    expect(claim.scope_switch_at).toBeNull();
  });

});
