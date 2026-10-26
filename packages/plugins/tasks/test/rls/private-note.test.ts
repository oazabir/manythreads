import { randomUUID } from 'node:crypto';
import { withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, personas, personaActor, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A handover's private note (migration 0007): sealed in app.secrets, linked from the handover row, readable (as a secret id) only by the bot
// the latest handover gave the card to, while it still owns the card. The text itself is never in a table the app role can read.

const { nadia } = personas;
const WS = KAHF_WORKSPACE_ID;
const ENG = TEAM_IDS.Engineering;

let server: TestServer;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: server.pools.system, workspaceId: WS });
const asBot = <T>(actor: string, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor({ kind: 'bot', id: actor, workspaceId: WS } as Actor, fn, { pool: server.pools.app });

const makeBot = (slug: string): Promise<string> =>
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
    return actor;
  });

let a = '';
let b = '';
let c = '';
let card = '';
let secret = '';
let handoffToB = '';

const handoff = (from: string, to: string, task: string): Promise<string> =>
  asBot(from, async (tx) => (await tx.query<{ o_handoff_id: string }>('SELECT * FROM app.tasks_handoff($1::uuid, $2::uuid, $3, $4, NULL)', [task, to, 'bot', 'note'])).rows[0]!.o_handoff_id);
const secretFor = (actor: Actor, task: string): Promise<string | null> =>
  withActor(actor, async (tx) => (await tx.query<{ id: string | null }>('SELECT app.tasks_private_note_secret($1::uuid) AS id', [task])).rows[0]!.id, { pool: server.pools.app });
const seal = (forActor: string, ticket = true): Promise<string> =>
  sys(async (tx) => {
    const id = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
    await tx.query('SELECT app.put_secret($1, $2, $3, $4)', [id, Buffer.from('sealed'), Buffer.from('wrapped'), 'test']);
    if (ticket) await tx.query('SELECT app.tasks_ticket_private_note($1::uuid, $2::uuid)', [id, forActor]);
    return id;
  });
const attach = (actor: string, handoffId: string, secretId: string): Promise<boolean> =>
  asBot(actor, async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.tasks_set_private_note($1::uuid, $2::uuid) AS ok', [handoffId, secretId])).rows[0]!.ok);
const botActor = (id: string): Actor => ({ kind: 'bot', id, workspaceId: WS }) as Actor;

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  [a, b, c] = [await makeBot(`pn-a-${randomUUID().slice(0, 6)}`), await makeBot(`pn-b-${randomUUID().slice(0, 6)}`), await makeBot(`pn-c-${randomUUID().slice(0, 6)}`)];
  card = await sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.tasks (workspace_id, team_id, title, branch, created_by, owner_id, state) VALUES ($1, $2, 'pn card', $3, $4, $4, 'in_progress') RETURNING id`,
          [WS, ENG, `pn/${randomUUID().slice(0, 8)}`, a],
        )
      ).rows[0]!.id,
  );
  handoffToB = await handoff(a, b, card);
  secret = await seal(a);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('private note on a handover', () => {
  it('only the giver can attach a secret, and only once', async () => {
    expect(await asBot(b, async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.tasks_set_private_note($1::uuid, $2::uuid) AS ok', [handoffToB, secret])).rows[0]!.ok)).toBe(false);
    expect(await asBot(a, async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.tasks_set_private_note($1::uuid, $2::uuid) AS ok', [handoffToB, secret])).rows[0]!.ok)).toBe(true);
    expect(await asBot(a, async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.tasks_set_private_note($1::uuid, $2::uuid) AS ok', [handoffToB, secret])).rows[0]!.ok)).toBe(false);
  });

  it('refuses a secret that was not sealed for the caller through the tasks door (any other secret of the workspace)', async () => {
    const stray = await seal(a, false);
    const forB = await seal(b);
    const h = await sys(async (tx) => (await tx.query<{ id: string }>(`INSERT INTO app.handoffs (task_id, team_id, from_actor_id, to_actor_id, mode, note, applied_at) VALUES ($1, $2, $3, $4, 'bot', '', now()) RETURNING id`, [card, ENG, a, b])).rows[0]!.id);
    expect(await attach(a, h, stray)).toBe(false);
    expect(await attach(a, h, forB)).toBe(false);
    await sys((tx) => tx.query('DELETE FROM app.handoffs WHERE id = $1', [h]));
  });

  it('the recipient reads the secret id; another bot, the giver and a person get nothing', async () => {
    expect(await secretFor(botActor(b), card)).toBe(secret);
    expect(await secretFor(botActor(c), card)).toBeNull();
    expect(await secretFor(botActor(a), card)).toBeNull();
    expect(await secretFor(personaActor(nadia), card)).toBeNull();
  });

  it('a plain SELECT on the secret store, as the app role, returns nothing readable', async () => {
    const outcome = await withActor(botActor(b), async (tx) => tx.query('SELECT * FROM app.secrets WHERE id = $1', [secret]).then((r) => r.rows.length, () => 'denied'), { pool: server.pools.app }).catch(() => 'denied');
    expect([0, 'denied']).toContain(outcome);
  });

  it('after the card moves on, the old recipient reads nothing, and the new owner has no note unless it was given one', async () => {
    await handoff(b, c, card);
    expect(await secretFor(botActor(b), card)).toBeNull();
    expect(await secretFor(botActor(c), card)).toBeNull();
  });

  it('only the newest handover counts: a later handover without a note hides the earlier note, even when it returns to the same bot', async () => {
    const card2 = await sys(async (tx) => (await tx.query<{ id: string }>(`INSERT INTO app.tasks (workspace_id, team_id, title, branch, created_by, owner_id, state) VALUES ($1, $2, 'pn2', $3, $4, $4, 'in_progress') RETURNING id`, [WS, ENG, `pn/${randomUUID().slice(0, 8)}`, a])).rows[0]!.id);
    const h1 = await handoff(a, b, card2);
    expect(await attach(a, h1, await seal(a))).toBe(true);
    expect(await secretFor(botActor(b), card2)).not.toBeNull();
    await handoff(b, c, card2);
    await handoff(c, b, card2);
    expect(await secretFor(botActor(b), card2)).toBeNull();
  });

  it('a done card gives no note, its notes are deleted, and the sweep removes old notes and unused tickets', async () => {
    const card3 = await sys(async (tx) => (await tx.query<{ id: string }>(`INSERT INTO app.tasks (workspace_id, team_id, title, branch, created_by, owner_id, state, kind) VALUES ($1, $2, 'pn3', $3, $4, $4, 'in_progress', 'other') RETURNING id`, [WS, ENG, `pn/${randomUUID().slice(0, 8)}`, a])).rows[0]!.id);
    const h = await handoff(a, b, card3);
    const s = await seal(a);
    expect(await attach(a, h, s)).toBe(true);
    // not done: the drop door does nothing
    expect(await asBot(b, async (tx) => (await tx.query<{ n: number }>('SELECT app.tasks_drop_private_notes($1::uuid) AS n', [card3])).rows[0]!.n)).toBe(0);
    await sys((tx) => tx.query(`UPDATE app.tasks SET state = 'done', completed_at = now() WHERE id = $1`, [card3]));
    expect(await secretFor(botActor(b), card3)).toBeNull();
    expect(await asBot(b, async (tx) => (await tx.query<{ n: number }>('SELECT app.tasks_drop_private_notes($1::uuid) AS n', [card3])).rows[0]!.n)).toBe(1);
    const gone = await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.secrets WHERE id = $1', [s])).rows[0]!.n);
    expect(gone).toBe(0);
    // an old ticket nobody used, and a note older than the window
    const orphan = await seal(a);
    await sys((tx) => tx.query(`UPDATE app.handoff_secret_tickets SET created_at = now() - interval '2 hours' WHERE secret_id = $1`, [orphan]));
    const card4 = await sys(async (tx) => (await tx.query<{ id: string }>(`INSERT INTO app.tasks (workspace_id, team_id, title, branch, created_by, owner_id, state) VALUES ($1, $2, 'pn4', $3, $4, $4, 'in_progress') RETURNING id`, [WS, ENG, `pn/${randomUUID().slice(0, 8)}`, a])).rows[0]!.id);
    const h4 = await handoff(a, b, card4);
    const old = await seal(a);
    expect(await attach(a, h4, old)).toBe(true);
    await sys((tx) => tx.query(`UPDATE app.handoffs SET created_at = now() - interval '8 days' WHERE id = $1`, [h4]));
    const swept = await sys(async (tx) => (await tx.query<{ n: number }>('SELECT app.tasks_sweep_private_notes(7) AS n')).rows[0]!.n);
    expect(swept).toBeGreaterThanOrEqual(2);
    expect(await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.secrets WHERE id = ANY($1::uuid[])', [[orphan, old]])).rows[0]!.n)).toBe(0);
    // the sweep is not callable by the app role
    await expect(asBot(a, (tx) => tx.query('SELECT app.tasks_sweep_private_notes(7)'))).rejects.toThrow();
  });

  it('the handover row carries the secret id only, not any text', async () => {
    const row = await sys(async (tx) => (await tx.query<{ note: string; private_note_secret_id: string | null }>('SELECT note, private_note_secret_id FROM app.handoffs WHERE id = $1', [handoffToB])).rows[0]!);
    expect(row.private_note_secret_id).toBe(secret);
    expect(row.note).toBe('note');
  });
});
