import { createAppPool, createSystemPool, withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import {
  TEAM_IDS,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
  personaActor,
  personas,
  surfacesMigrationSource,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, sameera, lena } = personas;

// Who reads and writes what (pnpm test:rls): a surface is as visible as its channel; only its own bot draws or changes it, as itself, inside a run of its own;
// a person who can post beside it may pin or unpin it; the history is written once and never changed.

const WS = omar.workspaceId;
let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: WS });
const asBot = <T>(actorId: string, runId: string | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withActor({ kind: 'bot', id: actorId, workspaceId: WS, ...(runId ? { runId } : {}) } as Actor, fn, { pool: appPool });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const SOURCE = 'root = Heading("Sales", 1)\n';
let pub = '';
let priv = '';
let bot = { id: '', actor: '' };
let other = { id: '', actor: '' };
let run = '';
let otherRun = '';

const newChannel = (name: string, isPrivate: boolean, members: Persona[]): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>('INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [
        WS,
        TEAM_IDS.Engineering,
        name,
        'channel',
        isPrivate,
        omar.actorId,
      ])
    ).rows[0]!.id;
    for (const m of members) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });
const makeBot = async (tx: Tx, slug: string): Promise<{ id: string; actor: string }> => {
  const b = await tx.query<{ id: string }>(
    `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
     VALUES ($1, $2, $3, $3, '', 'agent', 'hermes', 'team', repeat('a', 64), 'active', '{"runner": "default"}') RETURNING id`,
    [WS, TEAM_IDS.Engineering, slug],
  );
  const a = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [WS, b.rows[0]!.id]);
  // a bot is a member of its team (as the loader makes it): it reads and posts in the team's public channels
  await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, a.rows[0]!.id, WS]);
  return { id: b.rows[0]!.id, actor: a.rows[0]!.id };
};
const newRun = (botId: string): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status) VALUES ($1, $2, $3, 'mention', 'running') RETURNING id`,
          [WS, botId, TEAM_IDS.Engineering],
        )
      ).rows[0]!.id,
  );
const draw = (b: { id: string; actor: string }, channel: string, runId: string | undefined = run, extra = ''): Promise<string> =>
  asBot(b.actor, runId, async (tx) =>
    (
      await tx.query<{ id: string }>(
        `INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by${extra ? ', ' + extra.split('=')[0] : ''})
         VALUES ($1, $2, $3, 'Sales', $4, $5${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`,
        [WS, channel, b.id, SOURCE, b.actor],
      )
    ).rows[0]!.id,
  );
const message = (channel: string, author: string): Promise<string> =>
  sys(async (tx) => (await tx.query<{ id: string }>('INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, $4, $4) RETURNING id', [WS, channel, author, 'hi'])).rows[0]!.id);
const history = (p: Persona, surface: string, kind: string, version = 1, nodeId: string | null = null, payload: unknown = {}): Promise<string> =>
  as(p, async (tx) =>
    (
      await tx.query<{ id: string }>(
        `INSERT INTO app.surface_events (surface_id, workspace_id, channel_id, actor_id, kind, version, node_id, payload)
         SELECT s.id, s.workspace_id, s.channel_id, $2, $3, $4, $5, $6::jsonb FROM app.surfaces s WHERE s.id = $1 RETURNING id`,
        [surface, p.actorId, kind, version, nodeId, JSON.stringify(payload)],
      )
    ).rows[0]!.id,
  );
const botHistory = (b: { actor: string }, surface: string, kind: string, version = 1): Promise<string> =>
  asBot(b.actor, run, async (tx) =>
    (
      await tx.query<{ id: string }>(
        `INSERT INTO app.surface_events (surface_id, workspace_id, channel_id, actor_id, kind, version)
         SELECT s.id, s.workspace_id, s.channel_id, $2, $3, $4 FROM app.surfaces s WHERE s.id = $1 RETURNING id`,
        [surface, b.actor, kind, version],
      )
    ).rows[0]!.id,
  );

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, surfacesMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  pub = await newChannel('surf-open', false, []);
  priv = await newChannel('surf-private', true, [nadia, rafi]);
  await sys(async (tx) => {
    bot = await makeBot(tx, 'surf-bot');
    other = await makeBot(tx, 'surf-other');
  });
  run = await newRun(bot.id);
  otherRun = await newRun(other.id);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the tables', () => {
  it('pass the RLS harness: forced RLS, a rls: comment, policies for every command, no grant beyond the policies', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

describe('drawing a surface', () => {
  it('the bot draws as itself, in a run of its own; the place, the author, the run and the version come from the database', async () => {
    const id = await draw(bot, pub);
    const [row] = await sys(async (tx) => (await tx.query<Record<string, unknown>>('SELECT * FROM app.surfaces WHERE id = $1', [id])).rows);
    expect(row).toMatchObject({ team_id: TEAM_IDS.Engineering, bot_id: bot.id, created_by: bot.actor, run_id: run, version: 1, pinned_channel_id: null, source: SOURCE });
  });
  it('a caller cannot choose the version, the author, the run or a pin of a new surface', async () => {
    const id = await asBot(bot.actor, run, async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by, version, run_id, pinned_channel_id, pinned_at, pinned_by)
           VALUES ($1, $2, $3, 'Sales', $4, $5, 9, $6, $2, now(), $5) RETURNING id`,
          [WS, pub, bot.id, SOURCE, bot.actor, otherRun],
        )
      ).rows[0]!.id,
    );
    const [row] = await sys(async (tx) => (await tx.query<Record<string, unknown>>('SELECT version, run_id, pinned_channel_id, pinned_at, pinned_by FROM app.surfaces WHERE id = $1', [id])).rows);
    expect(row).toMatchObject({ version: 1, run_id: run, pinned_channel_id: null, pinned_at: null, pinned_by: null });
  });
  it('is refused for a person, for a bot drawing as another bot, and for a bot that cannot post in the channel', async () => {
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by) VALUES ($1, $2, $3, 'x', $4, $5)`, [WS, pub, bot.id, SOURCE, nadia.actorId])))).toBe('42501');
    expect(await code(asBot(other.actor, otherRun, (tx) => tx.query(`INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by) VALUES ($1, $2, $3, 'x', $4, $5)`, [WS, pub, bot.id, SOURCE, other.actor])))).toBe('42501');
    // naming someone else as the author changes nothing: the database writes the caller's own actor
    const spoofed = await asBot(bot.actor, run, async (tx) => (await tx.query<{ created_by: string }>(`INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by) VALUES ($1, $2, $3, 'x', $4, $5) RETURNING created_by`, [WS, pub, bot.id, SOURCE, other.actor])).rows[0]!);
    expect(spoofed.created_by).toBe(bot.actor);
    // the private channel has no seat for a bot that is not in it
    expect(await code(draw(bot, priv))).toBe('42501');
  });
  it('a run of another bot is refused, and so is a thread that is not a message of the channel, a title with a line break and a source over the limit', async () => {
    expect(await code(draw(bot, pub, otherRun))).toBe('23514');
    const elsewhere = await message(await newChannel('surf-elsewhere', false, []), nadia.actorId);
    expect(await code(asBot(bot.actor, run, (tx) => tx.query(`INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by, thread_root_id) VALUES ($1, $2, $3, 'x', $4, $5, $6)`, [WS, pub, bot.id, SOURCE, bot.actor, elsewhere])))).toBe('23514');
    expect(await code(asBot(bot.actor, run, (tx) => tx.query(`INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by) VALUES ($1, $2, $3, E'a\\nb', $4, $5)`, [WS, pub, bot.id, SOURCE, bot.actor])))).toBe('23514');
    expect(await code(asBot(bot.actor, run, (tx) => tx.query(`INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by) VALUES ($1, $2, $3, 'x', repeat('a', 200001), $4)`, [WS, pub, bot.id, bot.actor])))).toBe('23514');
  });
  it('a surface can be drawn in the thread of a message of its channel', async () => {
    const root = await message(pub, nadia.actorId);
    const id = await draw(bot, pub, run, `thread_root_id='${root}'`);
    const [row] = await q<{ thread_root_id: string }>(nadia, 'SELECT thread_root_id FROM app.surfaces WHERE id = $1', [id]);
    expect(row?.thread_root_id).toBe(root);
  });
});

describe('who sees a surface', () => {
  it('whoever reads the channel; a private channel only to its members, an admin who is not a member included', async () => {
    const id = await sys(async (tx) => {
      const r = await tx.query<{ id: string }>(`INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by) VALUES ($1, $2, $3, 'Private', $4, $5) RETURNING id`, [WS, priv, bot.id, SOURCE, bot.actor]);
      return r.rows[0]!.id;
    });
    for (const member of [nadia, rafi]) expect((await q(member, 'SELECT 1 FROM app.surfaces WHERE id = $1', [id])).length, member.key).toBe(1);
    for (const outsider of [omar, sameera, lena]) expect((await q(outsider, 'SELECT 1 FROM app.surfaces WHERE id = $1', [id])).length, outsider.key).toBe(0);
    expect((await asBot(other.actor, undefined, async (tx) => (await tx.query('SELECT 1 FROM app.surfaces WHERE id = $1', [id])).rows)).length).toBe(0);
  });
  it('a surface of an open channel is read by the team, not by other teams or guests', async () => {
    const id = await draw(bot, pub);
    for (const reader of [nadia, rafi, omar]) expect((await q(reader, 'SELECT 1 FROM app.surfaces WHERE id = $1', [id])).length, reader.key).toBe(1);
    for (const outsider of [sameera, lena]) expect((await q(outsider, 'SELECT 1 FROM app.surfaces WHERE id = $1', [id])).length, outsider.key).toBe(0);
    expect((await asBot(other.actor, undefined, async (tx) => (await tx.query('SELECT 1 FROM app.surfaces WHERE id = $1', [id])).rows)).length).toBe(1);
  });
});

describe('changing a surface', () => {
  let id = '';
  beforeAll(async () => {
    id = await draw(bot, pub);
  });
  it('the bot changes the source: the version goes up by one, nobody chooses it', async () => {
    await asBot(bot.actor, run, (tx) => tx.query(`UPDATE app.surfaces SET source = 'root = Text("two")', version = 40 WHERE id = $1`, [id]));
    await asBot(bot.actor, run, (tx) => tx.query(`UPDATE app.surfaces SET title = 'Renamed' WHERE id = $1`, [id]));
    const [row] = await sys(async (tx) => (await tx.query<{ version: number; title: string; source: string }>('SELECT version, title, source FROM app.surfaces WHERE id = $1', [id])).rows);
    expect(row).toMatchObject({ version: 2, title: 'Renamed', source: 'root = Text("two")' });
  });
  it('another bot, a person and a guest cannot change the source; the place and the author never change', async () => {
    expect(await code(asBot(other.actor, otherRun, (tx) => tx.query(`UPDATE app.surfaces SET source = 'x' WHERE id = $1`, [id])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.surfaces SET source = 'root = Text("mine")' WHERE id = $1`, [id])))).toBe('23514');
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.surfaces SET title = 'mine' WHERE id = $1`, [id])))).toBe('23514');
    expect(await code(as(lena, (tx) => tx.query(`UPDATE app.surfaces SET title = 'mine' WHERE id = $1`, [id])))).toBeUndefined();
    expect((await sys(async (tx) => (await tx.query<{ title: string }>('SELECT title FROM app.surfaces WHERE id = $1', [id])).rows))[0]?.title).toBe('Renamed');
    expect(await code(asBot(bot.actor, run, (tx) => tx.query(`UPDATE app.surfaces SET channel_id = $2 WHERE id = $1`, [id, priv])))).toBe('23514');
    expect(await code(asBot(bot.actor, run, (tx) => tx.query(`UPDATE app.surfaces SET bot_id = $2 WHERE id = $1`, [id, other.id])))).toBe('23514');
    expect(await code(asBot(bot.actor, run, (tx) => tx.query(`UPDATE app.surfaces SET created_by = $2 WHERE id = $1`, [id, other.actor])))).toBe('23514');
  });
  it('the bot does not pin its own surface', async () => {
    expect(await code(asBot(bot.actor, run, (tx) => tx.query(`UPDATE app.surfaces SET pinned_channel_id = channel_id, pinned_at = now() WHERE id = $1`, [id])))).toBe('23514');
  });
  it('nobody deletes one from the app role', async () => {
    expect(await code(asBot(bot.actor, run, (tx) => tx.query('DELETE FROM app.surfaces WHERE id = $1', [id])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('DELETE FROM app.surfaces WHERE id = $1', [id])))).toBe('42501');
    expect((await sys(async (tx) => (await tx.query('SELECT 1 FROM app.surfaces WHERE id = $1', [id])).rows)).length).toBe(1);
  });
});

describe('pinning', () => {
  let id = '';
  beforeAll(async () => {
    id = await draw(bot, pub);
  });
  it('a person who can post in the channel pins it, as themself, and unpins it', async () => {
    await as(nadia, (tx) => tx.query('UPDATE app.surfaces SET pinned_channel_id = channel_id, pinned_by = $2 WHERE id = $1', [id, rafi.actorId]));
    const [pinned] = await sys(async (tx) => (await tx.query<{ pinned_by: string; pinned_channel_id: string; pinned_at: Date; version: number }>('SELECT pinned_by, pinned_channel_id, pinned_at, version FROM app.surfaces WHERE id = $1', [id])).rows);
    expect(pinned).toMatchObject({ pinned_by: nadia.actorId, pinned_channel_id: pub, version: 1 });
    expect(pinned?.pinned_at).toBeInstanceOf(Date);
    await as(rafi, (tx) => tx.query('UPDATE app.surfaces SET pinned_channel_id = NULL WHERE id = $1', [id]));
    const [unpinned] = await sys(async (tx) => (await tx.query<Record<string, unknown>>('SELECT pinned_by, pinned_channel_id, pinned_at FROM app.surfaces WHERE id = $1', [id])).rows);
    expect(unpinned).toEqual({ pinned_by: null, pinned_channel_id: null, pinned_at: null });
  });
  it('only to its own channel: pinning elsewhere would widen who reads it', async () => {
    const elsewhere = await newChannel('surf-other-pin', false, []);
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.surfaces SET pinned_channel_id = $2, pinned_at = now() WHERE id = $1', [id, elsewhere])))).toBe('23514');
  });
  it('a guest, a person of another team and a bot cannot pin', async () => {
    for (const p of [lena, sameera]) {
      await as(p, (tx) => tx.query('UPDATE app.surfaces SET pinned_channel_id = channel_id WHERE id = $1', [id]));
      expect((await sys(async (tx) => (await tx.query<{ pinned_channel_id: string | null }>('SELECT pinned_channel_id FROM app.surfaces WHERE id = $1', [id])).rows))[0]?.pinned_channel_id, p.key).toBeNull();
    }
    expect(await code(asBot(other.actor, otherRun, (tx) => tx.query('UPDATE app.surfaces SET pinned_channel_id = channel_id, pinned_at = now() WHERE id = $1', [id])))).toBe('42501');
  });
});

describe('the history of a surface', () => {
  let id = '';
  beforeAll(async () => {
    id = await draw(bot, pub);
  });
  it('the bot writes render, update and rejected lines for its own surface; a person writes event, pinned, unpinned and exported', async () => {
    for (const kind of ['render', 'update', 'rejected']) await botHistory(bot, id, kind);
    for (const kind of ['event', 'pinned', 'unpinned', 'exported']) await history(nadia, id, kind);
    const kinds = (await q<{ kind: string }>(rafi, 'SELECT kind FROM app.surface_events WHERE surface_id = $1 ORDER BY id', [id])).map((r) => r.kind);
    expect(kinds).toEqual(['render', 'update', 'rejected', 'event', 'pinned', 'unpinned', 'exported']);
  });
  it('a click carries the node and the form payload, and is read by whoever reads the surface', async () => {
    await history(rafi, id, 'event', 1, 'save_button', { values: { name: 'Q3' } });
    const rows = await q<{ node_id: string; payload: { values: { name: string } } }>(nadia, `SELECT node_id, payload FROM app.surface_events WHERE surface_id = $1 AND kind = 'event' AND node_id IS NOT NULL`, [id]);
    expect(rows).toEqual([{ node_id: 'save_button', payload: { values: { name: 'Q3' } } }]);
    expect((await q(sameera, 'SELECT 1 FROM app.surface_events WHERE surface_id = $1', [id])).length).toBe(0);
  });
  it('a person cannot write a bot line, a bot cannot write a person line, and nobody writes as someone else', async () => {
    expect(await code(history(nadia, id, 'render'))).toBe('42501');
    expect(await code(history(nadia, id, 'update'))).toBe('42501');
    expect(await code(botHistory(bot, id, 'event'))).toBe('42501');
    expect(await code(botHistory(other, id, 'render'))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.surface_events (surface_id, workspace_id, channel_id, actor_id, kind, version) SELECT id, workspace_id, channel_id, $2, 'event', 1 FROM app.surfaces WHERE id = $1`, [id, rafi.actorId])))).toBe('42501');
  });
  it('a person who cannot post in the channel writes nothing', async () => {
    // the guest cannot even see the surface, so there is no row to write a line about
    expect(await code(history(lena, id, 'event'))).toBeUndefined();
    expect((await sys(async (tx) => (await tx.query('SELECT 1 FROM app.surface_events WHERE surface_id = $1 AND actor_id = $2', [id, lena.actorId])).rows)).length).toBe(0);
    // a person of another team who can read nothing here is in the same position, and so is one who names the right row by id
    expect(await code(as(lena, (tx) => tx.query(`INSERT INTO app.surface_events (surface_id, workspace_id, channel_id, actor_id, kind, version) VALUES ($1, $2, $3, $4, 'event', 1)`, [id, WS, pub, lena.actorId])))).toBe('42501');
    expect((await q(lena, 'SELECT 1 FROM app.surface_events WHERE surface_id = $1', [id])).length).toBe(0);
  });
  it('a line cannot name a place other than its surface, or a version the surface has not reached', async () => {
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.surface_events (surface_id, workspace_id, channel_id, actor_id, kind, version) VALUES ($1, $2, $3, $4, 'event', 1)`, [id, WS, priv, nadia.actorId])))).toBe('23503');
    expect(await code(history(nadia, id, 'event', 2))).toBe('23514');
  });
  it('the payload is a JSON object of a bounded size, and the node name is bounded', async () => {
    expect(await code(history(nadia, id, 'event', 1, null, [1, 2]))).toBe('23514');
    expect(await code(history(nadia, id, 'event', 1, null, { big: 'x'.repeat(70_000) }))).toBe('23514');
    expect(await code(history(nadia, id, 'event', 1, 'n'.repeat(65)))).toBe('23514');
  });
  it('is append-only for the app role: no change, no delete', async () => {
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.surface_events SET payload = '{}' WHERE surface_id = $1`, [id])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('DELETE FROM app.surface_events WHERE surface_id = $1', [id])))).toBe('42501');
    expect((await q(nadia, 'SELECT 1 FROM app.surface_events WHERE surface_id = $1', [id])).length).toBeGreaterThan(0);
  });
  it('goes with the surface when the system role removes it', async () => {
    await sys((tx) => tx.query('DELETE FROM app.surfaces WHERE id = $1', [id]));
    expect((await sys(async (tx) => (await tx.query('SELECT 1 FROM app.surface_events WHERE surface_id = $1', [id])).rows)).length).toBe(0);
  });
});
