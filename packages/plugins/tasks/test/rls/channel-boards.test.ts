import { randomUUID } from 'node:crypto';
import { getOneOrCreate, withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { BOT_BOARD_NAME, ListTasksQuery } from '@manythreads/shared';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, personas, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerCapabilities } from '../../src/capabilities.ts';

// Boards that belong to a channel (migration 0009): who can read them, the `boards.ensure` tool that makes a channel's Bot Board once,
// the card a bot files on it without being told, and the board filter on the card list. The tools run against the real database through a
// small stand-in for the plugin context (the same kernel get-or-create, the audit events collected in a list).

const { nadia, rafi } = personas;
const WS = KAHF_WORKSPACE_ID;
const ENG = TEAM_IDS.Engineering;
const SUPPORT = TEAM_IDS['Customer support'];

let server: TestServer;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: server.pools.system, workspaceId: WS });
const asPerson = <T>(id: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withActor({ kind: 'person', id, workspaceId: WS } as Actor, fn, { pool: server.pools.app });
const asBot = <T>(actor: string, runId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withActor({ kind: 'bot', id: actor, workspaceId: WS, ...(runId ? { runId } : {}) } as Actor, fn, { pool: server.pools.app });

/** A tool answer: its fields are read loosely, the assertions name each one. */
type Out = { ok: boolean; code?: string; created?: boolean; path?: string; board: { id: string }; task: { boardId: string | null } };
type Handler = (input: Record<string, unknown>, tx: PluginTx) => Promise<Record<string, unknown>>;
const handlers = new Map<string, Handler>();
const events: Array<Record<string, unknown>> = [];

/** Run one tool as a bot, in its own transaction (so two calls can race). */
const tool = (name: string, actor: string, runId: string | null, input: Record<string, unknown>): Promise<Out> =>
  asBot(actor, runId, (tx) => handlers.get(name)!(input, tx as unknown as PluginTx)) as unknown as Promise<Out>;

async function channel(name: string, opts: { kind?: string; team?: string | null; archived?: boolean; privateTo?: string } = {}): Promise<string> {
  const kind = opts.kind ?? 'channel';
  const team = opts.team === undefined ? ENG : opts.team;
  return sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.channels (workspace_id, team_id, name, kind, private, dm_key, created_by, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [WS, team, name, kind, kind !== 'channel' || opts.privateTo !== undefined, kind === 'dm' ? randomUUID() : null, nadia.actorId, opts.archived ? new Date() : null],
      )
    ).rows[0]!.id;
    if (opts.privateTo) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, opts.privateTo]);
    return id;
  });
}
const COLS = JSON.stringify([{ state: 'open', title: 'Open' }, { state: 'done', title: 'Done' }]);
const uniq = (p: string): string => `${p}-${randomUUID().slice(0, 6)}`;

let botActor = '';
let botId = '';
async function makeBot(team: string): Promise<{ bot: string; actor: string }> {
  return sys(async (tx) => {
    const slug = uniq('cb');
    const bot = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
        [WS, team, slug],
      )
    ).rows[0]!.id;
    const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [WS, bot])).rows[0]!.id;
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [team, actor, WS]);
    return { bot, actor };
  });
}
const openRun = (bot: string, channelId: string): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, channel_id, status)
           VALUES ($1, $2, $3, 'mention', $4, $5, 'running') RETURNING id`,
          [WS, bot, ENG, nadia.actorId, channelId],
        )
      ).rows[0]!.id,
  );
const boardRows = (channelId: string) =>
  sys(async (tx) => (await tx.query<{ id: string; created_by: string }>('SELECT id, created_by FROM app.boards WHERE channel_id = $1', [channelId])).rows);

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  const ctx = {
    capabilities: { register: (n: string, fn: Handler) => handlers.set(n, fn) },
    db: { getOneOrCreate: (tx: PluginTx, input: never) => getOneOrCreate(tx as unknown as Tx, input) },
    audit: { emit: async (_tx: PluginTx, e: Record<string, unknown>) => void events.push(e) },
  } as unknown as PluginContext;
  registerCapabilities(ctx);
  const me = await makeBot(ENG);
  botActor = me.actor;
  botId = me.bot;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('boards.ensure', () => {
  it('makes the channel one Bot Board, also when two runs ask at the same moment', async () => {
    const ch = await channel(uniq('ens'));
    events.length = 0;
    const [a, b] = await Promise.all([tool('boards.ensure', botActor, null, { channelId: ch }), tool('boards.ensure', botActor, null, { channelId: ch })]);
    expect(a['ok'], JSON.stringify(a)).toBe(true);
    expect(b['ok'], JSON.stringify(b)).toBe(true);
    expect(a['board'].id).toBe(b['board'].id);
    expect([a['created'], b['created']].filter(Boolean)).toHaveLength(1);
    expect(await boardRows(ch)).toHaveLength(1);
    expect(a['board']).toMatchObject({ name: BOT_BOARD_NAME, channelId: ch, teamId: ENG });
    expect(a['path']).toMatch(new RegExp(`^/t/[a-z0-9-]+/boards\\?board=${a['board'].id}$`));
    expect(b['path']).toBe(a['path']);
    // one creation, one event, made by the bot
    const created = events.filter((e) => e['type'] === 'tasks.board.created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ boardId: a['board'].id, channelId: ch, creatorId: botActor });
    // asking again later returns the same board and writes no second event
    const again = await tool('boards.ensure', botActor, null, { channelId: ch });
    expect(again).toMatchObject({ ok: true, created: false });
    expect(again['board'].id).toBe(a['board'].id);
    expect(events.filter((e) => e['type'] === 'tasks.board.created')).toHaveLength(1);
  });

  it('uses the channel of the run when no channel is named', async () => {
    const ch = await channel(uniq('run'));
    const run = await openRun(botId, ch);
    const out = await tool('boards.ensure', botActor, run, {});
    expect(out).toMatchObject({ ok: true, board: { channelId: ch } });
    expect((await tool('boards.ensure', botActor, null, {}))['code']).toBe('invalid_input');
  });

  it('counts a person-made board of that name on the channel, but not a team board that is not attached', async () => {
    const team = await sys(async (tx) => {
      await tx.query("INSERT INTO app.boards (workspace_id, team_id, name, created_by) VALUES ($1, $2, $3, $4)", [WS, ENG, BOT_BOARD_NAME, nadia.actorId]);
      return true;
    });
    expect(team).toBe(true);
    const free = await channel(uniq('free'));
    const made = await tool('boards.ensure', botActor, null, { channelId: free });
    expect(made).toMatchObject({ ok: true, created: true });
    const mine = await channel(uniq('mine'));
    const personBoard = await sys(
      async (tx) =>
        (
          await tx.query<{ id: string }>('INSERT INTO app.boards (workspace_id, team_id, channel_id, name, created_by, columns) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id', [
            WS,
            ENG,
            mine,
            BOT_BOARD_NAME,
            nadia.actorId,
            COLS,
          ])
        ).rows[0]!.id,
    );
    const found = await tool('boards.ensure', botActor, null, { channelId: mine });
    expect(found).toMatchObject({ ok: true, created: false });
    expect(found['board'].id).toBe(personBoard);
  });

  it('refuses a direct message, an archived channel, another team\'s channel and a channel the bot cannot post in', async () => {
    for (const ch of [
      await channel(uniq('dm'), { kind: 'dm', team: null }),
      await channel(uniq('arch'), { archived: true }),
      await channel(uniq('sup'), { team: SUPPORT }),
      await channel(uniq('priv'), { privateTo: nadia.personId }),
    ]) {
      const out = await tool('boards.ensure', botActor, null, { channelId: ch });
      expect(out, ch).toMatchObject({ ok: false, code: 'not_found' });
      expect(await boardRows(ch)).toHaveLength(0);
    }
  });

  it('is not open to a person', async () => {
    const ch = await channel(uniq('person'));
    const out = await asPerson(nadia.actorId, (tx) => handlers.get('boards.ensure')!({ channelId: ch }, tx as unknown as PluginTx));
    expect(out).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

describe('a channel board is read like its channel', () => {
  it('hides the board from a person who cannot read the channel, in the table and through the route', async () => {
    const ch = await channel(uniq('secret'), { privateTo: nadia.personId });
    const board = await sys(
      async (tx) =>
        (
          await tx.query<{ id: string }>('INSERT INTO app.boards (workspace_id, team_id, channel_id, name, created_by, columns) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id', [
            WS,
            ENG,
            ch,
            BOT_BOARD_NAME,
            nadia.actorId,
            COLS,
          ])
        ).rows[0]!.id,
    );
    const seen = (id: string) => asPerson(id, async (tx) => (await tx.query('SELECT 1 FROM app.boards WHERE id = $1', [board])).rows.length);
    expect(await seen(nadia.actorId)).toBe(1);
    expect(await seen(rafi.actorId)).toBe(0);
    const get = async (who: typeof nadia) => {
      const res = await fetch(`${server.url}/api/channels/${ch}/boards`, {
        headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: WS }) },
      });
      const json = (await res.json()) as { items: Array<{ id: string }> };
      expect(res.status, JSON.stringify(json)).toBe(200);
      return json;
    };
    expect((await get(nadia)).items.map((b) => b.id)).toEqual([board]);
    expect((await get(rafi)).items).toEqual([]);
  });

  it('keeps a board on the team of its channel', async () => {
    const ch = await channel(uniq('team'), { team: SUPPORT });
    const bad = await sys((tx) =>
      tx.query('INSERT INTO app.boards (workspace_id, team_id, channel_id, name, created_by, columns) VALUES ($1, $2, $3, $4, $5, $6::jsonb)', [WS, ENG, ch, BOT_BOARD_NAME, nadia.actorId, COLS]).then(
        () => 'ok',
        () => 'refused',
      ),
    );
    expect(bad).toBe('refused');
  });
});

describe('tasks.create and the board', () => {
  it('files a bot\'s card on the Bot Board of the run\'s channel when it exists, and on none when it does not', async () => {
    const withBoard = await channel(uniq('wb'));
    const board = (await tool('boards.ensure', botActor, null, { channelId: withBoard }))['board'].id as string;
    const withoutBoard = await channel(uniq('nb'));
    const mk = (run: string | null, extra: Record<string, unknown> = {}) => tool('tasks.create', botActor, run, { title: 'A card', branch: `b/${uniq('x')}`, ...extra });
    const a = await mk(await openRun(botId, withBoard));
    expect(a, JSON.stringify(a)).toMatchObject({ ok: true, task: { boardId: board } });
    const b = await mk(await openRun(botId, withoutBoard));
    expect(b['task'].boardId).toBeNull();
    // no board is made by a card
    expect(await boardRows(withoutBoard)).toHaveLength(0);
    expect((await mk(null))['task'].boardId).toBeNull();
    // an explicit board wins over the default
    const other = (await tool('boards.ensure', botActor, null, { channelId: await channel(uniq('ob')) }))['board'].id as string;
    expect((await mk(await openRun(botId, withBoard), { boardId: other }))['task'].boardId).toBe(other);
  });

  it('refuses a board of another team, a board that is not there, and a board of a channel the bot cannot read', async () => {
    const foreign = await sys(
      async (tx) =>
        (await tx.query<{ id: string }>("INSERT INTO app.boards (workspace_id, team_id, name, created_by) VALUES ($1, $2, 'Support', $3) RETURNING id", [WS, SUPPORT, nadia.actorId])).rows[0]!.id,
    );
    const hidden = await sys(
      async (tx) => {
        const ch = await channel(uniq('hid'), { privateTo: nadia.personId });
        return (await tx.query<{ id: string }>('INSERT INTO app.boards (workspace_id, team_id, channel_id, name, created_by, columns) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id', [WS, ENG, ch, BOT_BOARD_NAME, nadia.actorId, COLS])).rows[0]!.id;
      },
    );
    for (const boardId of [foreign, randomUUID(), hidden]) {
      const out = await tool('tasks.create', botActor, null, { title: 'Nope', branch: 'b/nope', boardId });
      expect(out, boardId).toMatchObject({ ok: false, code: 'not_found' });
    }
  });

  it('lets a person file a card on a board of the team and refuses another team\'s, and the list filters by board', async () => {
    const ch = await channel(uniq('list'));
    const board = (await tool('boards.ensure', botActor, null, { channelId: ch }))['board'].id as string;
    const headers = { 'content-type': 'application/json', 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: nadia.actorId, workspaceId: WS }) };
    const post = (boardId: string) => fetch(`${server.url}/api/teams/engineering/tasks`, { method: 'POST', headers, body: JSON.stringify({ title: 'On board', branch: `p/${uniq('x')}`, boardId }) });
    const ok = await post(board);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { task: { boardId: string } }).task.boardId).toBe(board);
    const foreign = await sys(
      async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.boards (workspace_id, team_id, name, created_by) VALUES ($1, $2, 'S2', $3) RETURNING id", [WS, SUPPORT, nadia.actorId])).rows[0]!.id,
    );
    expect((await post(foreign)).status).toBe(404);
    await tool('tasks.create', botActor, null, { title: 'Off board', branch: `p/${uniq('y')}` });
    const list = await fetch(`${server.url}/api/teams/engineering/tasks?boardId=${board}`, { headers });
    const body = (await list.json()) as { items: Array<{ title: string; boardId: string }>; total: number };
    expect(body.items.map((t) => t.title)).toEqual(['On board']);
    expect(body.total).toBe(1);
    expect(ListTasksQuery.safeParse({ boardId: 'not-an-id' }).success).toBe(false);
  });
});
