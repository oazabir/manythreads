import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityBroker, CapabilityRegistry, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import type { PluginRuns } from '@manythreads/sdk';
import { signOutRoute, type TerminalRecording, type TerminalServerFrame, type TerminalSession } from '@manythreads/shared';
import { PERSONA_PASSWORD, createApiClient, relaxedRateLimiter, type ApiClient } from '@manythreads/test-utils';
import type pg from 'pg';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type Persona, type World } from '../../channels/test/world.ts';

// P7-09 (server): the terminal into a bot's sandbox through the real server, a real database and a real shell in the real jail. The tests are hostile on purpose: each limit, each refusal and
// each record is checked from the outside, the way a person (or someone who is not allowed) would meet it. They need Linux, Python 3 and the root user (the jail uses namespaces); the shell
// tests are skipped where those are missing, and the tests of the refusals run everywhere.

const { omar, nadia, lena, rafi } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const canShell = typeof process.getuid === 'function' && process.getuid() === 0 && spawnSync('python3', ['-c', 'import pty, ctypes']).status === 0;
const base = '/api/teams/engineering/bots/termbot/workshop/terminal';

let world: World;
let root: string;
let teamId: string;
let botId: string;
let ada: Persona;
let zed: Persona;
let appPool: pg.Pool;
let systemPool: pg.Pool;
let runs: PluginRuns;
const saved: Record<string, string | undefined> = {};

const ENV = ['MANYTHREADS_TERMINAL_ENABLED', 'MANYTHREADS_TERMINAL_ROOT', 'MANYTHREADS_TERMINAL_IDLE_SECONDS', 'MANYTHREADS_TERMINAL_MAX_SECONDS', 'MANYTHREADS_TERMINAL_OUTPUT_BYTES_TOTAL', 'MANYTHREADS_TERMINAL_WAITING_SECONDS'];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const dev = (who: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) });

async function api<T = Record<string, unknown>>(who: Persona | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${world.server.url}${path}`, {
    method,
    headers: { ...(who ? dev(who) : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const open = (who: Persona, runId?: string) => api<{ session: TerminalSession }>(who, 'POST', base, runId ? { runId } : {});
const end = (who: Persona, id: string) => api<{ session: TerminalSession }>(who, 'POST', `${base}/${id}/end`, {});
const recording = (who: Persona, id: string) => api<{ session: TerminalRecording }>(who, 'GET', `${base}/${id}`);

/** A plain HTTP upgrade request: what status the server answers with BEFORE any socket exists. */
function upgrade(path: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(world.server.url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      path,
      agent: false,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.from(randomUUID()).toString('base64').slice(0, 24), ...headers },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 101);
    });
    req.on('error', reject);
    req.end();
  });
}

/** One browser-like client of the terminal's socket. */
class Term {
  readonly ws: WebSocket;
  readonly frames: TerminalServerFrame[] = [];
  text = '';
  readonly closed: Promise<number>;
  constructor(id: string, headers: Record<string, string>, origin: string | null = world.server.url) {
    this.ws = new WebSocket(`${world.server.url.replace(/^http/, 'ws')}${base}/${id}/socket`, { headers: { ...headers, ...(origin ? { origin } : {}) } });
    this.closed = new Promise<number>((resolve) => this.ws.on('close', (code: number) => resolve(code)));
    this.ws.on('error', () => undefined);
    this.ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString('utf8')) as TerminalServerFrame;
      this.frames.push(frame);
      if (frame.t === 'out') this.text += frame.d;
    });
  }
  type(d: string): void {
    this.ws.send(JSON.stringify({ t: 'in', d }));
  }
  async until(what: string, check: () => boolean, ms = 15_000): Promise<void> {
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      if (check()) return;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${what}; so far: ${JSON.stringify(this.text.slice(-300))}`);
  }
  async sees(re: RegExp, ms = 15_000): Promise<void> {
    // eslint-disable-next-line no-control-regex
    await this.until(String(re), () => re.test(this.text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')), ms);
  }
  get ended(): Extract<TerminalServerFrame, { t: 'end' }> | undefined {
    return this.frames.find((f): f is Extract<TerminalServerFrame, { t: 'end' }> => f.t === 'end');
  }
}

/** Opens a terminal, connects it and waits for the shell. */
async function started(who: Persona = omar): Promise<{ id: string; term: Term; session: TerminalSession }> {
  const opened = await open(who);
  expect(opened.status, JSON.stringify(opened.body) + world.server.logs.filter((l) => l.includes('"level":50')).slice(-2).join('')).toBe(201);
  const id = opened.body.session.id;
  const term = new Term(id, dev(who));
  await term.until('ready', () => term.frames.some((f) => f.t === 'ready'));
  await term.sees(/sandbox:.*\$/);
  return { id, term, session: opened.body.session };
}

const row = (id: string) =>
  world.system(async (tx) => (await tx.query<{ status: string; end_reason: string | null; bytes_in: string; bytes_out: string; transcript: string; run_id: string | null; credentials_revoked: number; started_at: Date | null; ended_at: Date | null }>('SELECT status, end_reason, bytes_in, bytes_out, transcript, run_id, credentials_revoked, started_at, ended_at FROM app.terminal_sessions WHERE id = $1', [id])).rows[0]);
const shellsOf = (id: string): number => spawnSync('pgrep', ['-f', id]).stdout.toString().trim().split('\n').filter(Boolean).length;
async function shellGone(id: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (shellsOf(id) === 0) return;
    await sleep(50);
  }
  throw new Error(`a process of terminal ${id} is still running`);
}
async function finished(id: string, ms = 10_000): Promise<NonNullable<Awaited<ReturnType<typeof row>>>> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const r = await row(id);
    if (r?.status === 'ended') return r;
    await sleep(50);
  }
  throw new Error(`terminal ${id} did not end`);
}
const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>): Promise<void> => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};
async function endAnythingOpen(): Promise<void> {
  const open = await world.system(async (tx) => (await tx.query<{ id: string; status: string }>("SELECT id, status FROM app.terminal_sessions WHERE status IN ('waiting', 'open')")).rows);
  for (const r of open) await end(omar, r.id);
  for (const r of open) await shellGone(r.id);
}

const count = (): Promise<number> => world.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.terminal_sessions')).rows[0]!.n);

async function person(workspaceId: string, name: string, role: 'owner' | 'admin' | 'member'): Promise<Persona> {
  const personId = randomUUID();
  const actorId = randomUUID();
  await world.system(async (tx) => {
    await tx.query('INSERT INTO app.people (id, workspace_id, display_name, primary_email) VALUES ($1, $2, $3, $4)', [personId, workspaceId, name, `${name.toLowerCase()}@term.example`]);
    await tx.query("INSERT INTO app.actors (id, kind, workspace_id, ref_id) VALUES ($1, 'person', $2, $3)", [actorId, workspaceId, personId]);
    await tx.query('INSERT INTO app.workspace_members (workspace_id, person_id, role) VALUES ($1, $2, $3)', [workspaceId, personId, role]);
  });
  return { ...omar, key: name.toLowerCase() as never, name, personId: personId as never, actorId: actorId as never, workspaceId: workspaceId as never, workspaceRoles: [role], teams: [], email: `${name.toLowerCase()}@term.example` };
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  root = await mkdtemp(join(tmpdir(), 'mt-term-root-'));
  process.env['MANYTHREADS_TERMINAL_ENABLED'] = '1';
  process.env['MANYTHREADS_TERMINAL_ROOT'] = root;
  for (const k of ENV.slice(2)) delete process.env[k];
  world = await createWorld({ limiter: relaxedRateLimiter() });
  await ensureChannels(world);
  teamId = await world.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);
  botId = await world.system(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, 'termbot', 'agent', 'rules', 'team', repeat('e', 64), 'active') RETURNING id`,
      [omar.workspaceId, teamId],
    );
    const bot = r.rows[0]!.id;
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, bot]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [teamId, actor.rows[0]!.id, omar.workspaceId]);
    return bot;
  });
  ada = await person(omar.workspaceId, 'Ada', 'admin');
  const other = await world.system(async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.workspaces (slug, name) VALUES ('other-co', 'Other Co') RETURNING id")).rows[0]!.id);
  zed = await person(other, 'Zed', 'owner');
  appPool = createAppPool(world.server.db.appUrl);
  systemPool = createSystemPool(world.server.db.systemUrl, 2);
  const registry = new CapabilityRegistry();
  runs = createRunService({ pool: appPool, systemPool, registry, broker: new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) }), handlers: new Map() });
});

afterAll(async () => {
  await endAnythingOpen().catch(() => undefined);
  await appPool?.end();
  await systemPool?.end();
  await world?.close();
  await rm(root, { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// a failed test must not leave a terminal open for the next one
afterEach(async () => {
  await endAnythingOpen();
});

describe('who may use the terminal', () => {
  it('answers 403 to every route for a person who is not an admin, and 401 to nobody', async () => {
    for (const who of [nadia, rafi, lena]) {
      expect((await api(who, 'GET', base)).status, who.key).toBe(403);
      expect((await api(who, 'POST', base, {})).status, who.key).toBe(403);
      expect((await api(who, 'GET', `${base}/${randomUUID()}`)).status, who.key).toBe(403);
      expect((await api(who, 'POST', `${base}/${randomUUID()}/end`, {})).status, who.key).toBe(403);
      // the route that upgrades is refused on the upgrade request itself: no socket is ever opened
      expect(await upgrade(`${base}/${randomUUID()}/socket`, dev(who)), who.key).toBe(403);
    }
    expect((await api(null, 'GET', base)).status).toBe(401);
    expect(await upgrade(`${base}/${randomUUID()}/socket`, {})).toBe(401);
    // and nothing was recorded for any of it
    expect(await world.system(async (tx) => (await tx.query('SELECT 1 FROM app.terminal_sessions')).rows.length)).toBe(0);
  });

  it('a non-admin who is a lead of the team is still refused', async () => {
    // Omar leads Engineering AND is an admin; make the point with a team lead who is only a member of the workspace
    await world.system((tx) => tx.query("UPDATE app.team_members SET role = 'lead' WHERE team_id = $1 AND actor_id = $2", [teamId, nadia.actorId]));
    expect((await api(nadia, 'POST', base, {})).status).toBe(403);
    expect(await upgrade(`${base}/${randomUUID()}/socket`, dev(nadia))).toBe(403);
    await world.system((tx) => tx.query("UPDATE app.team_members SET role = 'member' WHERE team_id = $1 AND actor_id = $2", [teamId, nadia.actorId]));
  });

  it('refuses a socket upgrade from a page of another origin, even for an admin, on any machine', async () => {
    // the Origin check runs before everything else, so a terminal id that does not exist is enough: this part never depends on the machine being able to run a shell
    const nowhere = randomUUID();
    for (const origin of ['https://evil.example', `${world.server.url}.evil.example`, 'null', 'http://localhost:1']) {
      expect(await upgrade(`${base}/${nowhere}/socket`, { ...dev(omar), origin }), origin).toBe(403);
    }
    // the same request from the platform's own origin is NOT refused for its origin: it reaches the next check and finds no such terminal
    expect(await upgrade(`${base}/${nowhere}/socket`, { ...dev(omar), origin: world.server.url })).toBe(404);
  });

  it.runIf(canShell)('a refused cross-origin upgrade leaves a real, waiting terminal unclaimed', async () => {
    const opened = await open(omar);
    expect(opened.status).toBe(201);
    const id = opened.body.session.id;
    expect(await upgrade(`${base}/${id}/socket`, { ...dev(omar), origin: 'https://evil.example' })).toBe(403);
    expect(await upgrade(`${base}/${id}/socket`, { ...dev(omar), origin: `${world.server.url}.evil.example` })).toBe(403);
    expect((await row(id))?.status).toBe('waiting');
    await end(omar, id);
  });

  it('shows another workspace nothing: its admin cannot read, end or connect a terminal of ours (also on a machine that cannot run one)', async () => {
    // a row of ours, made directly: the test does not depend on the machine being able to start a shell
    const seed = await runs.open({ botId, teamId, workspaceId: omar.workspaceId, trigger: 'conversation', askerActorId: omar.actorId, rehearsal: true });
    await runs.close(seed.run.runId, 'stopped');
    const ours = await world.system(async (tx) => {
      const t = await tx.query<{ id: string }>(
        "INSERT INTO app.terminal_sessions (workspace_id, team_id, bot_id, bot_slug, admin_id, run_id, credentials_revoked) VALUES ($1, $2, $3, 'termbot', $4, $5, 1) RETURNING id",
        [omar.workspaceId, teamId, botId, omar.actorId, seed.run.runId],
      );
      return t.rows[0]!.id;
    });
    try {
      for (const id of [ours, randomUUID()]) {
        // zed is an owner of ANOTHER workspace: the team and the bot do not exist for him, so every route answers "no such" (404), never "yes, but not you"
        for (const [method, path, body] of [
          ['GET', base, undefined],
          ['POST', base, {}],
          ['GET', `${base}/${id}`, undefined],
          ['POST', `${base}/${id}/end`, {}],
        ] as const) {
          const res = await api(zed, method, path, body);
          expect(res.status, `${method} ${path}`).toBe(404);
        }
        expect(await upgrade(`${base}/${id}/socket`, dev(zed))).toBe(404);
      }
      expect((await row(ours))?.status).toBe('waiting');
      // his own workspace's list shows nothing of ours either
      expect(await world.system(async (tx) => (await tx.query("SELECT 1 FROM app.terminal_sessions WHERE workspace_id = $1", [zed.workspaceId])).rows.length)).toBe(0);
    } finally {
      await world.system((tx) => tx.query('DELETE FROM app.terminal_sessions WHERE id = $1', [ours]));
    }
  });

  it('the database ties a terminal to a rehearsal run of its own bot, whoever writes the row', async () => {
    const make = async (kind: 'real' | 'rehearsal' | 'other-bot'): Promise<string> => {
      let bot = botId;
      if (kind === 'other-bot') {
        bot = await world.system(async (tx) => {
          const b = await tx.query<{ id: string }>(
            `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('d', 64), 'active') RETURNING id`,
            [omar.workspaceId, teamId, `other-${randomUUID().slice(0, 8)}`],
          );
          const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, b.rows[0]!.id]);
          await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [teamId, actor.rows[0]!.id, omar.workspaceId]);
          return b.rows[0]!.id;
        });
      }
      const r = await runs.open({ botId: bot, teamId, workspaceId: omar.workspaceId, trigger: kind === 'real' ? 'mention' : 'conversation', askerActorId: omar.actorId, rehearsal: kind !== 'real' });
      await runs.close(r.run.runId, 'stopped');
      return r.run.runId;
    };
    const tie = (runId: string): Promise<unknown> =>
      world.system((tx) =>
        tx.query("INSERT INTO app.terminal_sessions (workspace_id, team_id, bot_id, bot_slug, admin_id, run_id, status, end_reason, ended_at) VALUES ($1, $2, $3, 'termbot', $4, $5, 'ended', 'closed', now()) RETURNING id", [omar.workspaceId, teamId, botId, omar.actorId, runId]),
      );
    await expect(tie(await make('real'))).rejects.toMatchObject({ code: '23514' });
    await expect(tie(await make('other-bot'))).rejects.toMatchObject({ code: '23514' });
    await expect(tie(randomUUID())).rejects.toBeTruthy();
    await expect(tie(await make('rehearsal'))).resolves.toBeTruthy();
    // and the tie cannot be changed afterwards to a real run
    const id = (await world.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.terminal_sessions WHERE bot_id = $1 ORDER BY created_at DESC LIMIT 1", [botId])).rows[0]!.id));
    await expect(world.system((tx) => tx.query('UPDATE app.terminal_sessions SET run_id = $2 WHERE id = $1', [id, 'x']))).rejects.toBeTruthy();
    const real = await make('real');
    await expect(world.system((tx) => tx.query('UPDATE app.terminal_sessions SET run_id = $2 WHERE id = $1', [id, real]))).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps an admin\'s recording when the bot or the team is deleted (the bot\'s name stays on the row)', async () => {
    const { botKept, teamKept } = await world.system(async (tx) => {
      const slug = `gone-${randomUUID().slice(0, 8)}`;
      const t = await tx.query<{ id: string }>("INSERT INTO app.teams (workspace_id, slug, name) VALUES ($1, $2, 'Gone team') RETURNING id", [omar.workspaceId, slug]);
      const b = await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('c', 64), 'active') RETURNING id`,
        [omar.workspaceId, t.rows[0]!.id, slug],
      );
      const rec = await tx.query<{ id: string }>(
        "INSERT INTO app.terminal_sessions (workspace_id, team_id, bot_id, bot_slug, admin_id, status, end_reason, ended_at, transcript) VALUES ($1, $2, $3, $4, $5, 'ended', 'closed', now(), 'kept\n') RETURNING id",
        [omar.workspaceId, t.rows[0]!.id, b.rows[0]!.id, slug, omar.actorId],
      );
      await tx.query('DELETE FROM app.bots WHERE id = $1', [b.rows[0]!.id]);
      await tx.query('DELETE FROM app.teams WHERE id = $1', [t.rows[0]!.id]);
      return { botKept: rec.rows[0]!.id, teamKept: slug };
    });
    const after = await world.system(async (tx) => (await tx.query<{ bot_id: string | null; team_id: string | null; bot_slug: string; transcript: string }>('SELECT bot_id, team_id, bot_slug, transcript FROM app.terminal_sessions WHERE id = $1', [botKept])).rows[0]);
    expect(after).toEqual({ bot_id: null, team_id: null, bot_slug: teamKept, transcript: 'kept\n' });
    await world.system((tx) => tx.query('DELETE FROM app.terminal_sessions WHERE id = $1', [botKept]));
  });
});

describe('what the terminal is for', () => {
  it('refuses a real run of the bot (any trigger but a rehearsal), by name, and leaves the run untouched', async () => {
    const before = await count();
    const real = await runs.open({ botId, teamId, workspaceId: omar.workspaceId, trigger: 'conversation', askerActorId: nadia.actorId });
    const mention = await runs.open({ botId, teamId, workspaceId: omar.workspaceId, trigger: 'mention', askerActorId: nadia.actorId });
    const hook = await runs.open({ botId, teamId, workspaceId: omar.workspaceId, trigger: 'webhook' });
    for (const r of [real, mention, hook]) {
      const res = await open(omar, r.run.runId);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(JSON.stringify(res.body)).toMatch(/real run|no such test run/i);
      // untouched: still running, token still good
      expect(await runs.resolve(tokenHash(r.token))).not.toBeNull();
    }
    // nothing was recorded: a refused terminal is not a terminal
    expect(await count()).toBe(before);
    for (const r of [real, mention, hook]) await runs.close(r.run.runId, 'stopped');
  });

  it('refuses a real run with a 403 even when the terminal is switched off (the refusal does not depend on the machine)', async () => {
    const real = await runs.open({ botId, teamId, workspaceId: omar.workspaceId, trigger: 'conversation', askerActorId: nadia.actorId });
    const hook = await runs.open({ botId, teamId, workspaceId: omar.workspaceId, trigger: 'webhook' });
    await withEnv({ MANYTHREADS_TERMINAL_ENABLED: '0' }, async () => {
      for (const r of [real, hook]) {
        const res = await open(omar, r.run.runId);
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(await runs.resolve(tokenHash(r.token))).not.toBeNull();
      }
      // a run id that is nobody's: also a 403, and a plain terminal request is the 409 "switched off"
      expect((await open(omar, randomUUID())).status).toBe(403);
      expect((await open(omar)).status).toBe(409);
    });
    for (const r of [real, hook]) await runs.close(r.run.runId, 'stopped');
  });

  it('refuses a run id that belongs to nothing', async () => {
    const res = await open(omar, randomUUID());
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/no such test run/i);
  });

  it('says in plain words when the terminal is switched off, and opens nothing', async () => {
    const before = await count();
    await withEnv({ MANYTHREADS_TERMINAL_ENABLED: '0' }, async () => {
      const status = await api<{ available: boolean; reason: string }>(omar, 'GET', base);
      expect(status.status).toBe(200);
      expect(status.body.available).toBe(false);
      expect(status.body.reason).toMatch(/switched off/);
      const res = await open(omar);
      expect(res.status).toBe(409);
      expect(await count()).toBe(before);
    });
  });
});

describe.runIf(canShell)('a terminal, end to end', () => {
  it('opens with its credentials already revoked, runs a shell as nobody in an empty folder, and records the session', async () => {
    const status = await api<{ available: boolean; limits: { idleSeconds: number } }>(omar, 'GET', base);
    expect(status.body.available).toBe(true);
    expect(status.body.limits.idleSeconds).toBe(300);

    const since = new Date(Date.now() - 1000);
    const { id, term, session } = await started();
    expect(session.status).toBe('waiting');
    expect(session.sandbox.kind).toBe('rehearsal');
    expect(session.credentialsRevoked).toBeGreaterThan(0);
    const ready = term.frames.find((f) => f.t === 'ready');
    expect(ready).toMatchObject({ t: 'ready', credentialsRevoked: session.credentialsRevoked });

    // the credentials of the sandbox run: revoked when the terminal opened, the run is over, and its endpoint refuses a made-up token
    const runId = (await row(id))!.run_id!;
    const tokens = await world.system(async (tx) => (await tx.query<{ revoked: boolean }>('SELECT revoked_at IS NOT NULL AS revoked FROM app.mcp_run_tokens WHERE run_id = $1', [runId])).rows);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((t) => t.revoked)).toBe(true);
    const run = await world.system(async (tx) => (await tx.query<{ status: string; rehearsal: boolean }>('SELECT status, rehearsal FROM app.bot_runs WHERE id = $1', [runId])).rows[0]!);
    expect(run.rehearsal).toBe(true);
    expect(run.status).not.toBe('running');
    const endpoint = await fetch(`${world.server.url}/api/mcp/runs/${runId}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${randomUUID()}` }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect([401, 403, 404]).toContain(endpoint.status);

    term.type('id -u; pwd; ls; echo token=$MANYTHREADS_MCP_TOKEN end\n');
    await term.sees(/\b6[0-4]\d{3}\b/);
    await term.sees(/\/work/);
    await term.sees(/README\.txt/);
    await term.sees(/token= end/);
    term.type('echo "key AKIAIOSFODNN7EXAMPLE and mail dev@example.com"\n');
    await term.sees(/key AKIA\w+ and mail/);
    term.type('exit\n');
    expect(await term.closed).toBe(1000);
    expect(term.ended).toMatchObject({ reason: 'closed' });
    await shellGone(id);

    // the record: who, which sandbox, when, how it ended, and the text with the secret masked
    const done = await finished(id);
    expect(done.status).toBe('ended');
    expect(done.end_reason).toBe('closed');
    expect(done.started_at).toBeTruthy();
    expect(done.ended_at!.getTime()).toBeGreaterThanOrEqual(done.started_at!.getTime());
    expect(Number(done.bytes_in)).toBeGreaterThan(20);
    expect(Number(done.bytes_out)).toBeGreaterThan(50);
    expect(done.transcript).toMatch(/\b6[0-4]\d{3}\b/);
    expect(done.transcript).toContain('README.txt');
    expect(done.transcript).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(done.transcript).toMatch(/\[redacted/i);
    const read = await recording(omar, id);
    expect(read.status).toBe(200);
    expect(read.body.session).toMatchObject({ status: 'ended', endReason: 'closed', botSlug: 'termbot', admin: { name: 'Omar' }, sandbox: { kind: 'rehearsal' } });
    expect(read.body.session.transcript).toBe(done.transcript);
    // the folder is gone
    expect((await readdir(root)).filter((n) => n.startsWith(id))).toEqual([]);
    // another admin of the workspace may read the record (that is what it is for); a member may not
    expect((await recording(ada, id)).status).toBe(200);
    expect((await recording(nadia, id)).status).toBe(403);
    // and the audit log has both ends, naming Omar
    await vi.waitFor(
      async () => {
        const audit = await world.system(async (tx) => (await tx.query<{ action: string; actor_name: string; outcome: string; reason: string | null }>("SELECT action, actor_name, outcome, reason FROM app.audit_events WHERE action LIKE 'terminal.%' AND target_id = $1 AND occurred_at >= $2 ORDER BY action", [botId, since])).rows);
        // (the bot is shared by every test of the file and the database outlives a run, so earlier sessions of the same bot may add closed rows: this session adds exactly one opened and a closed)
        expect(audit.filter((a) => a.action === 'terminal.opened')).toHaveLength(1);
        expect(audit.filter((a) => a.action === 'terminal.closed' && a.reason === 'Closed.').length).toBeGreaterThanOrEqual(1);
        expect(audit.every((a) => a.actor_name === 'Omar')).toBe(true);
        expect(audit.find((a) => a.action === 'terminal.opened')?.reason).toMatch(/credential/);
      },
      { timeout: 20_000, interval: 250 },
    );
  });

  it('lets only one terminal be open per admin, even when two are asked for at once', async () => {
    const [a, b] = await Promise.all([open(omar), open(omar)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    expect(JSON.stringify(loser.body)).toMatch(/already have a terminal/);
    expect((await open(omar)).status).toBe(409);
    // another admin has their own
    const other = await open(ada);
    expect(other.status).toBe(201);
    expect(await world.system(async (tx) => (await tx.query("SELECT 1 FROM app.terminal_sessions WHERE status IN ('waiting','open')")).rows.length)).toBe(2);
    await end(omar, winner.body.session.id);
    await end(ada, other.body.session.id);
    // once the first is over, a new one can be opened
    const again = await open(omar);
    expect(again.status).toBe(201);
    await end(omar, again.body.session.id);
  });

  it('connects a terminal once, and only for the admin who asked for it', async () => {
    const { id, term } = await started();
    // a second connection to the same terminal: refused before the upgrade
    expect(await upgrade(`${base}/${id}/socket`, dev(omar))).toBe(409);
    // another admin of the same workspace cannot take it over, and cannot reach it before it opened either
    const waiting = await open(ada);
    expect(await upgrade(`${base}/${waiting.body.session.id}/socket`, dev(omar))).toBe(404);
    expect(await upgrade(`${base}/${id}/socket`, dev(ada))).toBe(404);
    await end(ada, waiting.body.session.id);
    term.ws.close();
    await term.closed;
    await shellGone(id);
    expect((await finished(id)).end_reason).toBe('closed');
  });

  it('kills the shell and everything it started when the page goes away, and cleans the folder', async () => {
    const { id, term } = await started();
    term.type('sleep 300 &\nsleep 301 &\necho started\n');
    await term.sees(/started/);
    expect(shellsOf(id)).toBeGreaterThan(0);
    term.ws.terminate();
    await term.closed;
    await shellGone(id);
    const done = await finished(id);
    expect(done.end_reason).toBe('closed');
    expect(spawnSync('pgrep', ['-f', 'sleep 30[01]']).stdout.toString().trim()).toBe('');
    expect((await readdir(root)).filter((n) => n.startsWith(id))).toEqual([]);
  });

  it('ends a terminal when an admin presses End, and records who ended it', async () => {
    const { id, term } = await started();
    const res = await end(ada, id);
    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({ status: 'ended', endReason: 'ended_by_admin' });
    expect(await term.closed).toBe(1000);
    expect(term.ended).toMatchObject({ reason: 'ended_by_admin' });
    await shellGone(id);
    // ending it again changes nothing
    expect((await end(ada, id)).body.session.endReason).toBe('ended_by_admin');
  });

  it('closes a terminal nobody typed in for the idle time (the shell is killed)', async () => {
    await withEnv({ MANYTHREADS_TERMINAL_IDLE_SECONDS: '2' }, async () => {
      const { id, term } = await started();
      term.type('sleep 303 &\n');
      const t0 = Date.now();
      expect(await term.closed).toBe(1000);
      expect(Date.now() - t0).toBeLessThan(8000);
      expect(term.ended).toMatchObject({ reason: 'idle' });
      await shellGone(id);
      expect((await finished(id)).end_reason).toBe('idle');
      expect(spawnSync('pgrep', ['-f', 'sleep 303']).stdout.toString().trim()).toBe('');
    });
  });

  it('keeps a terminal alive while keys are typed, and still stops it at the longest time', async () => {
    await withEnv({ MANYTHREADS_TERMINAL_IDLE_SECONDS: '2', MANYTHREADS_TERMINAL_MAX_SECONDS: '4' }, async () => {
      const { id, term } = await started();
      const stop = Date.now() + 8000;
      while (Date.now() < stop && term.ws.readyState === WebSocket.OPEN) {
        term.type(' ');
        await sleep(500);
      }
      expect(term.ended).toMatchObject({ reason: 'max_duration' });
      await shellGone(id);
      expect((await finished(id)).end_reason).toBe('max_duration');
    });
  });

  it('closes a shell that prints more than its allowance', async () => {
    await withEnv({ MANYTHREADS_TERMINAL_OUTPUT_BYTES_TOTAL: '30000' }, async () => {
      const { id, term } = await started();
      term.type('yes aaaaaaaaaaaaaaaaaaaa | head -c 200000\n');
      expect(await term.closed).toBe(1000);
      expect(term.ended).toMatchObject({ reason: 'output_limit' });
      await shellGone(id);
      const done = await finished(id);
      expect(done.end_reason).toBe('output_limit');
      expect(Number(done.bytes_out)).toBeLessThan(120_000);
    });
  });

  it('ends on a frame that is not a frame, and never types it into the shell', async () => {
    const { id, term } = await started();
    term.ws.send('rm -rf / # not json');
    expect(await term.closed).toBe(1007);
    await shellGone(id);
    expect((await finished(id)).end_reason).toBe('error');
  });

  it('closes a terminal nobody connected to in time, and a late connection is refused', async () => {
    await withEnv({ MANYTHREADS_TERMINAL_WAITING_SECONDS: '1' }, async () => {
      const opened = await open(omar);
      expect(opened.status).toBe(201);
      const id = opened.body.session.id;
      await sleep(1500);
      const late = new Term(id, dev(omar));
      expect(await late.closed).toBe(1008);
      expect(late.frames).toEqual([]);
      // the next request tidies up and a new terminal can be opened
      const next = await open(omar);
      expect(next.status).toBe(201);
      expect((await row(id))?.end_reason).toBe('unused');
      await end(omar, next.body.session.id);
    });
  });

  it('ends a terminal whose admin lost the admin role', async () => {
    const { id, term } = await started(ada);
    await world.system((tx) => tx.query("UPDATE app.workspace_members SET role = 'member' WHERE person_id = $1", [ada.personId]));
    expect(await term.closed).toBe(1000);
    expect(term.ended).toMatchObject({ reason: 'session_ended' });
    await shellGone(id);
    expect((await finished(id)).end_reason).toBe('session_ended');
    // and the former admin is refused from now on
    expect((await api(ada, 'GET', base)).status).toBe(403);
    await world.system((tx) => tx.query("UPDATE app.workspace_members SET role = 'admin' WHERE person_id = $1", [ada.personId]));
  }, 60_000);

  it('goes through the same cookie session and origin checks as every other route: a signed-out session loses its terminal', async () => {
    const client: ApiClient = createApiClient(world.server.url);
    expect((await client.signIn(omar.email, PERSONA_PASSWORD)).status).toBe(200);
    const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    // a state-changing request on the cookie needs the CSRF token the client keeps; the socket upgrade is a GET with the cookie and a same-origin Origin
    const opened = await client.post(base, {});
    expect(opened.status).toBe(201);
    const id = ((await opened.json()) as { session: TerminalSession }).session.id;
    expect(await upgrade(`${base}/${id}/socket`, { cookie, origin: 'https://evil.example' })).toBe(403);
    const term = new Term(id, { cookie });
    await term.until('ready', () => term.frames.some((f) => f.t === 'ready'));
    await term.sees(/sandbox:.*\$/);
    // sign out: the session is gone, and within one revalidation round so is the terminal
    expect((await client.post(signOutRoute.path, {})).status).toBeLessThan(300);
    expect(await term.closed).toBe(1008);
    await shellGone(id);
    // the record says the sign-in ended, not that the page was closed
    expect((await finished(id)).end_reason).toBe('session_ended');
  }, 90_000);

  it('ends a terminal whose row was closed by someone else, within the watch time', async () => {
    const { id, term } = await started();
    await world.system((tx) => tx.query("UPDATE app.terminal_sessions SET status = 'ended', end_reason = 'server_stop', ended_at = now() WHERE id = $1", [id]));
    expect(await term.closed).toBe(1000);
    expect(term.ended).toMatchObject({ reason: 'server_stop' });
    await shellGone(id);
    expect((await row(id))?.end_reason).toBe('server_stop');
  }, 60_000);

  it('does not close a terminal that is being connected while other requests tidy up', async () => {
    for (let round = 0; round < 3; round += 1) {
      const opened = await open(omar);
      expect(opened.status).toBe(201);
      const id = opened.body.session.id;
      const term = new Term(id, dev(omar));
      // every request below begins with the housekeeping that closes terminals the server has lost
      const tidy = await Promise.all(Array.from({ length: 8 }, () => open(ada)));
      for (const t of tidy) if (t.status === 201) await end(ada, t.body.session.id);
      await term.until('ready', () => term.frames.some((f) => f.t === 'ready'));
      await term.sees(/sandbox:.*\$/);
      expect(term.ended).toBeUndefined();
      expect((await row(id))?.status).toBe('open');
      term.ws.close();
      await term.closed;
      await shellGone(id);
    }
  }, 90_000);

  it('opens into a rehearsal run that is named, ends that run, and still revokes its token', async () => {
    const rehearsal = await runs.open({ botId, teamId, workspaceId: omar.workspaceId, trigger: 'conversation', askerActorId: omar.actorId, rehearsal: true });
    const hash = tokenHash(rehearsal.token);
    expect(await runs.resolve(hash)).not.toBeNull();
    const opened = await open(omar, rehearsal.run.runId);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.session.sandbox.runId).toBe(rehearsal.run.runId);
    // the token of that run was usable a moment ago and is refused now: the test tries it
    expect(await runs.resolve(hash)).toBeNull();
    await end(omar, opened.body.session.id);
  });
});

const tokenHash = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();
