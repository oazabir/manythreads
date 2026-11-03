import { createAppPool, withActor, type Actor } from '@manythreads/kernel';
import type { McpToolsProvider, PluginTx } from '@manythreads/sdk';
import { SURFACE_BIND_RESULT_MAX_CHARS, SurfaceDataResponse } from '@manythreads/shared';
import { personaActor } from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';
import { resetDataCalls } from '../src/index.ts';

// A bound part reads its data as the person looking (PLAN P9-06): the route, the gateway's door for a person's read, and what a screen can never make either do.
// Real server, real database, real tasks and search plugins. The bot that drew the screen is nowhere in the call; the people are Engineering's Nadia and Omar, and
// Support's Sameera, who is let into the channel but reads no Engineering card.

const { omar, nadia, sameera, rafi } = personas;
vi.setConfig({ testTimeout: 180_000 });

let w: World;
let appPool: pg.Pool;
let engineering = '';
let room = '';
let privateRoom = '';
let botId = '';
let botActor = '';
let provider: McpToolsProvider;
const WS = omar.workspaceId;

const SCREEN = [
  'root = Stack([head, cards, count, plain, found, evil])',
  'head = Heading("Open cards", 2)',
  'cards = Table(["Title", "State"], [], "Cards", {tool: "tasks.read", into: {rows: "tasks[].[title,state]"}, refreshSeconds: 30})',
  'count = Stat("Cards", "none yet", null, null, {tool: "tasks.read", into: {value: "tasks.length"}})',
  'plain = List(["placeholder"], false, {tool: "tasks.read", limit: 1, into: {items: "tasks[].title"}})',
  'found = List(["searching"], false, {tool: "messages.search", args: {query: "cache decision", limit: 5}, into: {items: "hits[].snippet"}})',
  'evil = Text("evil", null, {tool: "memory.recall", args: {query: "secrets"}, into: {text: "facts[].text"}})',
  '',
].join('\n');

// A conversation of its own, owned by no team: Sameera (Support) may read it with Nadia (Engineering), yet she reads no card of Engineering's.
const conversationOf = (members: Array<{ personId: string }>): Promise<string> =>
  w.system(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        "INSERT INTO app.channels (workspace_id, team_id, name, kind, private, dm_key, created_by) VALUES ($1, NULL, 'bound-data', 'dm', true, $2, $3) RETURNING id",
        [WS, `bound-data-${Date.now()}`, omar.actorId],
      )
    ).rows[0]!.id;
    for (const m of members) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });

const channelWith = (name: string, isPrivate: boolean, members: Array<{ personId: string }>): Promise<string> =>
  w.system(async (tx) => {
    const id = (
      await tx.query<{ id: string }>('INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [
        WS,
        engineering,
        name,
        'channel',
        isPrivate,
        omar.actorId,
      ])
    ).rows[0]!.id;
    for (const m of members) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });

const drawn = (channel: string, source: string): Promise<string> =>
  w.system(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by) VALUES ($1, $2, $3, 'Cards', $4, $5) RETURNING id`,
          [WS, channel, botId, source, botActor],
        )
      ).rows[0]!.id,
  );

const data = async (who: (typeof personas)[keyof typeof personas], channel: string, surface: string, node: string, body: unknown = { version: 1 }) =>
  w.call(who, 'POST', `/api/channels/${channel}/surfaces/${surface}/data/${node}`, body);
const asPerson = <T>(who: (typeof personas)[keyof typeof personas], fn: (tx: PluginTx) => Promise<T>): Promise<T> =>
  withActor(personaActor(who) as Actor, (tx) => fn(tx as unknown as PluginTx), { pool: appPool });

let surface = '';

beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  appPool = createAppPool(w.server.db.appUrl, 4);
  engineering = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);
  room = await conversationOf([nadia, sameera, omar]);
  privateRoom = await channelWith('bound-private', true, [omar]);
  // The bot that drew the screen holds NO grant at all: a viewer's read must not ask for one (and a grant it did hold could not widen anyone's view)
  const bot = await w.system(async (tx) => {
    const b = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
       VALUES ($1, $2, 'painter', 'painter', '', 'agent', 'hermes', 'team', repeat('a', 64), 'active', '{"runner": "default"}') RETURNING id`,
      [WS, engineering],
    );
    const a = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [WS, b.rows[0]!.id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [engineering, a.rows[0]!.id, WS]);
    return { id: b.rows[0]!.id, actor: a.rows[0]!.id };
  });
  botId = bot.id;
  botActor = bot.actor;
  surface = await drawn(room, SCREEN);
  for (const title of ['Pad the cents', 'Fix the cache']) {
    const created = await w.call(omar, 'POST', '/api/teams/engineering/tasks', { title, branch: `fix/${title.toLowerCase().replaceAll(' ', '-')}`, kind: 'code', priority: 'normal' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  }
  const dev = await w.channelId('engineering', 'dev');
  const posted = await w.call(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'The cache decision: three hundred seconds on the read path.', threadRootId: null });
  expect(posted.status, JSON.stringify(posted.body)).toBe(201);
  provider = w.server.host.registries.providers['mcp.tools']!.list()[0]!.value as McpToolsProvider;
}, 300_000);

afterAll(async () => {
  await appPool?.end();
  await w?.close();
});

describe('a bound part reads as the person looking', () => {
  it('a Table, a Stat and a List are filled from the cards Nadia may read', async () => {
    const table = await data(nadia, room, surface, 'cards');
    expect(table.status, JSON.stringify(table.body)).toBe(200);
    const t = SurfaceDataResponse.parse(table.body);
    expect(t.state).toBe('ok');
    if (t.state !== 'ok') return;
    // only the values the binding fills come back, never the written placeholders
    expect(Object.keys(t.props)).toEqual(['rows']);
    const rows = t.props['rows'] as Array<[string, string]>;
    expect(rows.map((r) => r[0]).sort()).toEqual(['Fix the cache', 'Pad the cents']);
    expect(rows.every((r) => typeof r[1] === 'string')).toBe(true);

    const stat = SurfaceDataResponse.parse((await data(nadia, room, surface, 'count')).body);
    // a number lands in a value the bot wrote as text, so it becomes text
    expect(stat).toMatchObject({ state: 'ok', props: { value: '2' } });
    const list = SurfaceDataResponse.parse((await data(nadia, room, surface, 'plain')).body);
    // `limit: 1` keeps the first item of the list
    expect(list).toMatchObject({ state: 'ok' });
    expect((list as unknown as { props: { items: string[] } }).props.items).toHaveLength(1);
  });

  it('the same screen shows Sameera nothing from Engineering: the call is hers, not the bot’s (which is on Engineering and holds no grant)', async () => {
    const res = await data(sameera, room, surface, 'cards');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(SurfaceDataResponse.parse(res.body).state).toBe('empty');
    expect(SurfaceDataResponse.parse((await data(sameera, room, surface, 'count')).body)).toMatchObject({ state: 'ok', props: { value: '0' } });
  });

  it('a search is the viewer’s too: Nadia finds the message, Sameera (who cannot read #dev) finds nothing', async () => {
    const mine = SurfaceDataResponse.parse((await data(nadia, room, surface, 'found')).body);
    expect(mine.state, JSON.stringify(mine)).toBe('ok');
    const theirs = SurfaceDataResponse.parse((await data(sameera, room, surface, 'found')).body);
    expect(theirs.state).toBe('empty');
  });

  it('the answer has the time it was read and no text of the tool beyond the chosen values', async () => {
    const res = (await data(nadia, room, surface, 'cards')).body as Record<string, unknown>;
    expect(typeof res['fetchedAt']).toBe('string');
    expect(JSON.stringify(res)).not.toContain('description');
    expect(JSON.stringify(res)).not.toContain('owner_id');
  });
});

describe('what a request can never do', () => {
  it('names no tool, arguments or field: the strict body has only the version', async () => {
    for (const body of [{ version: 1, tool: 'tasks.read' }, { version: 1, args: { taskId: 'x' } }, { version: 1, into: { rows: 'x' } }, {}, { version: 0 }]) {
      const res = await data(nadia, room, surface, 'cards', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('a part with no binding, a part that does not exist and a part the checker refused (a tool a screen may not bind) answer 404', async () => {
    expect((await data(nadia, room, surface, 'head')).status).toBe(404);
    expect((await data(nadia, room, surface, 'nope')).status).toBe(404);
    expect((await data(nadia, room, surface, 'evil')).status).toBe(404);
  });

  it('a stale version is 409 and a screen from another channel is 404', async () => {
    const stale = await data(nadia, room, surface, 'cards', { version: 7 });
    expect(stale.status).toBe(409);
    const other = await w.channelId('engineering', 'dev');
    expect((await data(nadia, other, surface, 'cards')).status).toBe(404);
  });

  it('a person who cannot read the channel gets 403 and nothing is read', async () => {
    const hidden = await drawn(privateRoom, SCREEN);
    const res = await data(nadia, privateRoom, hidden, 'cards');
    expect(res.status).toBe(403);
    expect((await data(rafi, room, surface, 'cards')).status).toBe(403);
  });

  it('a bot cannot use the route: only a person reads a screen’s data', async () => {
    const res = await fetch(`${w.server.url}/api/channels/${room}/surfaces/${surface}/data/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: botActor, workspaceId: WS }) },
      body: JSON.stringify({ version: 1 }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it('a screen whose source was changed to name a tool no screen may bind reads nothing (the checker refuses the part)', async () => {
    const bad = await drawn(room, 'root = Text("x", null, {tool: "tasks.create", args: {title: "hi"}, into: {text: "ok"}})\n');
    expect((await data(nadia, room, bad, 'root')).status).toBe(404);
  });
});

describe('the gateway’s door for a person’s read', () => {
  it('serves only a person: the system role and a bot are refused', async () => {
    const asSystem = await w.system((tx) => provider.readForViewer(tx as unknown as PluginTx, 'tasks.read', {}));
    expect(asSystem).toMatchObject({ ok: false, code: 'forbidden' });
    const asBot = await withActor({ kind: 'bot', id: botActor as never, workspaceId: WS as never }, (tx) => provider.readForViewer(tx as unknown as PluginTx, 'tasks.read', {}), { pool: appPool });
    expect(asBot).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('serves only the tools a screen may bind, with arguments of the right shape', async () => {
    for (const name of ['memory.recall', 'knowledge.search', 'inbox.read', 'tasks.create', 'surface.render', 'messages.post', 'nothing.here']) {
      expect(await asPerson(nadia, (tx) => provider.readForViewer(tx, name, {})), name).toMatchObject({ ok: false, code: 'not_bindable' });
    }
    expect(await asPerson(nadia, (tx) => provider.readForViewer(tx, 'tasks.read', { teamId: engineering }))).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(await asPerson(nadia, (tx) => provider.readForViewer(tx, 'messages.search', { query: 'x' }))).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(await asPerson(nadia, (tx) => provider.readForViewer(tx, 'messages.search', { query: 'cache decision', teamId: engineering }))).toMatchObject({ ok: false, code: 'invalid_args' });
  });

  it('reads in a transaction of its own, read only, as that person', async () => {
    const out = await asPerson(nadia, (tx) => provider.readForViewer(tx, 'tasks.read', {}));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const answer = out.data as { ok: boolean; you: string; tasks: unknown[] };
    expect(answer.tasks).toHaveLength(2);
    // the "(you)" label is the reader's: it is Nadia's actor, not a bot's
    expect(answer.you).toContain('(you)');
    expect(JSON.stringify(out.data).length).toBeLessThan(SURFACE_BIND_RESULT_MAX_CHARS);
  });

  it('the route gives up on the pool cleanly when asked too often by one person at once', async () => {
    resetDataCalls();
    const many = await Promise.all(Array.from({ length: 12 }, () => data(nadia, room, surface, 'cards')));
    for (const r of many) expect([200, 429]).toContain(r.status);
    expect(many.some((r) => r.status === 200)).toBe(true);
    resetDataCalls();
  });
});
