import { createAppPool, createSecretService, createSystemPool, withSystem, CapabilityBroker, CapabilityRegistry, createDbGrantSource, createRunService, type Tx } from '@manythreads/kernel';
import type { BotRunHandle, PluginTx } from '@manythreads/sdk';
import { McpRunMintResponse, StartPersonConnectionResponse, type PersonProviderId } from '@manythreads/shared';
import { startFakeProviders, type FakeProviders } from '@manythreads/test-utils';
import { describeToolSourceIntersection, type CallOutcome } from '@manythreads/test-utils/tool-source-intersection';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld, type Who } from '../../repo-git/test/world.ts';
import { compileBot } from '../src/index.ts';
import type { Declared } from '../src/compile.ts';
import { FREE_TIME_TOOLS, freeSlots, validZone, workingWindows, zonedInstant } from '../src/free-time-tool.ts';
import { createProviderApi, type ProviderApi } from '../src/oauth/api.ts';
import type { OAuthDeps } from '../src/oauth/store.ts';
import { PERSON_TOOL_DEFS } from '../src/person-tools.ts';

// P16-05 (D11): `calendar.find_free_time`. The arithmetic and the answer's shape are tested with stand-ins for the database and the provider; the rest on a real server,
// the fake Google and Microsoft 365, and the real MCP gateway as a bot that a person asked.

vi.setConfig({ testTimeout: 120_000 });

const TOOL = 'calendar.find_free_time';
const tool = FREE_TIME_TOOLS[0]!;

// ---- time -------------------------------------------------------------------------------------------------------------------------------------------------------

describe('working hours in the asker’s zone', () => {
  it('knows a zone, and uses UTC for one it does not know', () => {
    expect(validZone('Asia/Karachi')).toBe('Asia/Karachi');
    expect(validZone('Mars/Olympus_Mons')).toBe('UTC');
    expect(validZone(null)).toBe('UTC');
    expect(validZone('')).toBe('UTC');
  });

  it('turns a wall clock into the instant it shows, also across a change of clocks', () => {
    expect(new Date(zonedInstant(2026, 11, 3, 9, 'UTC')).toISOString()).toBe('2026-11-03T09:00:00.000Z');
    expect(new Date(zonedInstant(2026, 11, 3, 9, 'Asia/Karachi')).toISOString()).toBe('2026-11-03T04:00:00.000Z');
    expect(new Date(zonedInstant(2026, 11, 3, 9, 'America/New_York')).toISOString()).toBe('2026-11-03T14:00:00.000Z'); // winter time
    expect(new Date(zonedInstant(2026, 7, 3, 9, 'America/New_York')).toISOString()).toBe('2026-07-03T13:00:00.000Z'); // summer time
    // New York put its clocks back on 2026-11-01
    expect(new Date(zonedInstant(2026, 10, 30, 9, 'America/New_York')).toISOString()).toBe('2026-10-30T13:00:00.000Z');
  });

  it('gives 09:00-18:00 on weekdays only, clipped to the window', () => {
    const at = (iso: string): number => Date.parse(iso);
    // Tuesday 3 November 2026, from 07:00 UTC for one day
    expect(workingWindows(at('2026-11-03T07:00:00Z'), at('2026-11-04T07:00:00Z'), 'UTC')).toEqual([{ start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T18:00:00.000Z' }]);
    // the middle of a working day to the middle of the next
    expect(workingWindows(at('2026-11-03T12:00:00Z'), at('2026-11-04T12:00:00Z'), 'UTC')).toEqual([
      { start: '2026-11-03T12:00:00.000Z', end: '2026-11-03T18:00:00.000Z' },
      { start: '2026-11-04T09:00:00.000Z', end: '2026-11-04T12:00:00.000Z' },
    ]);
    // Friday evening to Monday morning: nothing at the weekend
    expect(workingWindows(at('2026-11-06T17:00:00Z'), at('2026-11-09T10:00:00Z'), 'UTC')).toEqual([
      { start: '2026-11-06T17:00:00.000Z', end: '2026-11-06T18:00:00.000Z' },
      { start: '2026-11-09T09:00:00.000Z', end: '2026-11-09T10:00:00.000Z' },
    ]);
    // the same Tuesday in Karachi is 04:00-13:00 UTC
    expect(workingWindows(at('2026-11-03T00:00:00Z'), at('2026-11-04T00:00:00Z'), 'Asia/Karachi')).toEqual([{ start: '2026-11-03T04:00:00.000Z', end: '2026-11-03T13:00:00.000Z' }]);
    // a fortnight is ten working days
    expect(workingWindows(at('2026-11-02T00:00:00Z'), at('2026-11-16T00:00:00Z'), 'UTC')).toHaveLength(10);
  });

  it('finds the gaps everyone shares, on a quarter hour, at most three a day and ten in all', () => {
    const windows = [{ start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T18:00:00.000Z' }];
    const busy = [
      { start: '2026-11-03T10:00:00.000Z', end: '2026-11-03T12:00:00.000Z' },
      { start: '2026-11-03T11:00:00.000Z', end: '2026-11-03T12:07:00.000Z' }, // overlaps and ends off the quarter
      { start: '2026-11-03T13:00:00.000Z', end: '2026-11-03T14:00:00.000Z' },
    ];
    expect(freeSlots(busy, windows, 30)).toEqual([
      { start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z' },
      { start: '2026-11-03T12:15:00.000Z', end: '2026-11-03T13:00:00.000Z' },
      { start: '2026-11-03T14:00:00.000Z', end: '2026-11-03T18:00:00.000Z' },
    ]);
    expect(freeSlots(busy, windows, 90)).toEqual([{ start: '2026-11-03T14:00:00.000Z', end: '2026-11-03T18:00:00.000Z' }]);
    expect(freeSlots(busy, windows, 240)).toEqual([{ start: '2026-11-03T14:00:00.000Z', end: '2026-11-03T18:00:00.000Z' }]);
    const days = Array.from({ length: 14 }, (_, i) => ({ start: `2026-11-${String(2 + i).padStart(2, '0')}T09:00:00.000Z`, end: `2026-11-${String(2 + i).padStart(2, '0')}T18:00:00.000Z` }));
    expect(freeSlots([], days, 30)).toHaveLength(10);
  });
});

// ---- the answer, with stand-ins ----------------------------------------------------------------------------------------------------------------------

describe('the names a model gives', () => {
  const NOW = new Date('2026-11-03T07:00:00.000Z');
  type Row = { name_key: string; person_id: string; display_name: string; email: string };
  const row = (key: string, id: string, name: string, email: string): Row => ({ name_key: key, person_id: id, display_name: name, email });
  /** A transaction that answers the name lookup with `rows` and the zone lookup with `zone`, and remembers what it was asked. */
  const stub = (rows: Row[], zone: string | null = null) => {
    const asked: Array<{ sql: string; params: unknown[] }> = [];
    const tx = {
      actor: { id: 'asker-actor' },
      async query(sql: string, params: unknown[]) {
        asked.push({ sql, params });
        return { rows: sql.includes('connections_resolve_people') ? rows : zone === null ? [] : [{ time_zone: zone }] };
      },
    };
    return { tx: tx as unknown as PluginTx, asked };
  };
  /** A provider that answers Google's free/busy with these calendars, and counts the calls. */
  const google = (calendars: Record<string, unknown>) => {
    const calls: Array<{ path: string; body: { items: Array<{ id: string }> } }> = [];
    const api: ProviderApi = {
      now: () => NOW,
      async json(path, init) {
        calls.push({ path, body: init?.body as never });
        return { calendars };
      },
      async text() {
        throw new Error('not used');
      },
    };
    return { api, calls };
  };
  const run = (api: ProviderApi, tx: PluginTx, input: Record<string, unknown>) => tool.run(api, input, { provider: 'google', tx, run: {} as BotRunHandle }) as Promise<Record<string, unknown>>;

  it('says it could not find a name nobody shares a team with, and asks the provider nothing', async () => {
    const { tx } = stub([]);
    const { api, calls } = google({});
    const answer = await run(api, tx, { with: ['Sameera'] });
    expect(answer).toMatchObject({ ok: true, slots: [], people: [], notFound: ['Sameera'], ambiguous: [], note: expect.stringContaining('could not find') });
    expect(calls).toEqual([]);
  });

  it('asks which one when a name fits several people, with their names and no address', async () => {
    const { tx } = stub([row('sam', 'p1', 'Sam Okoye', 'sam.okoye@kahf.example'), row('sam', 'p2', 'Samira Haddad', 'samira@kahf.example')]);
    const { api, calls } = google({});
    const answer = await run(api, tx, { with: ['Sam'] });
    expect(answer).toMatchObject({ slots: [], people: [], notFound: [], ambiguous: [{ name: 'Sam', candidates: ['Sam Okoye', 'Samira Haddad'] }] });
    expect(JSON.stringify(answer)).not.toContain('@');
    expect(calls).toEqual([]);
  });

  it('sends the lookup the names only (at most five, @ and case as typed), uses the asker’s profile zone, and never puts an address in the answer', async () => {
    const { tx, asked } = stub([row('nadia', 'p2', 'Nadia Farouk', 'nadia@kahf.example'), row('rafi', 'p3', 'Rafi Chen', 'rafi@kahf.example')], 'Asia/Karachi');
    const { api, calls } = google({
      primary: { busy: [{ start: '2026-11-03T04:00:00Z', end: '2026-11-03T06:00:00Z' }] },
      'nadia@kahf.example': { busy: [{ start: '2026-11-03T08:00:00Z', end: '2026-11-03T09:00:00Z' }] },
      'rafi@kahf.example': { busy: [], errors: [{ reason: 'notFound' }] },
    });
    const answer = await run(api, tx, { with: ['@nadia', 'Nadia', 'rafi'], withinDays: 1, minutes: 60 });
    expect(asked[0]!.params).toEqual([['@nadia', 'Nadia', 'rafi']]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.items.map((i) => i.id)).toEqual(['primary', 'nadia@kahf.example', 'rafi@kahf.example']);
    expect(answer).toMatchObject({
      ok: true,
      zone: 'Asia/Karachi',
      minutes: 60,
      people: ['Nadia Farouk', 'Rafi Chen'],
      notVisible: ['Rafi Chen'],
      notFound: [],
      // 09:00-18:00 in Karachi is 04:00-13:00 UTC; from 07:00 UTC the window is 07:00-13:00; the asker's busy time ended at 06:00 and Nadia is busy 08:00-09:00
      slots: [
        { start: '2026-11-03T07:00:00.000Z', end: '2026-11-03T08:00:00.000Z' },
        { start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T13:00:00.000Z' },
        // the next morning in Karachi starts at 04:00 UTC, and the day asked about ends at 07:00 UTC
        { start: '2026-11-04T04:00:00.000Z', end: '2026-11-04T07:00:00.000Z' },
      ],
      note: expect.stringContaining('Rafi Chen has not shared a calendar'),
    });
    // an address never reaches the model
    expect(JSON.stringify(answer)).not.toContain('@kahf.example');
  });

  it('is refused arguments that are not names, before anything runs', () => {
    for (const bad of [{}, { with: [] }, { with: ['a', 'b', 'c', 'd', 'e', 'f'] }, { with: ['x'], withinDays: 15 }, { with: ['x'], minutes: 10 }, { with: ['x'], minutes: 300 }, { with: ['x'], email: 'a@b.co' }, { with: [''] }, { with: ['x'.repeat(81)] }]) {
      expect(tool.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(tool.input.safeParse({ with: ['Nadia'], withinDays: 14, minutes: 240 }).success).toBe(true);
  });

  it('is a read of the asker’s calendar service, through Google or Microsoft 365', () => {
    expect(tool).toMatchObject({ name: TOOL, kind: 'read', service: 'calendar_free_busy', provider: 'google', alsoProviders: ['microsoft'] });
    expect(PERSON_TOOL_DEFS.filter((t) => t.name === TOOL)).toHaveLength(1);
  });
});

// ---- on a real server --------------------------------------------------------------------------------------------------------------------------------------

const { omar, nadia, rafi, priya, sameera } = personas;
const ENG = TEAM_IDS.Engineering;
const WS = omar.workspaceId;

describe('on a real server, with the fake Google and Microsoft 365 and the MCP gateway', () => {
  let w: RepoWorld;
  let fake: FakeProviders;
  let sysPool: pg.Pool;
  let deps: OAuthDeps;
  let bot: { botId: string; actorId: string };
  const savedEnv: Record<string, string | undefined> = {};
  const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: WS });
  const asPlugin = <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> => sys((tx) => fn(tx as unknown as PluginTx));
  const declared: Declared = new Map([['email.read', { destructive: false }], ...PERSON_TOOL_DEFS.map((t) => [t.name, { destructive: false }] as const)]);

  const devHeader = (who: Who): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: who.kind ?? 'person', id: who.actorId, workspaceId: who.workspaceId }) });
  const raw = (who: Who, method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${w.server.url}${path}`, { method, redirect: 'manual', headers: { ...devHeader(who), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  async function connect(who: Who & { email: string }, provider: PersonProviderId, services: string[]): Promise<void> {
    fake.signInAs(who.email);
    const start = await raw(who, 'POST', `/api/me/connections/${provider}/start`, { services });
    expect(start.status).toBe(200);
    const consent = await fetch(StartPersonConnectionResponse.parse(await start.json()).url, { redirect: 'manual' });
    const back = new URL(consent.headers.get('location')!);
    expect((await raw(who, 'GET', `${back.pathname}${back.search}`)).status).toBe(302);
  }

  async function makeBot(slug: string, connections: unknown): Promise<{ botId: string; actorId: string }> {
    return sys(async (tx) => {
      const botId = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, connections)
           VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('e', 64), 'active', $4::jsonb) RETURNING id`,
          [WS, ENG, slug, JSON.stringify(connections)],
        )
      ).rows[0]!.id;
      const actorId = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [WS, botId])).rows[0]!.id;
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [ENG, actorId, WS]);
      return { botId, actorId };
    });
  }
  const compile = (botId: string) => asPlugin((tx) => compileBot(tx, declared, { workspaceId: WS, teamId: ENG, botId }));
  const setBotConnections = (botId: string, connections: unknown) => sys((tx) => tx.query(`UPDATE app.bots SET connections = $2::jsonb WHERE id = $1`, [botId, JSON.stringify(connections)]));

  async function openRun(askerActorId: string): Promise<McpRunMintResponse> {
    const appPool = createAppPool(w.server.db.appUrl);
    const pool = createSystemPool(w.server.db.systemUrl, 2);
    try {
      const registry = new CapabilityRegistry();
      const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool }) });
      const service = createRunService({ pool: appPool, systemPool: pool, registry, broker, handlers: new Map() });
      const { run, token } = await service.open({ botId: bot.botId, teamId: ENG, workspaceId: WS, trigger: 'conversation', askerActorId });
      return McpRunMintResponse.parse({ runId: run.runId, botId: run.botId, url: `${w.server.url}/api/mcp/runs/${run.runId}`, token, expiresAt: run.expiresAt });
    } finally {
      await appPool.end();
      await pool.end();
    }
  }
  async function rpc(run: McpRunMintResponse, method: string, params?: unknown): Promise<{ result?: { tools?: Array<{ name: string; description: string }>; content?: Array<{ text: string }> } }> {
    const res = await fetch(`${w.server.url}/api/mcp/runs/${run.runId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${run.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
    });
    return (await res.json()) as never;
  }
  const listed = async (run: McpRunMintResponse): Promise<string[]> => ((await rpc(run, 'tools/list')).result?.tools ?? []).map((t) => t.name);
  const answers: string[] = [];
  const called = async (run: McpRunMintResponse, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const text = (await rpc(run, 'tools/call', { name: TOOL, arguments: args })).result!.content![0]!.text;
    answers.push(text);
    return JSON.parse(text) as Record<string, unknown>;
  };

  beforeAll(async () => {
    fake = await startFakeProviders();
    for (const [k, v] of Object.entries(fake.env())) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    w = await createRepoWorld();
    sysPool = createSystemPool(w.server.db.systemUrl, 2);
    deps = {
      db: { system: (fn, options) => withSystem((tx) => fn(tx as unknown as PluginTx), { pool: sysPool, ...(options?.workspaceId ? { workspaceId: options.workspaceId as never } : {}) }) },
      secrets: createSecretService(),
      // the clock of the tool: Tuesday 3 November 2026, 07:00 UTC
      now: () => new Date('2026-11-03T07:00:00.000Z'),
      env: process.env,
    };
    // Nadia asks through Google; Rafi through Microsoft 365; Priya connected Google without free and busy; Sameera is on no team of the people she will ask about
    await connect(nadia, 'google', ['calendar_free_busy']);
    await connect(rafi, 'microsoft', ['calendar_free_busy']);
    await connect(priya, 'google', ['calendar']);
    await connect(sameera, 'google', ['calendar_free_busy']);
    fake.account(nadia.email).events = [{ id: 'n1', title: 'Dentist (private)', start: '2026-11-03T13:00:00.000Z', end: '2026-11-03T14:00:00.000Z' }];
    fake.account(omar.email).events = [{ id: 'o1', title: 'Secret strategy', start: '2026-11-03T10:00:00.000Z', end: '2026-11-03T12:00:00.000Z' }];
    fake.account(rafi.email).events = [{ id: 'r1', title: 'Interview', start: '2026-11-03T09:30:00.000Z', end: '2026-11-03T10:00:00.000Z' }];
    fake.account(priya.email).shareCalendar = false;
    bot = await makeBot('free-time', [{ connection: 'person:*', tools: [TOOL] }]);
    await compile(bot.botId);
  }, 240_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await sysPool?.end();
    await w?.close();
    await fake?.stop();
  });

  /** The tool as the platform calls it: the asker's own transaction and their own sign-in. */
  async function direct(who: Who, provider: 'google' | 'microsoft', input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = (await sys(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.connections WHERE owner_id = $1 AND slug = $2`, [who.actorId, provider])).rows[0]!.id));
    const api = createProviderApi(deps, { id, workspaceId: WS, provider });
    return w.as(who, (tx) => tool.run(api, input, { provider, tx, run: {} as BotRunHandle })) as Promise<Record<string, unknown>>;
  }

  it('Nadia and Omar through Google: the gaps in working hours that neither calendar covers, and no title in the answer', async () => {
    const answer = await direct(nadia, 'google', { with: ['omar'], withinDays: 1, minutes: 30 });
    // 09:00-18:00 UTC from 07:00: Omar is busy 10-12, Nadia 13-14
    expect(answer).toMatchObject({
      ok: true,
      zone: 'UTC',
      people: ['Omar'],
      notVisible: [],
      notFound: [],
      slots: [
        { start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z' },
        { start: '2026-11-03T12:00:00.000Z', end: '2026-11-03T13:00:00.000Z' },
        { start: '2026-11-03T14:00:00.000Z', end: '2026-11-03T18:00:00.000Z' },
      ],
    });
    expect(JSON.stringify(answer)).not.toMatch(/Dentist|Secret strategy|@kahf\.example/);
    // a longer meeting leaves the long gap only
    expect((await direct(nadia, 'google', { with: ['Omar'], withinDays: 1, minutes: 120 }))['slots']).toEqual([{ start: '2026-11-03T14:00:00.000Z', end: '2026-11-03T18:00:00.000Z' }]);
  });

  it('a calendar its owner does not share is named as not visible, and the slots take account of the others only', async () => {
    const answer = await direct(nadia, 'google', { with: ['Omar', 'Priya'], withinDays: 1, minutes: 30 });
    expect(answer).toMatchObject({ people: ['Omar', 'Priya'], notVisible: ['Priya'], note: expect.stringContaining('Priya has not shared') });
    expect((answer['slots'] as unknown[]).length).toBeGreaterThan(0);
    // asking for her alone: no one is left to take account of, only Nadia's own calendar
    expect(await direct(nadia, 'google', { with: ['priya'], withinDays: 1 })).toMatchObject({ people: ['Priya'], notVisible: ['Priya'] });
  });

  it('refuses a name outside the asker’s teams: it could not be found, and it never gives an address', async () => {
    const calls = fake.apiCalls.length;
    const answer = await direct(nadia, 'google', { with: ['Sameera', 'tariq'] });
    expect(answer).toMatchObject({ ok: true, slots: [], people: [], notFound: ['Sameera', 'tariq'], note: expect.stringContaining('could not find') });
    expect(JSON.stringify(answer)).not.toContain('@');
    // a guessed address is not a name: it finds nobody either (and is only handed back as typed)
    expect(await direct(nadia, 'google', { with: ['sameera@kahf.example'] })).toMatchObject({ people: [], notFound: ['sameera@kahf.example'] });
    // a name nobody matched costs the provider nothing
    expect(fake.apiCalls.length).toBe(calls);
  });

  it('Rafi asks through Microsoft 365, and it is his own sign-in that is used', async () => {
    const before = fake.scheduleRequests.length;
    const answer = await direct(rafi, 'microsoft', { with: ['nadia', 'omar'], withinDays: 1, minutes: 30 });
    expect(fake.scheduleRequests.slice(before)).toEqual([{ account: rafi.email, schedules: [rafi.email, nadia.email, omar.email] }]);
    // Rafi is busy 09:30-10:00, Omar 10-12, Nadia 13-14
    expect(answer).toMatchObject({
      ok: true,
      people: ['Nadia', 'Omar'],
      notVisible: [],
      slots: [
        { start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T09:30:00.000Z' },
        { start: '2026-11-03T12:00:00.000Z', end: '2026-11-03T13:00:00.000Z' },
        { start: '2026-11-03T14:00:00.000Z', end: '2026-11-03T18:00:00.000Z' },
      ],
    });
    expect(JSON.stringify(answer)).not.toMatch(/Interview|Dentist|Secret strategy|SECRET-MAILBOX-TEXT|@kahf\.example/);
  });

  it('uses the time zone in the asker’s profile', async () => {
    await sys((tx) => tx.query(`INSERT INTO app.person_status (person_id, workspace_id, time_zone) VALUES ($1, $2, 'Asia/Karachi') ON CONFLICT (person_id) DO UPDATE SET time_zone = 'Asia/Karachi'`, [nadia.personId, WS]));
    try {
      const answer = await direct(nadia, 'google', { with: ['omar'], withinDays: 1, minutes: 30 });
      // 09:00 in Karachi is 04:00 UTC; from 07:00 UTC the window is 07:00-13:00 UTC; Omar is busy 10-12, so 07-10 and 12-13
      expect(answer).toMatchObject({
        zone: 'Asia/Karachi',
        slots: [
          { start: '2026-11-03T07:00:00.000Z', end: '2026-11-03T10:00:00.000Z' },
          { start: '2026-11-03T12:00:00.000Z', end: '2026-11-03T13:00:00.000Z' },
          { start: '2026-11-04T04:00:00.000Z', end: '2026-11-04T07:00:00.000Z' },
        ],
      });
    } finally {
      await sys((tx) => tx.query('DELETE FROM app.person_status WHERE person_id = $1', [nadia.personId]));
    }
  });

  describe('through the MCP gateway', () => {
    it('is listed for an asker who agreed to free and busy (Google or Microsoft 365), and not for one who did not', async () => {
      expect(await listed(await openRun(nadia.actorId))).toContain(TOOL);
      expect(await listed(await openRun(rafi.actorId))).toContain(TOOL);
      // Priya connected Google without free and busy; Omar connected nothing
      expect(await listed(await openRun(priya.actorId))).not.toContain(TOOL);
      expect(await listed(await openRun(omar.actorId))).not.toContain(TOOL);
    });

    it('answers with the asker’s grant; says what to do when the service was not agreed or nothing is connected', async () => {
      const ok = await called(await openRun(nadia.actorId), { with: ['omar'], withinDays: 3 });
      expect(ok).toMatchObject({ ok: true, people: ['Omar'] });
      expect((ok['slots'] as unknown[]).length).toBeGreaterThan(0);
      const viaMicrosoft = await called(await openRun(rafi.actorId), { with: ['nadia'] });
      expect(viaMicrosoft).toMatchObject({ ok: true, people: ['Nadia'] });
      const notAgreed = await called(await openRun(priya.actorId), { with: ['omar'] });
      expect(notAgreed).toMatchObject({ ok: false, code: 'not_agreed' });
      expect(String(notAgreed['message'])).toContain('free and busy');
      expect(await called(await openRun(omar.actorId), { with: ['nadia'] })).toMatchObject({ ok: false, code: 'not_connected' });
      expect(String((await called(await openRun(omar.actorId), { with: ['nadia'] }))['message'])).toContain('Google or Microsoft 365');
    });

    it('refuses arguments that are not names, and an address-shaped field', async () => {
      const run = await openRun(nadia.actorId);
      for (const args of [{}, { with: [] }, { with: ['omar'], emails: ['omar@kahf.example'] }, { with: ['omar'], withinDays: 90 }]) {
        expect(await called(run, args), JSON.stringify(args)).toMatchObject({ code: 'validation_failed' });
      }
    });

    it('a token, an address or a title appears in no answer', () => {
      expect(answers.join('\n')).not.toMatch(/(access|refresh)-[A-Za-z0-9_-]{20}/);
      expect(answers.join('\n')).not.toMatch(/@kahf\.example|Secret strategy|Dentist|SECRET-MAILBOX-TEXT/);
    });
  });

  // The test every source of tools must pass (bot capabilities ∩ asker visibility), run for this tool.
  describe('intersection', () => {
    const state = { askerVisible: true };
    /** The asker (Sameera, on no Engineering seat) is seated just long enough to open the run, then seated or not as the case says. */
    async function runForAsker(): Promise<McpRunMintResponse> {
      const seat = (on: boolean) =>
        sys((tx) =>
          on
            ? tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING`, [ENG, sameera.actorId, WS])
            : tx.query('DELETE FROM app.team_members WHERE team_id = $1 AND actor_id = $2', [ENG, sameera.actorId]),
        );
      await seat(true);
      const run = await openRun(sameera.actorId);
      await seat(state.askerVisible);
      return run;
    }
    describeToolSourceIntersection('a person’s connection (a read: calendar.find_free_time)', () => ({
      tool: TOOL,
      kind: 'read' as const,
      async arrange(next: { botGranted: boolean; askerVisible: boolean }): Promise<void> {
        state.askerVisible = next.askerVisible;
        await setBotConnections(bot.botId, next.botGranted ? [{ connection: 'person:*', tools: [TOOL] }] : []);
        await compile(bot.botId);
      },
      async listed(): Promise<readonly string[]> {
        return listed(await runForAsker());
      },
      async call(): Promise<CallOutcome> {
        const answer = await called(await runForAsker(), { with: ['omar'] });
        const code = typeof answer['code'] === 'string' ? answer['code'] : undefined;
        return { refused: code === 'forbidden' || code === 'not_found' || code === 'unknown_tool', code, text: JSON.stringify(answer) };
      },
    }));
  });
});
