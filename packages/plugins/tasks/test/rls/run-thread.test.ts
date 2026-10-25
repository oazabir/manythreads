import { randomUUID } from 'node:crypto';
import { withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, personas, personaActor, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A card a bot creates in a run is tied to the thread the run answers in (migration 0006). The door never raises: every refused case
// leaves the card without a thread. The checks below read the same conditions the runtime's wake-up (`cardThread`) applies to a card's root.

const { nadia } = personas;
const WS = KAHF_WORKSPACE_ID;
const ENG = TEAM_IDS.Engineering;
const SUPPORT = TEAM_IDS['Customer support'];

let server: TestServer;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: server.pools.system, workspaceId: WS });
const asBot = <T>(actor: string, runId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withActor({ kind: 'bot', id: actor, workspaceId: WS, ...(runId ? { runId } : {}) } as Actor, fn, { pool: server.pools.app });

let botActor = '';
let myBot = '';
let otherActor = '';
let rootMsg = '';
let replyMsg = '';
let otherTeamMsg = '';
let dmMsg = '';
let archivedMsg = '';

async function insertChannel(name: string, kind: string, team: string | null, extra = ''): Promise<string> {
  return sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.channels (workspace_id, team_id, name, kind, private, dm_key, created_by${extra ? ', archived_at' : ''})
           VALUES ($1, $2, $3, $4, $5, $6, $7${extra ? ', now()' : ''}) RETURNING id`,
          [WS, team, name, kind, kind !== 'channel', kind === 'dm' ? randomUUID() : null, nadia.actorId],
        )
      ).rows[0]!.id,
  );
}
const message = (channel: string, author: string, root: string | null = null): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, 'hi', 'hi', $4) RETURNING id`,
          [WS, channel, author, root],
        )
      ).rows[0]!.id,
  );
const makeBot = (slug: string): Promise<{ bot: string; actor: string }> =>
  sys(async (tx) => {
    const bot = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
        [WS, ENG, slug],
      )
    ).rows[0]!.id;
    const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [WS, bot])).rows[0]!.id;
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [ENG, actor, WS]);
    return { bot, actor };
  });
const openRun = (bot: string, rootId: string | null, channelId: string | null, status = 'running'): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, channel_id, reply_root_id, status${status === 'running' ? '' : ', ended_at'})
           VALUES ($1, $2, $3, 'mention', $4, $5, $6, $7${status === 'running' ? '' : ', now()'}) RETURNING id`,
          [WS, bot, ENG, nadia.actorId, channelId, rootId, status],
        )
      ).rows[0]!.id,
  );

/** Create a card as `actor` (inside `runId`) the way the tool does, then run the link door; return the card's thread root. */
const createAndLink = (actor: string, runId: string | null): Promise<string | null> =>
  asBot(actor, runId, async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        'SELECT id FROM app.tasks_create($1::uuid, $2::uuid, NULL, $3, $4, $5, $6, $7, NULL, $8::uuid)',
        [WS, ENG, 'Card', '', 'other', 'normal', `b/${randomUUID().slice(0, 8)}`, actor],
      )
    ).rows[0]!.id;
    await tx.query('SELECT app.tasks_link_run_thread($1::uuid)', [id]);
    return (await tx.query<{ thread_root_id: string | null }>('SELECT thread_root_id FROM app.tasks WHERE id = $1', [id])).rows[0]!.thread_root_id;
  });

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  const me = await makeBot(`runthread-${randomUUID().slice(0, 6)}`);
  botActor = me.actor;
  myBot = me.bot;
  otherActor = (await makeBot(`runthread-o-${randomUUID().slice(0, 6)}`)).actor;
  const ch = await insertChannel(`rt-${randomUUID().slice(0, 6)}`, 'channel', ENG);
  rootMsg = await message(ch, nadia.actorId);
  replyMsg = await message(ch, nadia.actorId, rootMsg);
  otherTeamMsg = await message(await insertChannel(`rt-s-${randomUUID().slice(0, 6)}`, 'channel', SUPPORT), nadia.actorId);
  dmMsg = await message(await insertChannel(`dm-${randomUUID().slice(0, 6)}`, 'dm', null), nadia.actorId);
  archivedMsg = await message(await insertChannel(`rt-a-${randomUUID().slice(0, 6)}`, 'channel', ENG, 'archived'), nadia.actorId);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('a card created in a run is tied to the run\'s thread', () => {
  it('links every card of the run to the thread root, also when the run answers under a reply', async () => {
    const run = await openRun(myBot, rootMsg, null);
    expect(await createAndLink(botActor, run)).toBe(rootMsg);
    expect(await createAndLink(botActor, run)).toBe(rootMsg);
    const underReply = await openRun(myBot, replyMsg, null);
    expect(await createAndLink(botActor, underReply)).toBe(rootMsg);
    // the root satisfies what the runtime's wake-up needs: a top-level, live message in an open channel of the team
    const ok = await sys(
      async (tx) =>
        (
          await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM app.messages m JOIN app.channels c ON c.id = m.channel_id
              WHERE m.id = $1 AND m.thread_root_id IS NULL AND m.deleted_at IS NULL AND c.team_id = $2 AND c.kind = 'channel' AND c.archived_at IS NULL`,
            [rootMsg, ENG],
          )
        ).rows[0]!.n,
    );
    expect(ok).toBe(1);
  });

  it('leaves the card without a thread for a DM, another team\'s channel, an archived channel, a finished run, no run, or no reply place', async () => {
    for (const msg of [dmMsg, otherTeamMsg, archivedMsg]) {
      expect(await createAndLink(botActor, await openRun(myBot, msg, null)), msg).toBeNull();
    }
    expect(await createAndLink(botActor, await openRun(myBot, rootMsg, null, 'done'))).toBeNull();
    expect(await createAndLink(botActor, null)).toBeNull();
    expect(await createAndLink(botActor, await openRun(myBot, null, null))).toBeNull();
  });

  it('does not link a run of another bot, or a card someone else created', async () => {
    const run = await openRun(myBot, rootMsg, null);
    // another bot's actor under this run: the run is not its own
    expect(await createAndLink(otherActor, run)).toBeNull();
    // a card made by a person, linked by the bot inside its run: not the bot's card
    const personCard = await withActor(personaActor(nadia), async (tx) =>
      (await tx.query<{ id: string }>('SELECT id FROM app.tasks_create($1::uuid, $2::uuid, NULL, $3, $4, $5, $6, $7, NULL, $8::uuid)', [WS, ENG, 'P', '', 'other', 'normal', `p/${randomUUID().slice(0, 8)}`, nadia.actorId])).rows[0]!.id,
    { pool: server.pools.app });
    await asBot(botActor, run, (tx) => tx.query('SELECT app.tasks_link_run_thread($1::uuid)', [personCard]));
    const root = await sys(async (tx) => (await tx.query<{ thread_root_id: string | null }>('SELECT thread_root_id FROM app.tasks WHERE id = $1', [personCard])).rows[0]!.thread_root_id);
    expect(root).toBeNull();
  });
});
